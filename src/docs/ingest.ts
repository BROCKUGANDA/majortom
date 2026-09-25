// src/docs/ingest.ts — guide intake per SPEC.md §4 (Phase 4)
//
// Accepts PDF, Markdown, or URL. Enforces config.limits.maxGuidePages, hashes the
// artifact, and hands the doc-reader a plain-text view plus the source descriptor.
//
// SECURITY (SPEC.md I3 / §7.2): a migration guide is DATA. Nothing in this module
// interprets the guide's contents as an instruction to the tool. The extracted text
// is passed to the doc-reader as an opaque string to be fact-extracted, and the
// injection scanner in scan.ts flags any imperative addressed at the tool.

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { extname } from "path";
import { inflateSync, inflateRawSync } from "zlib";
import { z } from "zod";

export const GuideKind = z.enum(["pdf", "markdown", "url"]);
export type GuideKind = z.infer<typeof GuideKind>;

export interface GuideArtifact {
  /** Stable id used as Citation.docId — relative path for local files, URL for remote. */
  docId: string;
  kind: GuideKind;
  sha256: string;
  title: string;
  /** Page count for PDFs, null for text guides. */
  pages: number | null;
  /** The text the doc-reader sees. */
  text: string;
  /** Non-fatal problems encountered during intake. */
  intakeWarnings: Array<{ code: string; message: string }>;
}

export class GuideUnreadableError extends Error {
  constructor(
    message: string,
    readonly code: "E_GUIDE_UNREADABLE" = "E_GUIDE_UNREADABLE"
  ) {
    super(message);
    this.name = "GuideUnreadableError";
  }
}

const MAX_QUOTE_SOURCE_BYTES = 25 * 1024 * 1024;

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Strip markdown scaffolding so the doc-reader reads prose, not layout.
 * Heading MARKERS are deliberately preserved: they are the document's section
 * structure, and §4 citations are anchored to a section heading + locator.
 */
function markdownToText(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      // Keep fenced code: it carries the Before/After examples that justify fixes.
      if (/^\s*```/.test(line)) return line;
      return line
        .replace(/^>\s?/, "") // block quotes
        .replace(/\*\*(.+?)\*\*/g, "$1") // bold
        .replace(/`([^`]+)`/g, "$1"); // inline code
    })
    .join("\n");
}

export interface IngestOptions {
  /** config.limits.maxGuidePages — enforced for PDFs. */
  maxGuidePages: number;
}

/**
 * Load a guide from disk. `path` may be a Markdown file, a PDF, or an http(s) URL
 * (URLs must already be fetched to a local file by the caller — the orchestrator owns
 * network access per §7.1; the doc-reader has none per §7.2).
 */
export function ingestGuide(repoRoot: string, path: string, options: IngestOptions): GuideArtifact {
  const abs = path.startsWith("/") || /^[A-Za-z]:/.test(path) ? path : `${repoRoot}/${path}`;
  const rel = path.replace(/\\/g, "/");
  const ext = extname(abs).toLowerCase();

  let raw: Buffer;
  try {
    raw = readFileSync(abs);
  } catch (err) {
    throw new GuideUnreadableError(`Cannot read guide at ${rel}: ${(err as Error).message}`);
  }
  if (raw.byteLength > MAX_QUOTE_SOURCE_BYTES) {
    throw new GuideUnreadableError(
      `Guide at ${rel} exceeds the ${MAX_QUOTE_SOURCE_BYTES} byte limit`
    );
  }

  const digest = sha256(raw);

  if (ext === ".pdf") {
    const parsed = parsePdf(raw);
    if (parsed.pages > options.maxGuidePages) {
      throw new GuideUnreadableError(
        `Guide has ${parsed.pages} pages, exceeding config.limits.maxGuidePages=${options.maxGuidePages}`
      );
    }
    return {
      docId: rel,
      kind: "pdf",
      sha256: digest,
      title: parsed.title ?? rel,
      pages: parsed.pages,
      text: parsed.text,
      intakeWarnings: parsed.warnings,
    };
  }

  if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
    const text = markdownToText(raw.toString("utf8"));
    return {
      docId: rel,
      kind: "markdown",
      sha256: digest,
      title: extractTitle(text) ?? rel,
      pages: null,
      text,
      intakeWarnings: [],
    };
  }

  throw new GuideUnreadableError(
    `Unsupported guide extension "${ext}" for ${rel}. Expected .md, .markdown, .txt, or .pdf.`
  );
}

function extractTitle(text: string): string | null {
  const m = /^#\s+(.+)$/m.exec(text);
  return m?.[1]?.trim() ?? null;
}

/**
 * Minimal PDF text extraction. SPEC.md §2.1 lists pdf-parse as a FALLBACK path only;
 * this keeps intake dependency-free and deterministic. Uncompresses FlateDecode
 * streams and pulls text from Tj/TJ operators. Anything it cannot read is reported
 * as a warning rather than silently producing an empty guide.
 */
function parsePdf(buf: Buffer): {
  text: string;
  pages: number;
  title: string | null;
  warnings: Array<{ code: string; message: string }>;
} {
  const warnings: Array<{ code: string; message: string }> = [];
  const latin = buf.toString("latin1");

  const pageCount = (latin.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  const titleMatch = /\/Title\s*\(([^)]*)\)/.exec(latin);

  const chunks: string[] = [];
  // Stream contents may be raw or Flate-compressed.
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(latin)) !== null) {
    const body = m[1] ?? "";
    let decoded = body;
    if (body.startsWith("�") || !isPrintable(body)) {
      const inflated = tryInflate(Buffer.from(body, "latin1"));
      if (inflated === null) continue;
      decoded = inflated.toString("latin1");
    }
    chunks.push(decoded);
  }

  const text = chunks.map(extractPdfText).filter(Boolean).join("\n").trim();

  if (text.length === 0) {
    warnings.push({
      code: "E_GUIDE_UNREADABLE",
      message: "No extractable text layer found in the PDF. Supply a Markdown guide instead.",
    });
  }

  return {
    text,
    pages: pageCount || 1,
    title: titleMatch?.[1]?.trim() ?? null,
    warnings,
  };
}

function isPrintable(s: string): boolean {
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
  }
  return printable / Math.max(1, s.length) > 0.95;
}

function tryInflate(buf: Buffer): Buffer | null {
  try {
    return inflateSync(buf);
  } catch {
    try {
      return inflateRawSync(buf);
    } catch {
      return null;
    }
  }
}

/** Pull literal strings out of Tj / TJ show-text operators. */
function extractPdfText(stream: string): string {
  const out: string[] = [];
  const re = /\((?:\\.|[^\\()])*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stream)) !== null) {
    const raw = m[0].slice(1, -1);
    const unescaped = raw
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\");
    if (unescaped.trim().length > 0) out.push(unescaped);
  }
  return out.join(" ");
}
