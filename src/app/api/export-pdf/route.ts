import { NextResponse } from "next/server";
import {
  DEFAULT_PROJECT,
  isFaqItem,
  isProjectKey,
  type FaqItem,
  type ProjectKey,
} from "@/lib/upstash";
import { renderFaqPdf } from "@/lib/pdf";

export const runtime = "nodejs";

const MAX_ITEMS = 5000;

const PROJECT_LABELS: Record<ProjectKey, string> = {
  "keyring-app": "Keyring",
  coinpool: "Coinpool",
  "coinpool-prod": "Coinpool (Production)",
  "nft-viewer": "NFT Viewer",
  "keyring-one": "Keyring One",
};

/** Build a filesystem-safe download name, e.g. `coinpool-faq-2026-09-09.pdf`. */
function makeFilename(project: ProjectKey): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${project}-faq-${date}.pdf`;
}

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
  if (projectRaw !== undefined && !isProjectKey(projectRaw)) {
    return NextResponse.json(
      { error: `Unknown project "${String(projectRaw)}"` },
      { status: 400 },
    );
  }
  const project = isProjectKey(projectRaw) ? projectRaw : DEFAULT_PROJECT;

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

  const items: FaqItem[] = [];
  for (let index = 0; index < rawItems.length; index++) {
    const raw = rawItems[index];
    if (!isFaqItem(raw)) {
      return NextResponse.json(
        { error: `Item #${index + 1} must have string \`question\` and \`answer\`` },
        { status: 400 },
      );
    }
    const question = raw.question.trim();
    const answer = raw.answer.trim();
    if (!question || !answer) {
      return NextResponse.json(
        { error: `Item #${index + 1}: \`question\` and \`answer\` must not be empty` },
        { status: 400 },
      );
    }
    items.push({ question, answer });
  }

  const label = PROJECT_LABELS[project];
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16);

  let pdf: Uint8Array;
  try {
    pdf = renderFaqPdf(items, {
      title: `${label} - FAQ`,
      subtitle: `${items.length} item${items.length === 1 ? "" : "s"} - generated ${generatedAt} UTC`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to generate PDF: ${message}` },
      { status: 500 },
    );
  }

  return new Response(pdf as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${makeFilename(project)}"`,
      "Content-Length": String(pdf.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
