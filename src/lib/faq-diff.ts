import { createHash } from "crypto";
import { getVectorIndex, type FaqItem, type ProjectKey } from "@/lib/upstash";

export const FETCH_BATCH_SIZE = 100;

/**
 * Stable id derived from the question alone, so re-uploading the same question
 * with a new answer overwrites the existing record instead of duplicating it.
 */
export function makeId(item: FaqItem): string {
  const hash = createHash("sha1")
    .update(item.question.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `faq_${hash}`;
}

export function buildEmbeddingText(item: FaqItem): string {
  return `Question: ${item.question}\nAnswer: ${item.answer}`;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type StoredPair = { question: string; answer: string };

/** Fetch the currently stored question/answer for each id, keyed by id. */
export async function fetchExisting(
  project: ProjectKey,
  ids: string[],
): Promise<Map<string, StoredPair>> {
  const existing = new Map<string, StoredPair>();
  const index = getVectorIndex(project);

  for (const idBatch of chunk(ids, FETCH_BATCH_SIZE)) {
    const found = await index.fetch(idBatch, { includeMetadata: true });
    found.forEach((vec, i) => {
      if (!vec) return;
      const meta = (vec.metadata ?? {}) as Record<string, unknown>;
      existing.set(idBatch[i], {
        question: typeof meta.question === "string" ? meta.question : "",
        answer: typeof meta.answer === "string" ? meta.answer : "",
      });
    });
  }
  return existing;
}

export type DiffStatus = "new" | "unchanged" | "changed";

export function diffStatus(
  item: FaqItem,
  prev: StoredPair | undefined,
): DiffStatus {
  if (!prev) return "new";
  if (prev.question === item.question && prev.answer === item.answer) {
    return "unchanged";
  }
  return "changed";
}

export const SCAN_PAGE_SIZE = 200;
/** Hard stop so a runaway cursor cannot loop forever. */
const MAX_SCAN_PAGES = 200;

export type StoredEntry = StoredPair & { id: string };

/**
 * Walk the whole index and return every stored entry. Used by full-sync
 * uploads, which must know about records the incoming file does not mention.
 */
export async function fetchAllStored(
  project: ProjectKey,
): Promise<StoredEntry[]> {
  const index = getVectorIndex(project);
  const out: StoredEntry[] = [];
  let cursor = "0";

  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const res = await index.range({
      cursor,
      limit: SCAN_PAGE_SIZE,
      includeMetadata: true,
    });

    for (const vec of res.vectors) {
      const meta = (vec.metadata ?? {}) as Record<string, unknown>;
      out.push({
        id: String(vec.id),
        question: typeof meta.question === "string" ? meta.question : "",
        answer: typeof meta.answer === "string" ? meta.answer : "",
      });
    }

    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }

  return out;
}
