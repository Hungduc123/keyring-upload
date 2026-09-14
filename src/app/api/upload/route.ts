import { NextResponse } from "next/server";
import { getVectorIndex, isFaqItem, type FaqItem } from "@/lib/upstash";
import { requireProjectAccess } from "@/lib/session";
import {
  buildEmbeddingText,
  chunk,
  diffStatus,
  fetchAllStored,
  makeId,
} from "@/lib/faq-diff";

export const runtime = "nodejs";

const BATCH_SIZE = 50;
const DELETE_BATCH_SIZE = 100;
const MAX_ITEMS = 5000;

type UpsertResult = {
  total: number;
  upserted: number;
  skipped: number;
  duplicates: number;
  failed: number;
  /** Records pruned because a replaceAll upload no longer contains them. */
  deleted: number;
  ids: string[];
  skippedIds: string[];
  deletedIds: string[];
  errors: { index: number; message: string }[];
};

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const projectRaw =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { project?: unknown }).project
      : undefined;
  const access = await requireProjectAccess(projectRaw);
  if ("response" in access) return access.response;
  const project = access.project;

  // Pruning is opt-in: only a full-file upload replaces the index. Manual
  // entry sends a partial list, so it must never delete what it omits.
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

  const result: UpsertResult = {
    total: rawItems.length,
    upserted: 0,
    skipped: 0,
    duplicates: 0,
    failed: 0,
    deleted: 0,
    ids: [],
    skippedIds: [],
    deletedIds: [],
    errors: [],
  };

  const valid: { item: FaqItem; index: number }[] = [];
  rawItems.forEach((raw, index) => {
    if (!isFaqItem(raw)) {
      result.failed += 1;
      result.errors.push({
        index,
        message: "Item must have string `question` and `answer`",
      });
      return;
    }
    const cleaned: FaqItem = {
      question: raw.question.trim(),
      answer: raw.answer.trim(),
    };
    if (!cleaned.question || !cleaned.answer) {
      result.failed += 1;
      result.errors.push({
        index,
        message: "`question` and `answer` must not be empty",
      });
      return;
    }
    valid.push({ item: cleaned, index });
  });

  if (valid.length === 0) {
    return NextResponse.json(result, { status: 400 });
  }

  let vectorIndex;
  try {
    vectorIndex = getVectorIndex(project);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Collapse duplicates inside the payload itself: the last occurrence of a
  // question wins, mirroring what a sequential upsert would leave behind.
  const byId = new Map<string, FaqItem>();
  for (const { item } of valid) {
    const id = makeId(item);
    if (byId.has(id)) result.duplicates += 1;
    byId.set(id, item);
  }

  // Read the whole index so identical pairs are not re-sent. When replaceAll
  // is set, anything the file no longer mentions is also pruned so the file
  // stays the source of truth.
  const existing = new Map<string, { question: string; answer: string }>();
  const staleIds: string[] = [];
  try {
    for (const entry of await fetchAllStored(project)) {
      existing.set(entry.id, {
        question: entry.question,
        answer: entry.answer,
      });
      if (replaceAll && !byId.has(entry.id)) staleIds.push(entry.id);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Could not read existing items: ${message}` },
      { status: 502 },
    );
  }

  const records: {
    id: string;
    data: string;
    metadata: { question: string; answer: string; uploadedAt: string };
  }[] = [];

  for (const [id, item] of byId) {
    // Identical question AND answer: nothing changed, skip the upsert.
    if (diffStatus(item, existing.get(id)) === "unchanged") {
      result.skipped += 1;
      result.skippedIds.push(id);
      continue;
    }
    records.push({
      id,
      data: buildEmbeddingText(item),
      metadata: {
        question: item.question,
        answer: item.answer,
        uploadedAt: new Date().toISOString(),
      },
    });
  }

  for (const batch of chunk(records, BATCH_SIZE)) {
    try {
      await vectorIndex.upsert(batch);
      result.upserted += batch.length;
      result.ids.push(...batch.map((r) => r.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      result.failed += batch.length;
      result.errors.push({ index: -1, message: `Batch failed: ${message}` });
    }
  }

  // Only prune once the new content is safely in, so a failed upsert never
  // leaves the index emptier than it started.
  if (result.failed === 0) {
    for (const batch of chunk(staleIds, DELETE_BATCH_SIZE)) {
      try {
        await vectorIndex.delete({ ids: batch });
        result.deleted += batch.length;
        result.deletedIds.push(...batch);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        result.errors.push({
          index: -1,
          message: `Delete failed: ${message}`,
        });
      }
    }
  } else if (staleIds.length > 0) {
    result.errors.push({
      index: -1,
      message: `Skipped deleting ${staleIds.length} stale item(s) because some upserts failed.`,
    });
  }

  const status =
    result.failed > 0 && result.upserted === 0 && result.skipped === 0
      ? 502
      : 200;
  return NextResponse.json(result, { status });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const access = await requireProjectAccess(url.searchParams.get("project"));
  if ("response" in access) return access.response;
  const project = access.project;

  try {
    const info = await getVectorIndex(project).info();
    return NextResponse.json(info);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
