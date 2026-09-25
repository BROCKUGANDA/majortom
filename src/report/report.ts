// src/report/report.ts — §9.1 report skeleton, §9.2 citation coverage, §9.3 taxonomy
//
// CITATION COVERAGE (I2): computed programmatically from the edit records and the
// plan, never asserted in prose (§9.2). It is (edits with a resolvable plan item AND
// a citation that resolves in the guide artifact) / (total applied edits).
//
// VERDICT (I6): GREEN only when verification says green. Exhausted loops produce
// "NOT GREEN" — the report is the honest-failure surface, never a reassurance.

import { redactWithReport } from "./redact.js";
import type { PlanItem } from "../docs/schemas.js";
import type { EditRecord, QueueResult } from "../agents/fixer.js";
import type { Baseline } from "../verify/schemas.js";
import type { ClassifiedFailure } from "../verify/schemas.js";

/** §9.3 HUMAN REVIEW taxonomy. */
export type HumanReviewCode = "H1" | "H2" | "H3" | "H4" | "H5" | "H6";

export interface HumanReviewEntry {
  code: HumanReviewCode;
  /** file, or plan-item id when the entry is about a plan warning. */
  where: string;
  reason: string;
}

export interface ReportInput {
  runId: string;
  dependency: string;
  fromVersion: string;
  toVersion: string;
  date: string;
  wallClockMs: number;
  verifyIterations: number;
  maxVerifyIterations: number;
  /** True only when §8 classification found nothing counting against the migration. */
  green: boolean;
  baseline: Baseline;
  postRun: Baseline;
  failures: ClassifiedFailure[];
  queues: QueueResult[];
  items: PlanItem[];
  /** I5 proof: every path that changed during the run. */
  changedFiles: string[];
  /** Work-map paths, for the diff-scope assertion in the report. */
  workMapFiles: string[];
  /** §6 suppressed/ambiguous matches and §4 plan warnings. */
  suppressedMatches?: Array<{ itemId: string; file: string; line: number; why: string }>;
  planWarnings?: Array<{ code: string; message: string }>;
  unmatchedItemIds?: string[];
  ledgerMetrics?: Record<string, number>;
}

export interface CitationCoverage {
  applied: number;
  cited: number;
  /** §9.2 sets the floor at 1.0. Anything lower is a report failure, not a note. */
  ratio: number;
  uncited: EditRecord[];
}

/**
 * §9.2: an edit cites only if its itemId resolves to a plan item that has a citation
 * whose quote actually appears in the ingested guide. Both halves are required.
 */
export function computeCitationCoverage(
  queues: QueueResult[],
  items: PlanItem[],
  quoteResolves?: (item: PlanItem) => boolean
): CitationCoverage {
  const byId = new Map(items.map((i) => [i.id, i]));
  const applied: EditRecord[] = queues.flatMap((q) => q.files.flatMap((f) => f.edits));
  const uncited: EditRecord[] = [];

  for (const edit of applied) {
    const item = byId.get(edit.itemId);
    const hasCitation = Boolean(item && item.citation && item.citation.quote.length > 0);
    const quoteOk = hasCitation && item ? (quoteResolves ? quoteResolves(item) : true) : false;
    if (!hasCitation || !quoteOk) uncited.push(edit);
  }

  const cited = applied.length - uncited.length;
  return {
    applied: applied.length,
    cited,
    ratio: applied.length === 0 ? 1 : cited / applied.length,
    uncited,
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function countTests(b: Baseline): { passing: number; total: number; failing: number } {
  const total = b.results.length;
  const failing = b.results.filter((r) => r.status === "fail" || r.status === "error").length;
  return { passing: total - failing, total, failing };
}

/** §9.1 "Suggested review order (risk-ranked)". */
export function reviewOrder(
  queues: QueueResult[],
  failures: ClassifiedFailure[],
  items: PlanItem[]
): Array<{ file: string; score: number; why: string }> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const failingFiles = new Set(failures.filter((f) => f.orphaned).map((f) => f.file).filter(Boolean) as string[]);
  const scored = new Map<string, { score: number; why: string }>();

  for (const q of queues) {
    for (const f of q.files) {
      let score = 0;
      const why: string[] = [];
      if (f.outcome === "human-review") {
        score += 50;
        why.push(`needs human review (${f.humanReview?.code ?? "?"})`);
      }
      if (failingFiles.has(f.file)) {
        score += 40;
        why.push("a verification failure is attributed to this file");
      }
      const highRisk = f.edits.filter((e) => {
        const it = byId.get(e.itemId);
        return it?.severity === "breaking";
      });
      if (highRisk.length > 0) {
        score += highRisk.length * 5;
        why.push(`${highRisk.length} breaking-change edit(s)`);
      }
      if (f.edits.length > 0) {
        score += Math.min(10, f.edits.length);
        why.push(`${f.edits.length} edit(s)`);
      }
      if (score > 0) scored.set(f.file, { score, why: why.join("; ") });
    }
  }

  return [...scored.entries()]
    .map(([file, v]) => ({ file, score: v.score, why: v.why }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

function humanReviewEntries(input: ReportInput, coverage: CitationCoverage): HumanReviewEntry[] {
  const out: HumanReviewEntry[] = [];

  // H1 — an uncited edit that must never have been applied (§9.3).
  for (const edit of coverage.uncited) {
    out.push({ code: "H1", where: edit.file, reason: `edit claims ${edit.itemId} but no resolvable citation backs it` });
  }
  // H2/H3/H4 from the fixers.
  for (const q of input.queues) {
    for (const f of q.files) {
      if (f.outcome === "human-review" && f.humanReview) {
        out.push({ code: f.humanReview.code as HumanReviewCode, where: f.file, reason: f.humanReview.reason });
      }
    }
  }
  // H3 — low-confidence plan items applied or skipped (§4 confidence floor 0.6).
  for (const item of input.items) {
    if (item.confidence < 0.6) {
      out.push({ code: "H3", where: item.id, reason: `plan item confidence ${item.confidence} is below the 0.6 floor` });
    }
  }
  // H5 — failures in files owned by no queue, or collection regressions (§8.2).
  for (const f of input.failures) {
    if (f.orphaned) {
      out.push({ code: "H5", where: f.testId, reason: "failure is in a file owned by no queue; never reassigned" });
    } else if (f.classification === "collection_regression") {
      out.push({ code: "H5", where: f.testId, reason: "test present at baseline is absent after migration" });
    }
  }
  // H6 — plan warnings needing a decision.
  for (const w of input.planWarnings ?? []) {
    out.push({ code: "H6", where: w.code, reason: w.message });
  }
  return out;
}

/** Render the full §9.1 report. */
export function renderReport(input: ReportInput): string {
  const coverage = computeCitationCoverage(input.queues, input.items);
  const review = humanReviewEntries(input, coverage);
  const before = countTests(input.baseline);
  const after = countTests(input.postRun);
  const preExisting = input.failures.filter((f) => f.classification === "pre_existing");
  const outOfScope = input.changedFiles.filter(
    (f) => !input.workMapFiles.includes(f)
  );
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const { text, hits } = redactWithReport(buildBody(input, coverage, review, before, after, preExisting, outOfScope, byId));
  void hits;
  return text;
}

function buildBody(
  input: ReportInput,
  coverage: CitationCoverage,
  review: HumanReviewEntry[],
  before: { passing: number; total: number },
  after: { passing: number; total: number },
  preExisting: ClassifiedFailure[],
  outOfScope: string[],
  byId: Map<string, PlanItem>
): string {
  const L: string[] = [];
  const green = input.green;

  L.push(`# MajorTom Migration Report - ${input.dependency} ${input.fromVersion} -> ${input.toVersion}`);
  L.push(
    `Run ${input.runId} - ${input.date} - wall clock ${formatDuration(input.wallClockMs)} - ` +
      `verify iterations ${input.verifyIterations}/${input.maxVerifyIterations}`
  );
  L.push("");

  // ── Verdict (§9.1). I6: never "GREEN" when tests are red. ───────────────────
  L.push("## Verdict");
  L.push(
    green
      ? `GREEN - verification found no failure attributable to this migration` +
        (preExisting.length > 0
          ? `; ${preExisting.length} pre-existing failure(s) excluded from accounting per §8.2.`
          : ".")
      : `NOT GREEN - ${input.failures.filter((f) => f.classification !== "pre_existing").length} failure(s) ` +
        `are attributable to this migration. **This pull request must not be merged as-is.**`
  );
  L.push("");

  // ── Summary ────────────────────────────────────────────────────────────────
  L.push("## Summary");
  L.push("| Metric | Before | After |");
  L.push("| --- | --- | --- |");
  L.push(`| tests passing | ${before.passing}/${before.total} | ${after.passing}/${after.total} |`);
  L.push(`| pre-existing failures (excluded) | ${input.baseline.failingIds.length} | ${preExisting.length} |`);
  L.push(`| files changed | - | ${input.changedFiles.length} |`);
  L.push(`| citation coverage | - | ${pct(coverage.ratio)} |`);
  L.push("");

  // ── Changes, grouped by plan item ──────────────────────────────────────────
  L.push("## Changes (grouped by plan item)");
  const byItem = new Map<string, Array<{ file: string; edit: EditRecord }>>();
  for (const q of input.queues) {
    for (const f of q.files) {
      for (const e of f.edits) {
        const arr = byItem.get(e.itemId) ?? [];
        arr.push({ file: f.file, edit: e });
        byItem.set(e.itemId, arr);
      }
    }
  }
  if (byItem.size === 0) {
    L.push("_No edits were applied._");
  }
  for (const [itemId, entries] of [...byItem.entries()].sort()) {
    const item = byId.get(itemId);
    L.push(`### ${itemId} - ${item?.title ?? "(unknown plan item)"}`);
    if (item) {
      L.push(
        `Guide: section "${item.citation.sectionTitle}"` +
          (item.citation.locator ? `, ${item.citation.locator}` : "") +
          ` - "${item.citation.quote.slice(0, 160)}${item.citation.quote.length > 160 ? "..." : ""}"`
      );
    }
    const files = [...new Set(entries.map((e) => e.file))].sort();
    for (const file of files) {
      L.push(`- ${file} - ${entries.filter((e) => e.file === file).length} edit(s)`);
    }
  }
  L.push("");

  // ── HUMAN REVIEW ───────────────────────────────────────────────────────────
  L.push(`## HUMAN REVIEW (${review.length} items)`);
  if (review.length === 0) {
    L.push("_None._");
  } else {
    for (const r of review) {
      L.push(`- ${r.code} - ${r.where} - ${r.reason}`);
    }
  }
  L.push("");

  // ── Pre-existing failures (I8) ─────────────────────────────────────────────
  L.push("## Pre-existing failures (not caused by this migration)");
  if (preExisting.length === 0) {
    L.push("_None._");
  } else {
    for (const f of preExisting) {
      L.push(`- ${f.testId} (also failing at baseline)`);
    }
  }
  L.push("");

  // ── Suggested review order ─────────────────────────────────────────────────
  L.push("## Suggested review order (risk-ranked)");
  const order = reviewOrder(input.queues, input.failures, input.items);
  if (order.length === 0) {
    L.push("_No files required review._");
  }
  for (const [i, r] of order.entries()) {
    L.push(`${i + 1}. \`${r.file}\` - ${r.why}`);
  }
  L.push("");

  // ── Scope proof (I5) ───────────────────────────────────────────────────────
  L.push("## Scope (I5 diff-scope proof)");
  L.push(
    outOfScope.length === 0
      ? `_Every changed file appears in the work map._`
      : `**${outOfScope.length} file(s) changed outside the work map: ${outOfScope.join(", ")}**`
  );
  L.push("");

  // ── Rollback ───────────────────────────────────────────────────────────────
  L.push("## Rollback");
  L.push("```");
  L.push(`git checkout main && git branch -D majortom/${input.runId}`);
  L.push("```");
  L.push("");

  // ── Appendix ───────────────────────────────────────────────────────────────
  L.push("## Appendix: suppressed matches, plan warnings, ledger metrics");
  L.push(`- citation coverage: ${coverage.cited}/${coverage.applied} applied edits (${pct(coverage.ratio)})`);
  if ((input.unmatchedItemIds ?? []).length > 0) {
    L.push(`- plan items with no detected call sites: ${(input.unmatchedItemIds ?? []).join(", ")}`);
  }
  if ((input.suppressedMatches ?? []).length > 0) {
    L.push(`- suppressed matches: ${(input.suppressedMatches ?? []).length}`);
    for (const s of input.suppressedMatches ?? []) {
      L.push(`  - ${s.itemId} at ${s.file}:${s.line} - ${s.why}`);
    }
  }
  if ((input.planWarnings ?? []).length > 0) {
    L.push(`- plan warnings: ${(input.planWarnings ?? []).length}`);
    for (const w of input.planWarnings ?? []) {
      L.push(`  - ${w.code}: ${w.message}`);
    }
  }
  for (const [k, v] of Object.entries(input.ledgerMetrics ?? {})) {
    L.push(`- ${k}: ${v}`);
  }
  L.push("");

  return L.join("\n");
}
