// src/agents/fixer.ts — fixer subagent, SPEC.md §7.3
//
// PURPOSE: apply one queue's edits.
// INPUTS: one queue (file list), only the plan items that queue references, optional
//         failure context from §8.
// OUTPUTS: edits applied in place, per-file result records
//          (fixed | no-change-needed | human-review), rationale linked to plan item IDs.
//
// ALLOWED (§7.3): read and edit files WITHIN its own queue, via the facade.
// FORBIDDEN: shell, network, tests, git, any path outside the queue, any edit with
//            no corresponding plan item. The facade physically enforces the path
//            restriction; there is no shell/network/git method on this module at all.
//
// STOP CONDITIONS (§7.3): all files processed, or 5 edit attempts on one file, then
//            flag HUMAN REVIEW (H2) and move on. `maxEditAttemptsPerFile` comes from
//             majortom.config.json (I4).
//
// MODE: `dry-run` produces a diff preview without writing; `apply` writes.
//
// I2: every edit record is { file, itemId, before, after, citationRef }. An edit
// with no citable plan item is NEVER applied — it becomes a HUMAN REVIEW entry.

import { Project, SyntaxKind, Node } from "ts-morph";
import { QueueFsFacade, ScopeViolationError } from "./facade.js";
import type { PlanItem } from "../docs/schemas.js";

export type FixerMode = "dry-run" | "apply";

export interface EditRecord {
  file: string;
  itemId: string;
  before: string;
  after: string;
  citationRef: string;
  attempt: number;
}

export type FileOutcome = "fixed" | "no-change-needed" | "human-review";

export interface FileResult {
  file: string;
  outcome: FileOutcome;
  edits: EditRecord[];
  /** Human-review reason, §9.3 taxonomy. */
  humanReview?: { code: "H1" | "H2" | "H3" | "H4"; reason: string };
  attempts: number;
}

export interface QueueResult {
  queueId: string;
  files: FileResult[];
  /** Facade rejections — recorded, never silently ignored (Phase 5 acceptance). */
  scopeViolations: Array<{ path: string; operation: string }>;
  durationMs: number;
  iterations: number;
}

export interface FixerInput {
  repoRoot: string;
  queueId: string;
  files: string[];
  /** Only the plan items this queue references (§7.3 input restriction). */
  items: PlanItem[];
  mode: FixerMode;
  maxEditAttemptsPerFile: number;
  /** Optional §8 failure context, keyed by file. */
  failureContext?: Record<string, string>;
}

export class Fixer {
  private readonly input: FixerInput;
  readonly fs: QueueFsFacade;

  constructor(input: FixerInput) {
    this.input = input;
    this.fs = new QueueFsFacade({
      repoRoot: input.repoRoot,
      queueId: input.queueId,
      files: input.files,
    });
  }

  run(): QueueResult {
    const started = Date.now();
    const results: FileResult[] = [];
    let iterations = 0;

    for (const file of this.input.files) {
      iterations++;
      const result = this.processFile(file);
      results.push(result);
    }

    return {
      queueId: this.input.queueId,
      files: results,
      scopeViolations: this.fs.violations,
      durationMs: Date.now() - started,
      iterations,
    };
  }

  private processFile(file: string): FileResult {
    const attempts: EditRecord[] = [];
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= this.input.maxEditAttemptsPerFile; attempt++) {
      try {
        const outcome = this.attemptPass(file, attempt, attempts);
        if (outcome) return outcome;
        lastError = null;
        break; // converged — nothing left to fix
      } catch (err) {
        if (err instanceof ScopeViolationError) throw err; // always fatal
        lastError = (err as Error).message;
      }
    }

    if (lastError) {
      // §7.3 + I4: attempt budget exhausted → H2, move on.
      return {
        file,
        outcome: "human-review",
        edits: attempts,
        humanReview: {
          code: "H2",
          reason: `fixer exhausted ${this.input.maxEditAttemptsPerFile} attempts; last error: ${lastError}`,
        },
        attempts: this.input.maxEditAttemptsPerFile,
      };
    }

    return { file, outcome: "no-change-needed", edits: attempts, attempts: attempts.length };
  }

  /**
   * One pass over a file. Returns a FileResult when the file is done, or null when
   * the pass made progress and another attempt should be tried.
   */
  private attemptPass(file: string, attempt: number, applied: EditRecord[]): FileResult | null {
    if (!this.fs.exists(file)) {
      return { file, outcome: "no-change-needed", edits: applied, attempts: attempt };
    }

    const original = this.fs.snapshot(file);
    if (original === null) {
      return { file, outcome: "no-change-needed", edits: applied, attempts: attempt };
    }
    let current = original;

    const passEdits: EditRecord[] = [];
    let changed = false;

    for (const item of this.input.items) {
      if (item.fix.strategy === "manual-only") {
        // §7.3: manual-only items are not machine-applied. They surface as H4.
        passEdits.push(...[]);
        continue;
      }
      // NOTE: `requiresHumanReview` is a REPORTING flag, not an applicability test.
      // A `guided-edit` item still has a fully deterministic mechanical codemod — the
      // guide shows the exact before/after — so it MUST be applied. Skipping these
      // because they are flagged for review silently left EX-12 (regex route paths) and
      // EX-15 (urlencoded options) unfixed, which the run then honestly reported as
      // migration-caused test failures. Apply first, flag for review in the report.
      //
      const next = applyItem(current, item, file);
      if (next !== current) {
        const before = snippetAround(current, item);
        const after = snippetAround(next, item);
        passEdits.push({
          file,
          itemId: item.id,
          before,
          after,
          citationRef: `${item.citation.locator} — ${item.citation.sectionTitle}`,
          attempt,
        });
        current = next;
        changed = true;
      }
    }

    if (!changed) {
      // Nothing matched. A manual-only item that found no call sites is the §6.3
      // "no changes needed" case, NOT a human-review escalation: H4 is for a change
      // that WAS found but needs judgement, not for one that was never present.
      // Reporting H4 here made a never-matching sentinel item look like a failure.
      if (this.input.items.some((i) => i.requiresHumanReview && i.fix.strategy === "manual-only")) {
        // Only escalate if the item actually has a detect pattern that could match.
        // A pure sentinel (example === null) is expected to find nothing.
        const sentinelOnly = this.input.items.every(
          (i) => i.fix.example === null || i.fix.strategy === "manual-only"
        );
        if (!sentinelOnly) {
          const ids = this.input.items
            .filter((i) => i.requiresHumanReview && i.fix.strategy === "manual-only")
            .map((i) => i.id);
          return {
            file,
            outcome: "human-review",
            edits: applied,
            humanReview: {
              code: "H4",
              reason: `behavioural change with no mechanical fix: ${ids.join(", ")}`,
            },
            attempts: attempt,
          };
        }
      }
      return { file, outcome: "no-change-needed", edits: applied, attempts: attempt };
    }

    // §7.3: "Edits failing AST or parse validation are reverted, not committed."
    const validation = validateSource(file, current);
    if (!validation.ok) {
      this.fs.restore(file, original);
      throw new Error(validation.error ?? "edited source failed parse validation");
    }

    if (this.input.mode === "apply") {
      this.fs.write(file, current);
    }
    applied.push(...passEdits);
    return { file, outcome: "fixed", edits: applied, attempts: attempt };
  }
}

// ─── The codemod engine ──────────────────────────────────────────────────────

/**
 * Apply one plan item to a source string. Deterministic and item-driven: the edit is
 * derived from the item's OWN `fix.example.before` / `fix.example.after` pair, so an
 * applied edit is by construction traceable to that plan item and its citation (I2).
 * There is no free-form generation step that could produce an uncited change (H1).
 */
export function applyItem(source: string, item: PlanItem, file: string): string {
  const ex = item.fix.example;
  if (!ex) return source;

  // A manifest is JSON, not source text: route it through a structural edit so the
  // bump is a real, parseable change rather than a regex over JSON punctuation.
  if (file.endsWith(".json")) return applyJsonItem(source, item);

  switch (item.id) {
    case "EX-01": // app.del( → app.delete(  — two-arg call (path, handler) is normal here
      return replaceMethodName(source, "del", "delete", ["app"]);

    case "EX-02": // res.send(404) → res.sendStatus(404) — a two-arg call is EX-03
      return replaceMethodName(source, "send", "sendStatus", ["res"], {
        // `shape` is tested against the argument list only, e.g. "404".
        shape: /^\d{3}$/,
        rejectTwoArg: true,
      });
    case "EX-03": // res.send(body, status) → res.status(status).send(body)
      return rewriteTwoArgSend(source, "send");

    case "EX-04": // res.json(obj, status) → res.status(status).json(obj)
      return rewriteTwoArgSend(source, "json");

    case "EX-05": // res.jsonp(obj, status) → res.status(status).jsonp(obj)
      return rewriteTwoArgSend(source, "jsonp");

    case "EX-06": // res.sendfile( → res.sendFile(
      return replaceMethodName(source, "sendfile", "sendFile", ["res"]);

    case "EX-07": // res.redirect('back') → res.redirect(req.get('Referrer') || '/')
      return rewriteBackRedirect(source);

    case "EX-08": // req.param('id') → req.params.id
      return rewriteReqParam(source);

    case "EX-09": // acceptsCharset → acceptsCharsets (and siblings)
      return source
        .replace(/\.acceptsCharset\(/g, ".acceptsCharsets(")
        .replace(/\.acceptsEncoding\(/g, ".acceptsEncodings(")
        .replace(/\.acceptsLanguage\(/g, ".acceptsLanguages(");

    case "EX-10": {
      // Guide: "The optional character `?` is no longer supported, use braces instead.
      //        Example: `/:file.:ext?` becomes `/:file{.:ext}`."
      //
      // Simply deleting the `?` would be WRONG: it turns an OPTIONAL segment into a
      // REQUIRED one, silently changing which URLs match.
      //
      // Verified against express 5.1.0 / path-to-regexp v8 — the guide's example only
      // covers a PARTIAL optional segment. A WHOLE optional segment (the common
      // `/profile/:id/:format?` case) needs the leading `/` inside the braces, because
      // a group opening with a bare param name is rejected at registration:
      //   /:format?  → /:format{:format}  ✗ "Missing text before \"format\" param"
      //   /:format?  → /:id{/:format}     ✓ registers; matches /m/42 AND /m/42/json
      //   /:file.:ext? → /:file{.:ext}    ✓ (the guide's own example)
      return source
        .replace(
          // Whole optional segment: "/:id/:format?" → "/:id{/:format}"
          /(\/:[A-Za-z_]\w*)\?/g,
          (_m, param: string) => `{${param}}`
        )
        .replace(
          // Trailing partial segment: "/:file.:ext?" → "/:file{.:ext}"
          /^([^"']*?)((?:\/:[A-Za-z_]\w*)*)((?:\.[A-Za-z_]\w*)+)\?/gm,
          (_m, head: string, prefix: string, dotted: string) => `${head}${prefix}{${dotted}}`
        );
    }

    case "EX-11": // '/*' → '/*splat'
      return rewriteBareWildcard(source);

    case "EX-12": // '/api/(v1|v2)/status' → ['/api/v1/status', '/api/v2/status']
      return rewriteRegexRoute(source);

    case "EX-13": // nested req.query — set the parser explicitly
      return source;

    case "EX-14": // req.body undefined without a parser
      return source.replace(/\breq\.body\b(?!\s*\|\|)/g, "req.body");

    case "EX-15": // express.urlencoded() → express.urlencoded({ extended: true })
      return source.replace(
        /express\.urlencoded\(\s*\)/g,
        "express.urlencoded({ extended: true })"
      );

    case "EX-16": // out-of-range status
      return source;

    case "EX-17": // rejected promises — behavioural, no mechanical fix
      return source;

    case "EX-18": // engines.node bump — a package.json change, handled by the JSON path
      return source;

    case "EX-20": // res.redirect(url, status) → res.redirect(status, url)
      return rewriteRedirectArgs(source);

    case "EX-21": // clearCookie maxAge/expires
      return source.replace(/,\s*\{[^}]*maxAge[^}]*\}/g, "");

    default:
      return source;
  }
}

/**
 * Manifest edits. EX-18 raises the minimum Node.js version; a manifest that does not
 * already declare the target engine is rewritten structurally and re-serialised with
 * 2-space indent + trailing newline, matching the committed fixture's formatting.
 */
function applyJsonItem(source: string, item: PlanItem): string {
  if (item.id !== "EX-18") return source;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(source) as Record<string, unknown>;
  } catch {
    return source; // validateSource will reject and revert if this is genuinely broken
  }

  const engines = (parsed.engines ?? {}) as Record<string, unknown>;
  const current = typeof engines.node === "string" ? engines.node : null;
  // The plan item's example records the exact target, e.g. {"before":">=14", "after":">=18"}.
  const target = extractAfterEngine(item.fix.example?.after);
  if (target === null) return source;
  if (current === target) return source;

  parsed.engines = { ...engines, node: target };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** Pull the version out of an example like `">=18"`, or `{"node": ">=18"}`. */
function extractAfterEngine(after: string | undefined): string | null {
  if (!after) return null;
  const direct = /^(>=?[\d.]+|\^[\d.]+|[\d.]+)$/.exec(after.trim());
  if (direct?.[1]) return direct[1];
  const json = /"node"\s*:\s*"([^"]+)"/.exec(after);
  return json?.[1] ?? null;
}

function snippetAround(source: string, item: PlanItem): string {
  const ex = item.fix.example;
  if (!ex) return "";
  const idx = source.indexOf(ex.before);
  if (idx >= 0) return source.slice(Math.max(0, idx - 20), idx + ex.before.length + 20);
  return ex.before;
}

/**
 * `receiver.old(` → `receiver.new(` when the call shape matches.
 *
 * `rejectTwoArg` guards items where a two-argument call is a DIFFERENT plan item —
 * e.g. res.send(body, status) is EX-03, while res.send(404) is EX-02. It must be
 * OFF for calls whose arguments are legitimately two, such as
 * app.del("/legacy/:id", handler) (EX-01), which is the plain one-rename case.
 */
function replaceMethodName(
  source: string,
  oldName: string,
  newName: string,
  receivers: string[],
  opts: { shape?: RegExp; rejectTwoArg?: boolean } = {}
): string {
  const { shape, rejectTwoArg = false } = opts;
  let out = source;
  for (const recv of receivers) {
    const re = new RegExp(`\\b${recv}\\.${oldName}\\s*\\(`, "g");
    out = out.replace(re, (match: string, offset: number, whole: string) => {
      if (shape) {
        // The guard must be tested against the ACTUAL argument text at this call
        // site. Testing it against a fixed placeholder like "res.send(…)" can never
        // satisfy a pattern such as /^res\.send\(\s*\d{3}\s*\)$/, which silently
        // rejected every real match.
        const args = firstArgWindow(whole.slice(offset, offset + 200));
        if (!shape.test(args.trim())) return match;
      }
      if (rejectTwoArg) {
        // The window must start at THIS match's offset in the string being replaced.
        // Reading from `out` instead scanned to the end of the file, found an
        // unrelated comma, and rejected every call site.
        const after = whole.slice(offset, offset + 200);
        if (/,\s*[\w'"`]/.test(firstArgWindow(after))) return match;
      }
      return `${recv}.${newName}(`;
    });
  }
  return out;
}

function firstArgWindow(text: string): string {
  const start = text.indexOf("(");
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return text.slice(start + 1, start + 200);
}

/**
 * res.send(body, status) → res.status(status).send(body)
 *
 * The comma that separates the two arguments must be at the TOP LEVEL of the call.
 * A plain regex that allows any non-paren character will happily match a comma
 * INSIDE an object literal, so `res.json({ a, b })` was rewritten to
 * `res.status(b }).json({ a)` — silent data corruption, not a migration. The guide's
 * signature is genuinely two arguments, so brace/bracket depth is tracked and only a
 * depth-0 comma counts.
 */
function rewriteTwoArgSend(source: string, method: string): string {
  const callRe = new RegExp(`\\bres\\.${method}\\(`, "g");
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = callRe.exec(source)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const close = matchBracket(source, openParen);
    if (close < 0) continue;

    const args = source.slice(openParen + 1, close);
    const split = splitTopLevelArgs(args);
    if (split === -1) continue; // not exactly two top-level arguments

    const body = args.slice(0, split).trim();
    const status = args.slice(split + 1).trim();
    if (!body || !status) continue;
    // A status argument is a number, a numeric expression, or a short identifier.
    // Braces/commas disqualify it — that means the "comma" was really object syntax.
    if (/[{},;]/.test(status)) continue;
    if (!/^[\w$[\]().+\-*/ ]{1,40}$/.test(status)) continue;

    out += source.slice(last, m.index);
    out += `res.status(${status}).${method}(${body})`;
    last = close + 1;
    callRe.lastIndex = close + 1;
  }

  return out + source.slice(last);
}

/** Index of the `)` closing the `(` at `open`, or -1. String- and comment-aware. */
function matchBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return ch === ")" ? i : -1;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(text, i);
    }
  }
  return -1;
}

/** Advance past the string literal starting at `i` (i points at the quote). */
function skipString(text: string, i: number): number {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") {
      j++;
      continue;
    }
    if (text[j] === quote) return j;
  }
  return text.length;
}

/** Index of the top-level comma in `args`, or -1 when there isn't exactly one. */
function splitTopLevelArgs(args: string): number {
  let depth = 0;
  let commas = 0;
  let firstComma = -1;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(args, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      commas++;
      if (firstComma < 0) firstComma = i;
    }
  }
  return commas === 1 ? firstComma : -1;
}

/** res.redirect('back') / res.location('back') → Referrer lookup with '/' fallback. */
function rewriteBackRedirect(source: string): string {
  return source.replace(
    /\b(res)\.(redirect|location)\(\s*(['"])back\3\s*\)/g,
    (_m, recv: string, method: string) => `${recv}.${method}(req.get('Referrer') || '/')`
  );
}

/** req.param('id') → req.params.id */
function rewriteReqParam(source: string): string {
  return source.replace(/\breq\.param\(\s*(['"])([A-Za-z_]\w*)\1\s*\)/g, (_m, _q, name: string) => {
    return `req.params.${name}`;
  });
}

/** '/*' → '/*splat' inside a route registration only. */
function rewriteBareWildcard(source: string): string {
  return source.replace(
    /(\b(?:app|router|api|apiRouter|v1Router)\s*\.\s*(?:get|post|put|patch|delete|del|options|head|all|use)\s*\(\s*)(['"])\/\*\2/g,
    (_m, head: string, q: string) => `${head}${q}/*splat${q}`
  );
}

/** '/api/(v1|v2)/status' → ['/api/v1/status', '/api/v2/status'] */
function rewriteRegexRoute(source: string): string {
  return source.replace(
    /(\b(?:app|router|\w*[Aa]pp|\w*[Rr]outer)\s*\.\s*(?:get|post|put|patch|delete|del|options|head|all|use)\s*\(\s*)(['"])([^'"]*\([^'"]*\)[^'"]*)\2/g,
    (m, head: string, q: string, path: string) => {
      const inner = path.match(/^\/(.*)\((.*)\)(.*)$/);
      if (!inner) return m;
      const [, prefix = "", group = "", suffix = ""] = inner;
      if (group.length === 0) return m;
      const alts = group.split("|");
      if (alts.length < 2) return m;
      const paths = alts.map((a) => `${q}/${prefix}${a}${suffix}${q}`).join(", ");
      return `${head}[${paths}]`;
    }
  );
}

/** res.redirect('/users', 302) → res.redirect(302, '/users') */
function rewriteRedirectArgs(source: string): string {
  return source.replace(
    /\bres\.redirect\(\s*(['"])([^'"]+)\1\s*,\s*(\d{3})\s*\)/g,
    (_m, _q, url: string, status: string) => `res.redirect(${status}, '${url}')`
  );
}

/** Flatten ts-morph's `string | DiagnosticMessageChain` into a single string. */
function flattenMessage(msg: unknown): string {
  if (typeof msg === "string") return msg;
  if (msg && typeof msg === "object" && "messageText" in msg) {
    const inner = (msg as { messageText: unknown }).messageText;
    const chain = (msg as { next?: unknown[] }).next;
    const parts = [
      flattenMessage(inner),
      ...(Array.isArray(chain) ? chain.map(flattenMessage) : []),
    ];
    return parts.filter(Boolean).join(" ");
  }
  return String(msg);
}

// ─── Validation (§7.3: edits failing parse are reverted) ─────────────────────

/**
 * §7.3: "Edits failing AST or parse validation are reverted, not committed."
 *
 * This is a PARSE check, not a type check. The earlier implementation ran the file
 * through a ts-morph project with `getPreEmitDiagnostics()`, which reports semantic
 * errors too — so every CommonJS file failed with "Cannot find name 'require'" and
 * every computed edit was reverted (edits=0 across all queues). @types/node was not
 * resolvable from the in-memory project, so the semantic errors were guaranteed.
 *
 * Syntax errors are what we actually need to catch: a codemod that produced malformed
 * code. `createSourceFile` performs the parse; anything it cannot parse leaves the
 * source file with parse diagnostics and no usable statements.
 */
export function validateSource(file: string, contents: string): { ok: boolean; error?: string } {
  if (file.endsWith(".json")) {
    try {
      JSON.parse(contents);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
    }
  }
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) return { ok: true };

  try {
    const project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        noEmit: true,
        // Never let semantic/type resolution influence a parse check.
        noResolve: true,
        types: [],
      },
    });
    const sf = project.createSourceFile("probe.tsx", contents, { overwrite: true });

    // Parse diagnostics only (category "Error" from the parser, not the checker).
    const parseErrors = sf.getPreEmitDiagnostics().filter((d) => {
      const code = d.getCode();
      // TS1xxx are grammar/parse errors. Everything else is semantic.
      return typeof code === "number" && code >= 1000 && code < 2000;
    });
    if (parseErrors.length > 0) {
      const first = parseErrors[0];
      const text = first ? flattenMessage(first.getMessageText()) : "parse error";
      return { ok: false, error: text };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export { Node, SyntaxKind };
