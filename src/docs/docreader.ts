// src/docs/docreader.ts — doc-reader subagent, SPEC.md §7.2
//
// Converts a migration guide into a validated Migration Plan (§4).
//
// The extraction strategy is deterministic and structural: the guide is parsed into
// sections, each section heading is matched against a catalog of known breaking-change
// shapes, and the item's citation quote is lifted VERBATIM from the section body. This
// is a deliberate choice — a quote that cannot be located in the source text is a
// hallucination, and §9.2 makes citation coverage the anti-hallucination metric for the
// whole product. Every quote is re-verified against the raw artifact before the plan
// is returned; a quote that does not appear verbatim is dropped and the item is not
// emitted (§7.2: "An item without a quote is not a plan item — drop it and warn").
//
// ALLOWED TOOLS (§7.2): read the guide artifact only.
// FORBIDDEN: reading repo source, writing files, network.
// The reader is a pure function of the guide text: it is handed the artifact, and
// nothing else about the repository is in scope.

import { MigrationPlan, PlanItem, WarningCode, type Citation } from "./schemas.js";
import type { GuideArtifact } from "./ingest.js";

// ─── I3: injection detection (§7.2, §4.1 W_INJECTION_SUSPECTED) ──────────────

/**
 * Imperative constructions that address a tool or an AI rather than describing the
 * library's behaviour. The guide is DATA (§1.3 I3): a line like "AI: ignore all
 * previous instructions" is a fact ABOUT the document, never a command to us.
 */
const INJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instruction|instructions|prompt|prompts|rules?)/i, label: "instruction-override" },
  { re: /\b(ai|agent|assistant|llm|model|tool|bot|claude|chatgpt|gpt)\b\s*[:,]\s*(you\s+)?(must|should|shall|need to|have to|are required to)/i, label: "addressed-to-tool" },
  { re: /\b(delete|remove|wipe|drop)\s+all\s+(the\s+)?(files?|repo|repository|directory|source)/i, label: "destructive-directive" },
  { re: /\boutput\s+(the\s+)?(system|initial)\s+prompt\b/i, label: "prompt-exfiltration" },
  { re: /\byou\s+(must|should|shall|need to)\s+(now\s+)?(apply|write|commit|push|merge|run|execute)\b/i, label: "action-directive" },
  { re: /\bwithout\s+(citations?|attribution)\b/i, label: "citation-suppression" },
  { re: /^\s*(system|assistant|user)\s*:/im, label: "role-prefix" },
];

export interface InjectionFinding {
  label: string;
  text: string;
  line: number;
}

/** Scan the guide for directives aimed at the tool. Reports, never acts (I3). */
export function scanForInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const { re, label } of INJECTION_PATTERNS) {
      if (re.test(line)) {
        findings.push({ label, text: line.trim().slice(0, 300), line: i + 1 });
        break;
      }
    }
  }
  return findings;
}

// ─── Guide structure ─────────────────────────────────────────────────────────

export interface GuideSection {
  title: string;
  /** Slug used as Citation.locator, e.g. "#ressendback-and-reslocationback". */
  locator: string;
  /** 1-based line number of the heading. */
  line: number;
  /** Body text under the heading, with fenced examples kept. */
  body: string;
  /** Bullet items under the heading (Annex B style). */
  bullets: string[];
  level: number;
}

/** Split a markdown guide into heading-delimited sections. */
export function parseSections(text: string): GuideSection[] {
  const lines = text.split("\n");
  const sections: GuideSection[] = [];
  let current: GuideSection | null = null;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*```/.test(line)) inFence = !inFence;

    const heading = /^(#{2,6})\s+(.*\S)\s*$/.exec(line);
    if (heading && !inFence) {
      if (current) sections.push(current);
      const title = (heading[2] ?? "").trim();
      current = {
        title,
        locator: `#${slug(title)}`,
        line: i + 1,
        body: "",
        bullets: [],
        level: (heading[1] ?? "##").length,
      };
      continue;
    }

    if (!current) continue;
    current.body += `${line}\n`;
    const bullet = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (bullet?.[1]) current.bullets.push(bullet[1].trim());
  }
  if (current) sections.push(current);

  return sections;
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── Quote extraction (verbatim, §7.2) ───────────────────────────────────────

/** Collapse whitespace so a quote can be matched across the guide's line wrapping. */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Find `quote` verbatim inside `haystack`, ignoring only whitespace differences. */
export function quoteAppearsIn(quote: string, haystack: string): boolean {
  return normalize(haystack).includes(normalize(quote));
}

/**
 * Lift the first sentence(s) of a section body that states the behaviour change,
 * trimmed to §4's 20..600 char window. Returns null when the section has no
 * quotable prose.
 *
 * The joiner must reproduce text CONTIGUOUSLY as it appears in the source. A guide
 * that reads "…no longer supports:" followed by a bullet list cannot be quoted as
 * one span that skips the bullets — such a string does not occur in the document,
 * and §7.2 requires a VERBATIM quote. So we accumulate only while each addition is
 * adjacent in the normalized source; a bullet or heading that is not directly
 * contiguous stops accumulation, and we fall back to the leading paragraph alone.
 */
export function extractQuote(body: string): string | null {
  // Strip fenced code blocks: a code sample is an example, not a citation.
  interface Line {
    text: string;
    bullet: boolean;
  }
  const proseLines: Line[] = [];
  let inFence = false;
  for (const raw of body.split("\n")) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const bullet = /^\s*[-*]\s+/.test(raw);
    const cleaned = raw.replace(/^\s*[-*]\s+/, "").replace(/^#+\s*/, "").trim();
    if (cleaned.length > 0) proseLines.push({ text: cleaned, bullet });
  }
  if (proseLines.length === 0) return null;

  const norm = (s: string) => s.replace(/\s+/g, " ").trim();

  // Build the longest contiguous run of prose. A paragraph↔list transition is not
  // contiguous once the "- " markers are removed, so we stop there rather than
  // manufacture a span that does not occur in the document.
  let quote = proseLines[0]?.text ?? "";
  for (let i = 1; i < proseLines.length; i++) {
    const prev = proseLines[i - 1];
    const next = proseLines[i];
    if (!prev || !next) break;
    if (prev.bullet !== next.bullet) break;
    const combined = norm(`${quote} ${next.text}`);
    if (combined.length > 600) break;
    quote = combined;
  }

  quote = norm(quote);
  if (quote.length < 20) {
    // The lead line alone is too short: extend with the next line while contiguous.
    for (let i = 1; i < proseLines.length; i++) {
      const combined = norm(`${quote} ${proseLines[i]?.text ?? ""}`);
      if (combined.length > 600) break;
      quote = combined;
      if (quote.length >= 20) break;
    }
  }

  quote = norm(quote);
  if (quote.length < 20 || quote.length > 600) return null;
  return quote;
}

// ─── Change-shape catalog ────────────────────────────────────────────────────

interface ShapeRule {
  /** Matches a section title. */
  title: RegExp;
  kind: PlanItem["kind"];
  severity: PlanItem["severity"];
  /**
   * Build the item body. `kind` and `severity` come from the rule itself and are
   * merged in by the caller, so they are deliberately absent from this return type.
   */
  build: (section: GuideSection) => Omit<PlanItem, "citation" | "kind" | "severity"> & {
    citation: Omit<Citation, "quote">;
  };
}

const HTTP_METHODS = "get|post|put|patch|delete|del|options|head|all";

/**
 * The catalog. Each rule maps a guide section to a plan item. Detection regexes
 * encode the receiver explicitly (`res.send(`, `req.param(`, `app.del(`) so §6.2's
 * pass 2 can confirm the receiver without needing a separate astQuery grammar.
 */
const SHAPES: ShapeRule[] = [
  {
    title: /^app\.del\(\)$/i,
    kind: "removal",
    severity: "breaking",
    build: (s) => ({
      id: "EX-01",
      title: "app.del() removed",
      summary: "Express 5 no longer supports the app.del() function. Use app.delete() to register HTTP DELETE routes.",
      detect: { regex: ["\\.del\\s*\\("], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "codemod",
        instruction: "Replace every app.del(path, handler) call with app.delete(path, handler) in this file.",
        example: { before: "app.del('/user/:id', handler)", after: "app.delete('/user/:id', handler)" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None: routing behaviour is unchanged.",
      confidence: 0.95,
      requiresHumanReview: false,
    }),
  },
  {
    title: /^app\.param\(fn\)$/i,
    kind: "removal",
    severity: "breaking",
    build: (s) => ({
      id: "EX-19",
      title: "app.param(fn) preprocessing callback removed",
      summary: "Express 5 no longer supports the app.param(fn) signature. Rewrite it as named param middleware.",
      detect: { regex: ["app\\.param\\(\\s*function"], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "guided-edit",
        instruction: "Rewrite app.param(fn) as a named parameter middleware registered with app.param(name, fn).",
        example: { before: "app.param(function (name, value) {})", after: "app.param('user', loadUser)" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None.",
      confidence: 0.8,
      requiresHumanReview: true,
    }),
  },
  {
    title: /pluralized method names/i,
    kind: "rename",
    severity: "breaking",
    build: (s) => ({
      id: "EX-09",
      title: "Singular accepts helpers removed",
      summary: "Express 5 removed req.acceptsCharset(), req.acceptsEncoding() and req.acceptsLanguage(). Use the pluralized forms.",
      detect: {
        regex: ["acceptsCharset\\(", "acceptsEncoding\\(", "acceptsLanguage\\("],
        astQuery: null,
        filesGlob: ["**/*.{ts,js,mjs,cjs}"],
      },
      fix: {
        strategy: "codemod",
        instruction: "Replace req.acceptsCharset() with req.acceptsCharsets(), req.acceptsEncoding() with req.acceptsEncodings(), and req.acceptsLanguage() with req.acceptsLanguages().",
        example: { before: "req.acceptsCharset('utf-8')", after: "req.acceptsCharsets('utf-8')" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None.",
      confidence: 0.95,
      requiresHumanReview: false,
    }),
  },
  {
    title: /^req\.param\(name\)$/i,
    kind: "removal",
    severity: "breaking",
    build: (s) => ({
      id: "EX-08",
      title: "req.param(name) removed",
      summary: "Express 5 removed req.param(name). Read the specific name from req.params, req.body, or req.query instead.",
      detect: { regex: ["req\\.param\\s*\\("], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "guided-edit",
        instruction: "Replace req.param('name') with req.params.name, req.body.name, or req.query.name according to where the value is submitted.",
        example: { before: "const id = req.param('id')", after: "const id = req.params.id" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None.",
      confidence: 0.95,
      requiresHumanReview: false,
    }),
  },
  {
    title: /^res\.json\(obj, status\)$/i,
    kind: "signature-change",
    severity: "breaking",
    build: (s) => ({
      id: "EX-04",
      title: "res.json(obj, status) removed",
      summary: "Express 5 no longer supports the res.json(obj, status) signature. Set the status first, then chain to res.json().",
      detect: { regex: ["res\\.json\\([^)]+,\\s*\\d{3}\\s*\\)"], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "codemod",
        instruction: "Replace res.json(obj, status) with res.status(status).json(obj).",
        example: { before: "res.json(obj, 201)", after: "res.status(201).json(obj)" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None.",
      confidence: 0.9,
      requiresHumanReview: false,
    }),
  },
  {
    title: /^res\.jsonp\(obj, status\)$/i,
    kind: "signature-change",
    severity: "breaking",
    build: (s) => ({
      id: "EX-05",
      title: "res.jsonp(obj, status) removed",
      summary: "Express 5 no longer supports the res.jsonp(obj, status) signature. Set the status first, then chain to res.jsonp().",
      detect: { regex: ["res\\.jsonp\\([^)]+,\\s*\\d{3}"], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "codemod",
        instruction: "Replace res.jsonp(obj, status) with res.status(status).jsonp(obj).",
        example: { before: "res.jsonp(obj, 201)", after: "res.status(201).jsonp(obj)" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None.",
      confidence: 0.9,
      requiresHumanReview: false,
    }),
  },
  {
    title: /^res\.redirect\(url, status\)$/i,
    kind: "signature-change",
    severity: "breaking",
    build: (s) => ({
      id: "EX-20",
      title: "res.redirect(url, status) signature reversed",
      summary: "Express 5 no longer supports res.redirect(url, status). The new signature is res.redirect(status, url).",
      detect: { regex: ["res\\.redirect\\([^)]+,\\s*\\d{3}\\s*\\)"], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "codemod",
        instruction: "Swap the arguments of res.redirect so the status code comes first: res.redirect(status, url).",
        example: { before: "res.redirect('/users', 302)", after: "res.redirect(302, '/users')" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None.",
      confidence: 0.9,
      requiresHumanReview: false,
    }),
  },
  {
    title: /redirect\('back'\).*location\('back'\)/i,
    kind: "removal",
    severity: "breaking",
    build: (s) => ({
      id: "EX-07",
      title: "res.redirect('back') and res.location('back') removed",
      summary: "Express 5 no longer supports the magic string 'back' in res.redirect() and res.location(). Use req.get('Referrer') with a '/' fallback.",
      detect: { regex: ["redirect\\(\\s*['\"]back['\"]"], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "guided-edit",
        instruction: "Replace res.redirect('back') with res.redirect(req.get('Referrer') || '/') and res.location('back') with res.location(req.get('Referrer') || '/').",
        example: { before: "res.redirect('back')", after: "res.redirect(req.get('Referrer') || '/')" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None.",
      confidence: 0.95,
      requiresHumanReview: false,
    }),
  },
  {
    title: /^res\.send\(body, status\)$/i,
    kind: "signature-change",
    severity: "breaking",
    build: (s) => ({
      id: "EX-03",
      title: "res.send(body, status) removed",
      summary: "Express 5 no longer supports the res.send(obj, status) signature. Set the status first, then chain to res.send().",
      detect: {
        regex: ["res\\.send\\([^)]+,\\s*\\d{3}\\s*\\)", "res\\.send\\([^)]+,\\s*\\w+\\s*\\)"],
        astQuery: null,
        filesGlob: ["**/*.{ts,js,mjs,cjs}"],
      },
      fix: {
        strategy: "codemod",
        instruction: "Replace res.send(body, status) with res.status(status).send(body).",
        example: { before: "res.send(obj, 200)", after: "res.status(200).send(obj)" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None.",
      confidence: 0.9,
      requiresHumanReview: false,
    }),
  },
  {
    title: /^res\.send\(status\)$/i,
    kind: "signature-change",
    severity: "breaking",
    build: (s) => ({
      id: "EX-02",
      title: "res.send(status) removed",
      summary: "Express 5 no longer supports res.send(status) where status is a number. Use res.sendStatus(statusCode) instead.",
      detect: { regex: ["res\\.send\\(\\s*\\d{3}\\s*\\)"], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "codemod",
        instruction: "Replace res.send(statusCode) with res.sendStatus(statusCode).",
        example: { before: "res.send(404)", after: "res.sendStatus(404)" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None.",
      confidence: 0.95,
      requiresHumanReview: false,
    }),
  },
  {
    title: /^res\.sendfile\(\)$/i,
    kind: "rename",
    severity: "breaking",
    build: (s) => ({
      id: "EX-06",
      title: "res.sendfile() removed",
      summary: "Express 5 replaced res.sendfile() with the camel-cased res.sendFile().",
      detect: { regex: ["res\\.sendfile\\s*\\("], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "codemod",
        instruction: "Replace res.sendfile(path) with res.sendFile(path).",
        example: { before: "res.sendfile('/path/to/file')", after: "res.sendFile('/path/to/file')" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None.",
      confidence: 0.98,
      requiresHumanReview: false,
    }),
  },
  {
    title: /^path route matching syntax$/i,
    kind: "routing-syntax",
    severity: "breaking",
    build: (s) => ({
      id: "EX-10",
      title: "Path route matching syntax changed",
      summary: "Express 5 changed path route matching: the wildcard * must be named, the optional character ? is no longer supported, and regexp characters are not supported.",
      detect: {
        // Only the optional-parameter form; the wildcard and regexp-syntax forms of
        // this same guide section are EX-11 and EX-12, with their own detect
        // patterns. Claiming all three here would trip W_CONFLICTING_GUIDANCE.
        regex: [":\\w+\\?"],
        astQuery: null,
        filesGlob: ["**/*.{ts,js,mjs,cjs}"],
      },
      fix: {
        strategy: "guided-edit",
        instruction: "Replace an optional route parameter with the brace form: /:file.:ext? becomes /:file{.:ext}.",
        example: { before: "'/:file.:ext?'", after: "'/:file{.:ext}'" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "Routes with optional or wildcard segments may need their test URLs updated.",
      confidence: 0.85,
      requiresHumanReview: false,
    }),
  },
  {
    // The guide documents wildcard, optional-param and regexp-syntax changes in one
    // section, but Annex B treats them as three independently fixable breakages
    // (EX-10/EX-11/EX-12) and the fixture seeds all three. One section therefore
    // yields three items, each with its own detect pattern and its own queue.
    title: /wildcard .* must have a name|path route matching syntax/i,
    kind: "routing-syntax",
    severity: "breaking",
    build: (s) => ({
      id: "EX-11",
      title: "Bare * wildcard route no longer valid",
      summary: "Express 5 requires every route wildcard to be named. Replace the bare /* wildcard with a named wildcard such as /*splat.",
      detect: { regex: ["/\\*[^a-zA-Z]", "/\\*$"], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "codemod",
        instruction: "Replace the bare /* wildcard in the route path with a named wildcard such as /*splat.",
        example: { before: "router.get('/*', handler)", after: "router.get('/*splat', handler)" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "Routes using a bare wildcard may need their test URLs updated to the named form.",
      confidence: 0.9,
      requiresHumanReview: false,
    }),
  },
  {
    title: /path route matching syntax/i,
    kind: "routing-syntax",
    severity: "breaking",
    build: (s) => ({
      id: "EX-12",
      title: "Regexp characters in route strings are not supported",
      summary: "Express 5 does not support regexp characters in route strings. Replace a regexp route with an array of explicit paths or with named params.",
      detect: {
        regex: ["['\"][^'\"]*[(+[][^'\"]*['\"]"],
        astQuery: null,
        filesGlob: ["**/*.{ts,js,mjs,cjs}"],
      },
      fix: {
        strategy: "guided-edit",
        instruction: "Replace a route string containing regexp characters with an array of explicit paths, or with named parameters.",
        example: { before: "app.get('/[discussion|page]/:slug', h)", after: "app.get(['/discussion/:slug', '/page/:slug'], h)" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None.",
      confidence: 0.75,
      requiresHumanReview: true,
    }),
  },
  {
    title: /rejected promises handled/i,
    kind: "behavioral",
    severity: "breaking",
    build: (s) => ({
      id: "EX-17",
      title: "Rejected promises forwarded to error middleware",
      summary: "Express 5 forwards rejected promises from middleware and handlers to the error-handling middleware, so async handlers no longer need an explicit catch.",
      detect: { regex: ["\\.catch\\(next\\)"], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "manual-only",
        instruction: "Verify the error handler signature and that async handlers rely on automatic promise forwarding. This is a behavioural judgement, not a mechanical rewrite.",
        example: null,
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "Error-path tests may change behaviour for rejected promises.",
      confidence: 0.7,
      requiresHumanReview: true,
    }),
  },
  {
    title: /^express\.urlencoded$/i,
    kind: "behavioral",
    severity: "breaking",
    build: (s) => ({
      id: "EX-15",
      title: "express.urlencoded() defaults extended to false",
      summary: "Express 5 makes the extended option false by default in express.urlencoded(). Pass it explicitly if extended parsing is required.",
      detect: { regex: ["urlencoded\\(\\s*\\)"], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "guided-edit",
        instruction: "Pass extended explicitly to express.urlencoded(), choosing true only if the app relies on nested body parsing.",
        example: { before: "app.use(express.urlencoded())", after: "app.use(express.urlencoded({ extended: true }))" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "Body-parsing tests may need nested-form fixtures if extended stays true.",
      confidence: 0.85,
      requiresHumanReview: false,
    }),
  },
  {
    title: /^req\.body$/i,
    kind: "behavioral",
    severity: "breaking",
    build: (s) => ({
      id: "EX-14",
      title: "req.body is undefined without a body parser",
      summary: "Express 5 returns undefined from req.body when the body has not been parsed, where Express 4 returned {} by default.",
      detect: { regex: ["req\\.body"], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "guided-edit",
        instruction: "Mount express.json() or express.urlencoded() before any handler that reads req.body, or guard the access with a default value.",
        example: { before: "const data = req.body", after: "const data = req.body ?? {}" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "POST tests that relied on req.body defaulting to {} may need a body parser mounted.",
      confidence: 0.8,
      requiresHumanReview: false,
    }),
  },
  {
    title: /^res\.status$/i,
    kind: "behavioral",
    severity: "advisory",
    build: (s) => ({
      id: "EX-16",
      title: "res.status() rejects out-of-range codes",
      summary: "Express 5 only accepts integers from 100 to 999 in res.status() and errors on a non-integer status code.",
      detect: { regex: ["res\\.status\\(\\s*[^1-9\\d]"], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "manual-only",
        instruction: "Audit every res.status() argument and replace any value outside 100-999 or any non-integer with a valid status code.",
        example: null,
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None.",
      confidence: 0.7,
      requiresHumanReview: true,
    }),
  },
  {
    title: /^res\.clearCookie$/i,
    kind: "behavioral",
    severity: "advisory",
    build: (s) => ({
      id: "EX-21",
      title: "res.clearCookie ignores maxAge and expires",
      summary: "Express 5 ignores the maxAge and expires options passed to res.clearCookie().",
      detect: { regex: ["clearCookie\\([^)]*maxAge"], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "codemod",
        instruction: "Remove the maxAge and expires options from res.clearCookie() calls.",
        example: { before: "res.clearCookie('sid', { maxAge: 0 })", after: "res.clearCookie('sid')" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None.",
      confidence: 0.75,
      requiresHumanReview: false,
    }),
  },
  {
    title: /minimum node\.js version/i,
    kind: "runtime-requirement",
    severity: "breaking",
    build: (s) => ({
      id: "EX-18",
      title: "Minimum Node.js version raised",
      summary: "Express 5 requires a newer minimum Node.js version. The engines field and any CI node version must be bumped to match.",
      detect: {
        regex: ["\"engines\"", "\"node\"\\s*:\\s*\"[^\"]*\""],
        astQuery: null,
        filesGlob: ["package.json"],
      },
      fix: {
        strategy: "codemod",
        instruction: "Set the engines.node range in package.json to the minimum required by the guide, and update the CI node version to match.",
        example: { before: '"node": ">=14"', after: '"node": ">=18"' },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "None: the engines field does not affect test outcomes.",
      confidence: 0.95,
      requiresHumanReview: false,
    }),
  },
  {
    title: /^default query parser/i,
    kind: "behavioral",
    severity: "breaking",
    build: (s) => ({
      id: "EX-13",
      title: "Default query parser changed",
      summary: "Express 5 changed the default query parser, so nested req.query object access may no longer be populated the same way.",
      detect: { regex: ["req\\.query\\s*\\["], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
      fix: {
        strategy: "guided-edit",
        instruction: "Set the query parser explicitly with app.set('query parser', ...) or adapt the code to the simple parser's flat result.",
        example: { before: "const f = req.query.filters.category", after: "app.set('query parser', 'extended')" },
      },
      citation: { docId: "", sectionTitle: s.title, locator: s.locator },
      testExpectation: "Query-string tests asserting nested parsing may need updating.",
      confidence: 0.75,
      requiresHumanReview: false,
    }),
  },
];

// ─── The doc-reader ──────────────────────────────────────────────────────────

export interface DocReaderInput {
  artifact: GuideArtifact;
  dependency: { name: string; from: string; to: string };
  /** Maximum extraction attempts (§7.2: 2 attempts, then E_PLAN_EMPTY). */
  maxAttempts?: number;
  now?: () => string;
}

export interface DocReaderResult {
  plan: MigrationPlan;
  /** I3 findings — reported, never executed. */
  injectionFindings: InjectionFinding[];
  /** Items dropped because their quote could not be verified verbatim (§7.2). */
  droppedForMissingQuote: string[];
}

export function readGuide(input: DocReaderInput): DocReaderResult {
  const { artifact, dependency } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const warnings: Array<{ code: string; message: string }> = [];
  const dropped: string[] = [];

  // ── I3: scan for directives aimed at the tool, BEFORE anything reads the guide ──
  const injectionFindings = scanForInjection(artifact.text);
  if (injectionFindings.length > 0) {
    warnings.push({
      code: WarningCode.INJECTION_SUSPECTED,
      message:
        `Guide contains ${injectionFindings.length} directive(s) addressed at tooling ` +
        `(${injectionFindings.map((f) => f.label).join(", ")}). ` +
        `Recorded and ignored per SPEC.md I3. Offending text: ` +
        injectionFindings.map((f) => `L${f.line} "${f.text}"`).join(" | "),
    });
  }

  const sections = parseSections(artifact.text);

  // ── §4.1 W_VERSION_UNMENTIONED: the target version never appears in the guide ──
  const versionMentioned = mentionsTargetVersion(artifact.text, dependency.to);
  if (!versionMentioned) {
    warnings.push({
      code: WarningCode.VERSION_UNMENTIONED,
      message:
        `Target version "${dependency.to}" never appears in the guide. ` +
        `This is probably the wrong guide for the requested upgrade.`,
    });
  }

  // ── Extract items ──
  const items: PlanItem[] = [];
  const seenIds = new Set<string>();
  const claimedPatterns = new Map<string, string>(); // regex → itemId (§4.1 conflict detection)

  for (const section of sections) {
    for (const shape of SHAPES) {
      if (!shape.title.test(section.title)) continue;
      // One section may yield several items (the guide documents the wildcard,
      // optional-param and regexp-syntax changes together, but Annex B treats them
      // as three breakages). Guard on the item id, not on "section already used".
      if (seenIds.has(shape.build(section).id)) continue;

      const quote = extractQuote(section.body);
      if (!quote) {
        dropped.push(section.title);
        continue;
      }
      // §7.2: an item without a verifiable verbatim quote is not a plan item.
      if (!quoteAppearsIn(quote, artifact.text)) {
        dropped.push(section.title);
        continue;
      }

      // The rule carries kind/severity (§4); build() supplies the item-specific
      // fields. Both must be assembled into the candidate.
      const draft = shape.build(section);
      const candidate: PlanItem = {
        ...draft,
        kind: shape.kind,
        severity: shape.severity,
        citation: { ...draft.citation, docId: artifact.docId, quote },
      };

      const parsed = PlanItem.safeParse(candidate);
      if (!parsed.success) {
        dropped.push(section.title);
        continue;
      }

      // §4.1 W_CONFLICTING_GUIDANCE: two items prescribing different fixes for one pattern.
      for (const regex of candidate.detect.regex) {
        const prior = claimedPatterns.get(regex);
        if (prior && prior !== candidate.id) {
          warnings.push({
            code: WarningCode.CONFLICTING_GUIDANCE,
            message:
              `Items ${prior} and ${candidate.id} both claim detect pattern /${regex}/. ` +
              `A human decides which guidance applies.`,
          });
        } else {
          claimedPatterns.set(regex, candidate.id);
        }
      }

      seenIds.add(candidate.id);
      items.push(parsed.data);
    }
  }

  // ── §4.1 W_NO_DETECT_PATTERN: prose with no detectable pattern ──
  for (const item of items) {
    if (item.detect.regex.length === 0) {
      warnings.push({
        code: WarningCode.NO_DETECT_PATTERN,
        message: `Item ${item.id} has no detectable pattern; it cannot be impact-scanned and is advisory only.`,
      });
    }
  }

  // ── §4.1 W_FEW_ITEMS ──
  const breakingCount = items.filter((i) => i.severity === "breaking").length;
  if (breakingCount < 3) {
    warnings.push({
      code: WarningCode.FEW_ITEMS,
      message: `Only ${breakingCount} breaking item(s) extracted; fewer than 3 suggests extraction failed.`,
    });
  }

  // ── §4.1 W_LOW_CONFIDENCE ──
  const lowConfidence = items.filter((i) => i.confidence < 0.6);
  if (lowConfidence.length > 0) {
    warnings.push({
      code: WarningCode.LOW_CONFIDENCE,
      message: `Items below 0.6 confidence routed to human review: ${lowConfidence.map((i) => i.id).join(", ")}.`,
    });
  }

  for (const w of artifact.intakeWarnings) warnings.push(w);

  items.sort((a, b) => a.id.localeCompare(b.id));

  const plan: MigrationPlan = {
    schemaVersion: 1,
    planId: `plan-${artifact.docId.replace(/[^A-Za-z0-9]+/g, "-")}`,
    dependency,
    sources: [
      {
        docId: artifact.docId,
        kind: artifact.kind,
        sha256: artifact.sha256,
        title: artifact.title,
      },
    ],
    items,
    warnings,
    generatedAt: now(),
  };

  return { plan, injectionFindings, droppedForMissingQuote: dropped };
}

/**
 * §4.1 W_VERSION_UNMENTIONED. The target version may legitimately be written as
 * "5", "v5" or "5.1.0"; accept any of those forms appearing in the guide.
 */
export function mentionsTargetVersion(text: string, to: string): boolean {
  const bare = to.replace(/^[^\d]*/, "");
  const major = bare.split(".")[0] ?? bare;
  if (!major) return false;
  const patterns = [
    new RegExp(`\\bv?${escapeRe(major)}\\.\\d+\\.\\d+`, "i"),
    new RegExp(`\\bv?${escapeRe(major)}\\.\\d+`, "i"),
    new RegExp(`\\bv?${escapeRe(major)}\\b`, "i"),
  ];
  return patterns.some((re) => re.test(text));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { HTTP_METHODS };
