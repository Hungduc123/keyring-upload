import { NextResponse } from "next/server";
import { isFaqItem, type FaqItem } from "@/lib/upstash";
import { requireProjectAccess } from "@/lib/session";
import { diffStatus, fetchAllStored, makeId, type DiffStatus } from "@/lib/faq-diff";

export const runtime = "nodejs";

const MAX_ITEMS = 5000;

type EntryStatus = DiffStatus | "duplicate" | "invalid" | "removed";

type DiffEntry = {
  index: number;
  id: string;
  status: EntryStatus;
  question: string;
  answer: string;
  /** Answer currently stored in the index, when the pair already exists. */
  previousAnswer: string | null;
  message?: string;
};

type PreviewResponse = {
  total: number;
  counts: Record<EntryStatus, number>;
  entries: DiffEntry[];
};

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectRaw =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { project?: unknown }).project
      : undefined;
  const access = await requireProjectAccess(projectRaw);
  if ("response" in access) return access.response;
  const project = access.project;

  // Mirrors the upload route: only a replaceAll upload prunes, so only then
  // does the diff show rows as "will be deleted".
  const replaceAll =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { replaceAll?: unknown }).replaceAll === true
      : false;

  const rawItems = Array.isArray(body)
    ? body
    : Array.isArray((body as { items?: unknown })?.items)
      ? (body as { items: unknown[] }).items
      : null;

  if (!rawItems) {
    return NextResponse.json(
      { error: "Body must be an array or { items: [] }" },
      { status: 400 },
    );
  }
  if (rawItems.length === 0) {
    return NextResponse.json({ error: "No items provided" }, { status: 400 });
  }
  if (rawItems.length > MAX_ITEMS) {
    return NextResponse.json(
      { error: `Too many items. Max ${MAX_ITEMS} per request.` },
      { status: 413 },
    );
  }

  const entries: DiffEntry[] = [];
  const valid: { item: FaqItem; id: string; index: number }[] = [];

  rawItems.forEach((raw, index) => {
    if (!isFaqItem(raw)) {
      entries.push({
        index,
        id: "",
        status: "invalid",
        question: "",
        answer: "",
        previousAnswer: null,
        message: "Item must have string `question` and `answer`",
      });
      return;
    }
    const item: FaqItem = {
      question: raw.question.trim(),
      answer: raw.answer.trim(),
    };
    if (!item.question || !item.answer) {
      entries.push({
        index,
        id: "",
        status: "invalid",
        question: item.question,
        answer: item.answer,
        previousAnswer: null,
        message: "`question` and `answer` must not be empty",
      });
      return;
    }
    valid.push({ item, id: makeId(item), index });
  });

  // Only the last occurrence of a question is actually upserted; mark earlier
  // ones as duplicates so the preview matches what upload will do.
  const lastIndexById = new Map<string, number>();
  for (const v of valid) lastIndexById.set(v.id, v.index);

  const existing = new Map<string, { question: string; answer: string }>();
  // Anything stored but absent from the file will be pruned on a replaceAll
  // upload. Manual entry only adds and updates, so nothing is listed removed.
  const removed: DiffEntry[] = [];
  try {
    for (const entry of await fetchAllStored(project)) {
      existing.set(entry.id, {
        question: entry.question,
        answer: entry.answer,
      });
      if (replaceAll && !lastIndexById.has(entry.id)) {
        removed.push({
          index: -1,
          id: entry.id,
          status: "removed",
          question: entry.question,
          answer: entry.answer,
          previousAnswer: null,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Could not read existing items: ${message}` },
      { status: 502 },
    );
  }

  for (const { item, id, index } of valid) {
    const prev = existing.get(id);
    const isDuplicate = lastIndexById.get(id) !== index;
    entries.push({
      index,
      id,
      status: isDuplicate ? "duplicate" : diffStatus(item, prev),
      question: item.question,
      answer: item.answer,
      previousAnswer: prev ? prev.answer : null,
    });
  }

  entries.sort((a, b) => a.index - b.index);
  // Removed rows have no place in the file, so they trail the file's own rows.
  entries.push(...removed);

  const counts: Record<EntryStatus, number> = {
    new: 0,
    changed: 0,
    unchanged: 0,
    duplicate: 0,
    invalid: 0,
    removed: 0,
  };
  for (const e of entries) counts[e.status] += 1;

  const res: PreviewResponse = {
    total: rawItems.length,
    counts,
    entries,
  };
  return NextResponse.json(res);
}
