import { Index } from "@upstash/vector";

export const PROJECTS = ["keyring", "coinpool"] as const;
export type ProjectKey = (typeof PROJECTS)[number];

export const DEFAULT_PROJECT: ProjectKey = "keyring";

export function isProjectKey(value: unknown): value is ProjectKey {
  return (
    typeof value === "string" && (PROJECTS as readonly string[]).includes(value)
  );
}

type ProjectConfig = { url: string | undefined; token: string | undefined };

function getProjectConfig(project: ProjectKey): ProjectConfig {
  switch (project) {
    case "keyring":
      return {
        url: process.env.UPSTASH_VECTOR_REST_URL,
        token: process.env.UPSTASH_VECTOR_REST_TOKEN,
      };
    case "coinpool":
      return {
        url: process.env.UPSTASH_VECTOR_REST_URL_COINPOOL,
        token: process.env.UPSTASH_VECTOR_REST_TOKEN_COINPOOL,
      };
  }
}

declare global {
  var __upstashIndexes: Partial<Record<ProjectKey, Index>> | undefined;
}

export function getVectorIndex(project: ProjectKey = DEFAULT_PROJECT): Index {
  const cache = (global.__upstashIndexes ??= {});
  const existing = cache[project];
  if (existing) return existing;

  const { url, token } = getProjectConfig(project);
  if (!url || !token) {
    throw new Error(
      `Upstash credentials missing for project "${project}". Set the corresponding env vars.`,
    );
  }

  const index = new Index({ url, token });
  if (process.env.NODE_ENV !== "production") {
    cache[project] = index;
  }
  return index;
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
