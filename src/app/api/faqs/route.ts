import { NextResponse } from "next/server";
import {
  DEFAULT_PROJECT,
  getVectorIndex,
  isFaqItem,
  isProjectKey,
  type ProjectKey,
} from "@/lib/upstash";
import { buildEmbeddingText, makeId } from "@/lib/faq-diff";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_DELETE_IDS = 500;

type StoredFaq = {
  id: string;
  question: string;
  answer: string;
  uploadedAt: string | null;
};

function resolveProject(
  raw: unknown,
): { project: ProjectKey } | { error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { project: DEFAULT_PROJECT };
  }
  if (!isProjectKey(raw)) {
    return { error: `Unknown project "${String(raw)}"` };
  }
  return { project: raw };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  const resolved = resolveProject(url.searchParams.get("project"));
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }

  const cursor = url.searchParams.get("cursor") ?? "0";

  const limitRaw = url.searchParams.get("limit");
  const limitNum = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > MAX_LIMIT) {
    return NextResponse.json(
      { error: `\`limit\` must be an integer between 1 and ${MAX_LIMIT}` },
      { status: 400 },
    );
  }

  try {
    const res = await getVectorIndex(resolved.project).range({
      cursor,
      limit: limitNum,
      includeMetadata: true,
    });

    const items: StoredFaq[] = res.vectors.map((v) => {
      const meta = (v.metadata ?? {}) as Record<string, unknown>;
      return {
        id: String(v.id),
        question: asString(meta.question),
        answer: asString(meta.answer),
        uploadedAt:
          typeof meta.uploadedAt === "string" ? meta.uploadedAt : null,
      };
    });

    return NextResponse.json({
      items,
      nextCursor: res.nextCursor || null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Body must be an object" },
      { status: 400 },
    );
  }

  const {
    project: projectRaw,
    id: idRaw,
    question: questionRaw,
    answer: answerRaw,
  } = body as {
    project?: unknown;
    id?: unknown;
    question?: unknown;
    answer?: unknown;
  };

  const resolved = resolveProject(projectRaw);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }

  if (typeof idRaw !== "string" || !idRaw.trim()) {
    return NextResponse.json(
      { error: "`id` must be a non-empty string" },
      { status: 400 },
    );
  }

  if (!isFaqItem({ question: questionRaw, answer: answerRaw })) {
    return NextResponse.json(
      { error: "`question` and `answer` must be strings" },
      { status: 400 },
    );
  }

  const question = (questionRaw as string).trim();
  const answer = (answerRaw as string).trim();
  if (!question || !answer) {
    return NextResponse.json(
      { error: "`question` and `answer` must not be empty" },
      { status: 400 },
    );
  }

  const oldId = idRaw;
  // The id is derived from the question, so editing the question moves the
  // record to a new id. Write the new one first, then drop the stale one.
  const newId = makeId({ question, answer });

  const index = getVectorIndex(resolved.project);

  try {
    if (newId !== oldId) {
      const clash = await index.fetch([newId], { includeMetadata: true });
      if (clash[0]) {
        return NextResponse.json(
          {
            error:
              "Another entry already uses this question. Edit or delete that one instead.",
          },
          { status: 409 },
        );
      }
    }

    await index.upsert({
      id: newId,
      data: buildEmbeddingText({ question, answer }),
      metadata: {
        question,
        answer,
        uploadedAt: new Date().toISOString(),
      },
    });

    if (newId !== oldId) {
      await index.delete({ ids: [oldId] });
    }

    return NextResponse.json({
      id: newId,
      previousId: oldId,
      question,
      answer,
      idChanged: newId !== oldId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Body must be an object" },
      { status: 400 },
    );
  }

  const { project: projectRaw, ids: idsRaw } = body as {
    project?: unknown;
    ids?: unknown;
  };

  const resolved = resolveProject(projectRaw);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }

  if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
    return NextResponse.json(
      { error: "`ids` must be a non-empty array" },
      { status: 400 },
    );
  }

  if (idsRaw.length > MAX_DELETE_IDS) {
    return NextResponse.json(
      { error: `Too many ids. Max ${MAX_DELETE_IDS} per request.` },
      { status: 413 },
    );
  }

  const ids: string[] = [];
  for (const id of idsRaw) {
    if (typeof id !== "string" || !id.trim()) {
      return NextResponse.json(
        { error: "Every id must be a non-empty string" },
        { status: 400 },
      );
    }
    ids.push(id);
  }

  try {
    const res = await getVectorIndex(resolved.project).delete({ ids });
    return NextResponse.json({ deleted: res.deleted, ids });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
