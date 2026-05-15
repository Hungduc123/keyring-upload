import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { isFaqItem, vectorIndex, type FaqItem } from "@/lib/upstash";

export const runtime = "nodejs";

const BATCH_SIZE = 50;
const MAX_ITEMS = 5000;

type UpsertResult = {
  total: number;
  upserted: number;
  failed: number;
  ids: string[];
  errors: { index: number; message: string }[];
};

function makeId(item: FaqItem, index: number): string {
  const hash = createHash("sha1")
    .update(item.question.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `faq_${hash}_${index}`;
}

function buildEmbeddingText(item: FaqItem): string {
  return `Question: ${item.question}\nAnswer: ${item.answer}`;
}

async function chunk<T>(arr: T[], size: number): Promise<T[][]> {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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
    failed: 0,
    ids: [],
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

  const records = valid.map(({ item, index }) => ({
    id: makeId(item, index),
    data: buildEmbeddingText(item),
    metadata: {
      question: item.question,
      answer: item.answer,
      uploadedAt: new Date().toISOString(),
    },
  }));

  const batches = await chunk(records, BATCH_SIZE);

  for (const batch of batches) {
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

  const status = result.failed > 0 && result.upserted === 0 ? 502 : 200;
  return NextResponse.json(result, { status });
}

export async function GET() {
  try {
    const info = await vectorIndex.info();
    return NextResponse.json(info);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
