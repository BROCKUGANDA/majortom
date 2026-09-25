// src/scanner/impact.ts
// impactScan(plan) per SPEC.md §6.2 — two-pass regex + ts-morph confirmation.
//
// Pass 1 (cheap): regex over each item's filesGlob.
// Pass 2 (precise): confirm each regex hit is executable code, not a comment, not
//   inert string data, not an import name. Suppressed hits are RECORDED with a
//   reason (§6.2 — they surface in the report appendix), never dropped.
//
// On "the right receiver" (§6.2): each detect.regex in §4 already encodes the receiver
// as a literal prefix (`res.send(`, `req.param(`, `app.del(`), so receiver identity is
// enforced by the pattern itself. What the AST pass adds is *position* classification:
// is this occurrence executable, or is it inert text that merely looks like code?
//
// Route-string carve-out: Annex B rows EX-10/EX-11/EX-12 (path route matching syntax)
// are string literals by construction — the route path IS the call site. Suppressing
// every string literal would make those items permanently undetectable and break the
// §6.3 requirement that the work map cover every seeded breakage. We therefore suppress
// a string match only when the string is not the first argument of a route
// registration call (app.METHOD / router.METHOD / app.use / router.all).

import { readFileSync } from "fs";
import { join } from "path";
import fg from "fast-glob";
import { Node, Project, SyntaxKind, ts } from "ts-morph";
import type { WorkMapEntry, WorkMapHit } from "./schemas.js";

// ─── Types (local mirror of plan types, to avoid coupling to Phase 4 schemas) ──

export interface PlanItemDetect {
  regex: string[];
  astQuery: string | null;
  filesGlob: string[];
}

export interface PlanItemSlice {
  id: string;
  detect: PlanItemDetect;
}

export interface ImpactScanResult {
  entries: WorkMapEntry[];
  unmatchedItemIds: string[];
}

// ─── Exclusion patterns ──────────────────────────────────────────────────────

const EXCLUDED_GLOBS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.git/**",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/*.lock",
];

/**
 * A route registration call: <receiver>.METHOD where METHOD is an HTTP verb or
 * `use`/`all`. The receiver must look like an Express app or router (`app`, `router`,
 * `apiRouter`, `v1App`, ...) — NOT an arbitrary object. Without the receiver check,
 * a supertest call like `request(app).get("/search?q=1")` would be mistaken for a
 * route registration and pull an unrelated test file into a fixer's queue.
 */
const ROUTE_CALL = /\.\s*(get|post|put|patch|delete|del|options|head|all|use)\s*$/;
const ROUTE_RECEIVER = /^([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z_$][\w$]*$/;

// ─── Main ────────────────────────────────────────────────────────────────────

export async function impactScan(
  repoRoot: string,
  items: PlanItemSlice[]
): Promise<ImpactScanResult> {
  // Pass 1: regex scan
  const pass1 = await regexPass(repoRoot, items);

  // Pass 2: AST confirmation for .ts/.js/.mjs/.cjs files
  const confirmed = await astPass(repoRoot, pass1);

  // Build entries map: file → hits
  const fileHits = new Map<string, WorkMapHit[]>();
  for (const hit of confirmed) {
    const existing = fileHits.get(hit.file) ?? [];
    existing.push(hit.hitRecord);
    fileHits.set(hit.file, existing);
  }

  const entries: WorkMapEntry[] = Array.from(fileHits.entries()).map(([file, hits]) => ({
    file,
    // Deterministic ordering so the work map is byte-stable across runs.
    hits: [...hits].sort((a, b) =>
      a.line !== b.line
        ? a.line - b.line
        : a.column !== b.column
          ? a.column - b.column
          : a.itemId.localeCompare(b.itemId)
    ),
    estimatedEdits: hits.filter((h) => !h.suppressed).length,
  }));

  // Compute unmatched item IDs. An item whose every hit was suppressed has zero real
  // call sites — the honest §6.3 "no changes needed" signal.
  const matchedItemIds = new Set(
    confirmed.filter((c) => !c.hitRecord.suppressed).map((c) => c.itemId)
  );
  const unmatchedItemIds = items.map((i) => i.id).filter((id) => !matchedItemIds.has(id));

  return { entries, unmatchedItemIds };
}

// ─── Pass 1: regex ───────────────────────────────────────────────────────────

interface RegexHit {
  itemId: string;
  file: string;
  line: number;
  column: number;
  snippet: string;
}

async function regexPass(repoRoot: string, items: PlanItemSlice[]): Promise<RegexHit[]> {
  const hits: RegexHit[] = [];

  for (const item of items) {
    const filesGlob =
      item.detect.filesGlob.length > 0 ? item.detect.filesGlob : ["**/*.{ts,js,mjs,cjs}"];

    const files = await fg(filesGlob, {
      cwd: repoRoot,
      ignore: EXCLUDED_GLOBS,
      absolute: false,
      onlyFiles: true,
    });

    for (const file of files.sort()) {
      const absPath = join(repoRoot, file);
      let content: string;
      try {
        content = readFileSync(absPath, "utf8");
      } catch {
        continue;
      }

      const lines = content.split("\n");

      for (const pattern of item.detect.regex) {
        let regex: RegExp;
        try {
          // Per-line matching: a pattern cannot span lines and the reported
          // line/column stay exact. The global flag is reset per line.
          regex = new RegExp(pattern, "g");
        } catch {
          continue;
        }

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx] ?? "";
          regex.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = regex.exec(line)) !== null) {
            if (match[0].length === 0) regex.lastIndex++;
            hits.push({
              itemId: item.id,
              file,
              line: lineIdx + 1,
              column: match.index + 1,
              snippet: line.trim().slice(0, 120),
            });
          }
        }
      }
    }
  }

  // Stable order: file, then line, then column, then item.
  hits.sort((a, b) =>
    a.file !== b.file
      ? a.file.localeCompare(b.file)
      : a.line !== b.line
        ? a.line - b.line
        : a.column !== b.column
          ? a.column - b.column
          : a.itemId.localeCompare(b.itemId)
  );

  return hits;
}

// ─── Pass 2: AST confirmation ─────────────────────────────────────────────────

interface ConfirmedHit {
  itemId: string;
  file: string;
  hitRecord: WorkMapHit;
}

interface Range {
  start: number;
  end: number;
}

/** Per-file analysis, computed once and reused for every hit in that file. */
interface FileAnalysis {
  comments: Range[];
  strings: Range[];
  stringNodes: Node[];
}

function acceptAsRegex(itemId: string, file: string, hit: RegexHit): ConfirmedHit {
  return {
    itemId,
    file,
    hitRecord: {
      itemId,
      line: hit.line,
      column: hit.column,
      snippet: hit.snippet,
      matchKind: "regex",
      suppressed: false,
      suppressionReason: null,
    },
  };
}

async function astPass(repoRoot: string, regexHits: RegexHit[]): Promise<ConfirmedHit[]> {
  if (regexHits.length === 0) return [];

  // Group hits by file
  const byFile = new Map<string, RegexHit[]>();
  for (const hit of regexHits) {
    const existing = byFile.get(hit.file) ?? [];
    existing.push(hit);
    byFile.set(hit.file, existing);
  }

  // §6.2 scopes AST confirmation to TypeScript and JavaScript hits.
  const JS_TS_EXT = /\.(ts|tsx|jsx|mjs|cjs|js)$/;

  let project: Project | null = null;
  const results: ConfirmedHit[] = [];

  for (const [file, hits] of byFile) {
    // Non-JS/TS file (e.g. package.json for EX-18): no AST available, accept as-is.
    if (!JS_TS_EXT.test(file)) {
      for (const hit of hits) results.push(acceptAsRegex(hit.itemId, file, hit));
      continue;
    }

    if (!project) {
      project = new Project({
        skipAddingFilesFromTsConfig: true,
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          noEmit: true,
          jsx: ts.JsxEmit.Preserve,
        },
      });
    }

    const absPath = join(repoRoot, file);
    let sourceFile;
    try {
      sourceFile = project.getSourceFile(absPath) ?? project.addSourceFileAtPath(absPath);
    } catch {
      sourceFile = undefined;
    }

    // Unparseable file: fall back to accepting regex hits, recorded as regex.
    if (!sourceFile) {
      for (const hit of hits) results.push(acceptAsRegex(hit.itemId, file, hit));
      continue;
    }

    const analysis = analyzeFile(sourceFile);

    for (const hit of hits) {
      const pos = offsetOf(sourceFile, hit.line, hit.column);
      const verdict =
        pos === null
          ? { suppressed: false, reason: null as string | null, matchKind: "regex" as const }
          : classifyAt(analysis, pos);

      results.push({
        itemId: hit.itemId,
        file: hit.file,
        hitRecord: {
          itemId: hit.itemId,
          line: hit.line,
          column: hit.column,
          snippet: hit.snippet,
          matchKind: verdict.suppressed ? "regex" : verdict.matchKind,
          suppressed: verdict.suppressed,
          suppressionReason: verdict.reason,
        },
      });
    }
  }

  return results;
}

/** Convert a 1-based (line, column) pair to an absolute character offset. */
function offsetOf(
  sourceFile: ReturnType<Project["addSourceFileAtPath"]>,
  line: number,
  col: number
): number | null {
  try {
    return sourceFile.compilerNode.getPositionOfLineAndCharacter(line - 1, col - 1);
  } catch {
    return null;
  }
}

/**
 * Lex + AST analysis of one file. Comment and string-literal ranges come from the
 * TypeScript scanner — exact, and immune to the naive backwards-scan that mistakes a
 * block-comment marker inside a string for a real block comment. String AST nodes come
 * from ts-morph so a route path can be recognised as a genuine argument rather than
 * inert data.
 */
function analyzeFile(sourceFile: ReturnType<Project["addSourceFileAtPath"]>): FileAnalysis {
  const text = sourceFile.getFullText();
  const comments: Range[] = [];
  const strings: Range[] = [];

  try {
    // skipTrivia = false so comments and string tokens surface as tokens.
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      text
    );
    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken) {
      const start = scanner.getTokenPos();
      const end = scanner.getTextPos();
      if (
        token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        comments.push({ start, end });
      } else if (
        token === ts.SyntaxKind.StringLiteral ||
        token === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
        token === ts.SyntaxKind.TemplateHead ||
        token === ts.SyntaxKind.TemplateMiddle ||
        token === ts.SyntaxKind.TemplateTail
      ) {
        strings.push({ start, end });
      }
      token = scanner.scan();
    }
  } catch {
    // Scanner unavailable: degrade to no ranges (hits treated as code).
  }

  let stringNodes: Node[] = [];
  try {
    stringNodes = [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
    ];
  } catch {
    stringNodes = [];
  }

  return { comments, strings, stringNodes };
}

function inRanges(ranges: Range[], pos: number): boolean {
  for (const r of ranges) {
    if (pos >= r.start && pos < r.end) return true;
  }
  return false;
}

interface Verdict {
  suppressed: boolean;
  reason: string | null;
  matchKind: "regex" | "ast";
}

function classifyAt(analysis: FileAnalysis, pos: number): Verdict {
  if (inRanges(analysis.comments, pos)) {
    return { suppressed: true, reason: "inside a comment", matchKind: "regex" };
  }

  if (inRanges(analysis.strings, pos)) {
    const strNode = analysis.stringNodes.find((n) => n.getStart() <= pos && pos < n.getEnd());
    if (strNode && isRoutePathArgument(strNode)) {
      // Annex B route-syntax item: the route string is the real call site.
      return { suppressed: false, reason: null, matchKind: "ast" };
    }
    return { suppressed: true, reason: "inside a string literal", matchKind: "regex" };
  }

  return { suppressed: false, reason: null, matchKind: "ast" };
}

/**
 * True when `strNode` is the first argument of a route registration call —
 * app.METHOD(path, ...), router.METHOD(path, ...), app.use(path, ...).
 */
function isRoutePathArgument(strNode: Node): boolean {
  const parent = strNode.getParent();
  if (!parent || !Node.isCallExpression(parent)) return false;

  const first = parent.getArguments()[0];
  if (!first || first.getStart() !== strNode.getStart()) return false;

  const callee = parent.getExpression().getText();

  // A chained call (request(app).get(...)) is a request, not a registration.
  if (callee.includes("(")) return false;
  if (!ROUTE_CALL.test(callee)) return false;

  // The receiver must look like an app or a router. `request(app).get` is already
  // excluded above; this also rejects `client.get`, `cache.get`, `map.get`, etc.
  const receiverMatch = ROUTE_RECEIVER.exec(callee.trim());
  if (!receiverMatch?.[1]) return false;
  return /(^|[a-z])(app|router)$/i.test(receiverMatch[1]);
}
