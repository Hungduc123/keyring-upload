import { Index } from "@upstash/vector";

declare global {
  var __upstashIndex: Index | undefined;
}

export const vectorIndex =
  global.__upstashIndex ??
  new Index({
    url: process.env.UPSTASH_VECTOR_REST_URL!,
    token: process.env.UPSTASH_VECTOR_REST_TOKEN!,
  });

if (process.env.NODE_ENV !== "production") {
  global.__upstashIndex = vectorIndex;
}

export type FaqItem = {
  question: string;
  answer: string;
};

export function isFaqItem(value: unknown): value is FaqItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.question === "string" && typeof v.answer === "string";
}
