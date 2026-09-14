import type { FaqItem } from "@/lib/upstash";

/**
 * Minimal PDF writer for FAQ exports.
 *
 * Emits a PDF 1.4 document using the standard Helvetica fonts, so no font file
 * has to be embedded and no third-party dependency is needed. Text is encoded
 * as WinAnsi (CP1252), which covers the Latin-1 range; characters outside it
 * are transliterated by `toWinAnsi` so an export never renders as garbage.
 */

const PAGE_WIDTH = 595.28; // A4 @ 72dpi
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const TITLE_SIZE = 18;
const META_SIZE = 9;
const QUESTION_SIZE = 11;
const ANSWER_SIZE = 10;
const LINE_GAP = 1.35;
const BLOCK_GAP = 14;
const FOOTER_SIZE = 8;

const FONT_REGULAR = "F1"; // Helvetica
const FONT_BOLD = "F2"; // Helvetica-Bold

/**
 * Characters common in FAQ copy that have no WinAnsi code point, mapped to a
 * visually equivalent ASCII/Latin-1 form.
 */
const TRANSLITERATIONS: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": ",",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "‑": "-",
  "…": "...",
  "→": "->",
  "←": "<-",
  "⇒": "=>",
  "・": "-",
  "　": " ",
  " ": " ",
  "™": "(TM)",
  "≠": "!=",
  "≤": "<=",
  "≥": ">=",
};

/** WinAnsi (CP1252) code points for the 0x80-0x9F range, which differ from Unicode. */
const CP1252_HIGH: Record<string, number> = {
  "€": 0x80,
  "‚": 0x82,
  "ƒ": 0x83,
  "„": 0x84,
  "…": 0x85,
  "†": 0x86,
  "‡": 0x87,
  "ˆ": 0x88,
  "‰": 0x89,
  "Š": 0x8a,
  "‹": 0x8b,
  "Œ": 0x8c,
  "Ž": 0x8e,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "˜": 0x98,
  "™": 0x99,
  "š": 0x9a,
  "›": 0x9b,
  "œ": 0x9c,
  "ž": 0x9e,
  "Ÿ": 0x9f,
};

/**
 * Convert a JS string into a WinAnsi-encodable string. Anything that cannot be
 * represented is transliterated, or replaced with "?" as a last resort.
 */
export function toWinAnsi(input: string): string {
  let out = "";
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;

    // Printable ASCII and Latin-1 map directly.
    if (code === 0x0a || (code >= 0x20 && code <= 0x7e)) {
      out += char;
      continue;
    }
    if (CP1252_HIGH[char] !== undefined) {
      out += String.fromCharCode(CP1252_HIGH[char]);
      continue;
    }
    if (code >= 0xa0 && code <= 0xff) {
      out += char;
      continue;
    }
    const replacement = TRANSLITERATIONS[char];
    if (replacement !== undefined) {
      out += replacement;
      continue;
    }
    // Drop zero-width/formatting characters silently.
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) {
      continue;
    }
    out += "?";
  }
  return out;
}

/** Escape the characters that are special inside a PDF literal string. */
function escapePdfText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r/g, "");
}

/**
 * Widths (per 1000 units) for Helvetica and Helvetica-Bold over the WinAnsi
 * range, used to wrap text to the content width without a font library.
 */
const HELVETICA_WIDTHS: Record<number, number> = buildWidths(
  "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584",
);

const HELVETICA_BOLD_WIDTHS: Record<number, number> = buildWidths(
  "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584",
);

function buildWidths(spec: string): Record<number, number> {
  const values = spec.trim().split(/\s+/).map(Number);
  const table: Record<number, number> = {};
  // The width list starts at space (0x20).
  values.forEach((width, i) => {
    table[0x20 + i] = width;
  });
  return table;
}

function charWidth(char: string, size: number, bold: boolean): number {
  const table = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  const code = char.charCodeAt(0);
  // Fall back to the width of "n" for anything outside the measured range.
  const width = table[code] ?? (bold ? 611 : 556);
  return (width * size) / 1000;
}

function textWidth(text: string, size: number, bold: boolean): number {
  let total = 0;
  for (const char of text) total += charWidth(char, size, bold);
  return total;
}

/**
 * Wrap already-WinAnsi text to `maxWidth`, honouring explicit newlines and
 * breaking words that are too long to fit on a line of their own.
 */
export function wrapText(
  text: string,
  size: number,
  bold: boolean,
  maxWidth: number,
): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate, size, bold) <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current) lines.push(current);

      // A single word longer than the line: break it by character.
      if (textWidth(word, size, bold) > maxWidth) {
        let piece = "";
        for (const char of word) {
          if (textWidth(piece + char, size, bold) > maxWidth && piece) {
            lines.push(piece);
            piece = char;
          } else {
            piece += char;
          }
        }
        current = piece;
      } else {
        current = word;
      }
    }
    if (current) lines.push(current);
  }

  return lines;
}

type Line = { text: string; size: number; bold: boolean; gapAfter: number };

/** A page's worth of laid-out lines. */
type Page = Line[];

function layout(items: FaqItem[], title: string, subtitle: string): Page[] {
  const pages: Page[] = [];
  let page: Page = [];
  let y = PAGE_HEIGHT - MARGIN;

  const lineHeight = (size: number) => size * LINE_GAP;

  const push = (line: Line, height: number) => {
    if (y - height < MARGIN + 24) {
      pages.push(page);
      page = [];
      y = PAGE_HEIGHT - MARGIN;
    }
    page.push(line);
    y -= height;
  };

  // Header
  push(
    { text: title, size: TITLE_SIZE, bold: true, gapAfter: 6 },
    lineHeight(TITLE_SIZE) + 6,
  );
  push(
    { text: subtitle, size: META_SIZE, bold: false, gapAfter: BLOCK_GAP },
    lineHeight(META_SIZE) + BLOCK_GAP,
  );

  items.forEach((item, index) => {
    const question = `${index + 1}. ${toWinAnsi(item.question)}`;
    const answer = toWinAnsi(item.answer);

    const questionLines = wrapText(question, QUESTION_SIZE, true, CONTENT_WIDTH);
    const answerLines = wrapText(answer, ANSWER_SIZE, false, CONTENT_WIDTH);

    questionLines.forEach((text, i) => {
      const isLast = i === questionLines.length - 1;
      push(
        { text, size: QUESTION_SIZE, bold: true, gapAfter: isLast ? 4 : 0 },
        lineHeight(QUESTION_SIZE) + (isLast ? 4 : 0),
      );
    });

    answerLines.forEach((text, i) => {
      const isLast = i === answerLines.length - 1;
      push(
        {
          text,
          size: ANSWER_SIZE,
          bold: false,
          gapAfter: isLast ? BLOCK_GAP : 0,
        },
        lineHeight(ANSWER_SIZE) + (isLast ? BLOCK_GAP : 0),
      );
    });
  });

  pages.push(page);
  return pages;
}

/** Build the content stream that draws one page's lines. */
function buildContentStream(
  page: Page,
  pageNumber: number,
  pageCount: number,
): string {
  const parts: string[] = ["BT"];
  let y = PAGE_HEIGHT - MARGIN;
  let currentFont = "";
  let currentSize = 0;
  let first = true;

  // A line's own `gapAfter` belongs *below* it, so it is carried over and added
  // to the advance of the following line.
  let pendingGap = 0;

  for (const line of page) {
    const font = line.bold ? FONT_BOLD : FONT_REGULAR;

    if (font !== currentFont || line.size !== currentSize) {
      parts.push(`/${font} ${line.size} Tf`);
      currentFont = font;
      currentSize = line.size;
    }

    if (first) {
      parts.push(`1 0 0 1 ${MARGIN.toFixed(2)} ${(y - line.size).toFixed(2)} Tm`);
      first = false;
    } else {
      const advance = line.size * LINE_GAP + pendingGap;
      parts.push(`0 ${(-advance).toFixed(2)} Td`);
    }

    parts.push(`(${escapePdfText(line.text)}) Tj`);
    y -= line.size * LINE_GAP + pendingGap;
    pendingGap = line.gapAfter;
  }

  parts.push("ET");

  // Footer: page number, centred.
  const footer = `Page ${pageNumber} of ${pageCount}`;
  const footerX = (PAGE_WIDTH - textWidth(footer, FOOTER_SIZE, false)) / 2;
  parts.push("BT");
  parts.push(`/${FONT_REGULAR} ${FOOTER_SIZE} Tf`);
  parts.push("0.45 0.45 0.45 rg");
  parts.push(`1 0 0 1 ${footerX.toFixed(2)} ${(MARGIN - 18).toFixed(2)} Tm`);
  parts.push(`(${escapePdfText(footer)}) Tj`);
  parts.push("ET");

  return parts.join("\n");
}

/** Format a Date as a PDF date string (D:YYYYMMDDHHmmSSZ). */
function pdfDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

export type PdfOptions = {
  title: string;
  subtitle: string;
};

/**
 * Render FAQ items to a PDF document.
 *
 * The returned bytes are a complete, self-contained PDF 1.4 file.
 */
export function renderFaqPdf(items: FaqItem[], options: PdfOptions): Uint8Array {
  const title = toWinAnsi(options.title);
  const subtitle = toWinAnsi(options.subtitle);
  const pages = layout(items, title, subtitle);
  const pageCount = pages.length;

  // Object numbering: 1 = Catalog, 2 = Pages, 3 = Font regular, 4 = Font bold,
  // 5 = Info, then two objects (page + content stream) per page.
  const objects: string[] = [];
  const firstPageObj = 6;
  const pageObjIds = pages.map((_, i) => firstPageObj + i * 2);

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Count ${pageCount} ` +
    `/Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objects[3] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[5] =
    `<< /Title (${escapePdfText(title)}) /Producer (keyring-upload) ` +
    `/CreationDate (${pdfDate(new Date())}) >>`;

  pages.forEach((page, i) => {
    const pageId = pageObjIds[i];
    const contentId = pageId + 1;
    const stream = buildContentStream(page, i + 1, pageCount);
    const streamBytes = Buffer.byteLength(stream, "latin1");

    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R ` +
      `/MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${PAGE_HEIGHT.toFixed(2)}] ` +
      `/Resources << /Font << /${FONT_REGULAR} 3 0 R /${FONT_BOLD} 4 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${streamBytes} >>\nstream\n${stream}\nendstream`;
  });

  // Serialise with a cross-reference table.
  const chunks: string[] = ["%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"];
  let offset = Buffer.byteLength(chunks[0], "latin1");
  const offsets: number[] = [];

  for (let id = 1; id < objects.length; id++) {
    const body = objects[id];
    if (body === undefined) continue;
    offsets[id] = offset;
    const chunk = `${id} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    offset += Buffer.byteLength(chunk, "latin1");
  }

  const objectCount = objects.length; // highest id + 1
  const xrefOffset = offset;
  let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let id = 1; id < objectCount; id++) {
    const at = offsets[id];
    xref +=
      at === undefined
        ? "0000000000 65535 f \n"
        : `${String(at).padStart(10, "0")} 00000 n \n`;
  }
  chunks.push(xref);

  chunks.push(
    `trailer\n<< /Size ${objectCount} /Root 1 0 R /Info 5 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );

  return new Uint8Array(Buffer.from(chunks.join(""), "latin1"));
}
