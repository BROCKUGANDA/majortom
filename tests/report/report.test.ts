// tests/report/report.test.ts
// Phase 7 acceptance tests (SPEC.md §9, I1, I2, I6)

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

import { MigrationPlan, type PlanItem } from "../../src/docs/schemas.js";
import { redact, redactWithReport, REDACTED } from "../../src/report/redact.js";
import { renderReport, computeCitationCoverage, reviewOrder } from "../../src/report/report.js";
import {
  assertNotProtected,
  branchNameFor,
  commitMessageFor,
  prOptions,
  ProtectedBranchError,
  PROTECTED_BRANCHES,
} from "../../src/report/git.js";
import type { QueueResult, EditRecord } from "../../src/agents/fixer.js";
import type { Baseline, ClassifiedFailure } from "../../src/verify/schemas.js";

const plan = MigrationPlan.parse(
  JSON.parse(readFileSync(resolve("tests/fixtures/canned-plan.json"), "utf8"))
);

function baseline(results: Array<[string, "pass" | "fail"]>): Baseline {
  return {
    runner: "vitest",
    command: "npx vitest run",
    exitCode: 0,
    totalMs: 10,
    results: results.map(([id, status]) => ({
      id,
      status,
      durationMs: 1,
      message: status === "fail" ? "x" : null,
    })),
    failingIds: results.filter(([, s]) => s === "fail").map(([id]) => id),
    collectionErrors: [],
  };
}

function edit(itemId: string, file = "src/routes/users.js"): EditRecord {
  return { file, itemId, before: "a", after: "b", citationRef: "loc", attempt: 1 };
}

function queueResult(over: Partial<QueueResult> = {}): QueueResult {
  return {
    queueId: "q1",
    files: [],
    scopeViolations: [],
    durationMs: 10,
    iterations: 1,
    ...over,
  };
}

const baseInput = {
  runId: "01M3CSNT41F001",
  dependency: "express",
  fromVersion: "4.18.2",
  toVersion: "5.1.0",
  date: "2026-09-25",
  wallClockMs: 41 * 60 * 1000 + 12 * 1000,
  verifyIterations: 2,
  maxVerifyIterations: 3,
  baseline: baseline([
    ["a::t1", "pass"],
    ["a::t2", "fail"],
  ]),
  postRun: baseline([
    ["a::t1", "pass"],
    ["a::t2", "fail"],
  ]),
  failures: [
    {
      testId: "a::t2",
      classification: "pre_existing",
      message: "boom",
      file: null,
      queueId: null,
      orphaned: false,
      assertion: null,
    },
  ] as ClassifiedFailure[],
  changedFiles: ["src/routes/users.js"],
  workMapFiles: ["src/routes/users.js", "src/routes/auth.js"],
  items: plan.items,
};

// ─── §9.1 report skeleton ─────────────────────────────────────────────────────

describe("§9.1 report skeleton", () => {
  it("renders every section the spec's skeleton requires", () => {
    const md = renderReport({
      ...baseInput,
      green: true,
      queues: [
        queueResult({
          files: [
            { file: "src/routes/users.js", outcome: "fixed", edits: [edit("EX-08")], attempts: 1 },
          ],
        }),
      ],
    });
    for (const heading of [
      "# MajorTom Migration Report - express 4.18.2 -> 5.1.0",
      "## Verdict",
      "## Summary",
      "## Changes (grouped by plan item)",
      "## HUMAN REVIEW",
      "## Pre-existing failures (not caused by this migration)",
      "## Suggested review order (risk-ranked)",
      "## Rollback",
      "## Appendix",
    ]) {
      expect(md, `missing section: ${heading}`).toContain(heading);
    }
  });

  it("names the run, wall clock and verify iteration count in the header", () => {
    const md = renderReport({ ...baseInput, green: true, queues: [] });
    expect(md).toContain("01M3CSNT41F001");
    expect(md).toContain("41m 12s");
    expect(md).toContain("verify iterations 2/3");
  });

  it("groups each edit under its plan item and cites the guide section", () => {
    const md = renderReport({
      ...baseInput,
      green: true,
      queues: [
        queueResult({
          files: [
            { file: "src/routes/users.js", outcome: "fixed", edits: [edit("EX-08")], attempts: 1 },
          ],
        }),
      ],
    });
    expect(md).toContain("### EX-08 -");
    expect(md).toContain("Guide: section");
  });
});

// ─── I6: the verdict is never green when tests are red ────────────────────────

describe("I6 verdict honesty", () => {
  it("says GREEN only when green is true", () => {
    const md = renderReport({ ...baseInput, green: true, queues: [] });
    expect(md).toContain("## Verdict\nGREEN");
  });

  it("says NOT GREEN and warns against merging when green is false", () => {
    const md = renderReport({ ...baseInput, green: false, queues: [] });
    expect(md).toContain("NOT GREEN");
    expect(md).toContain("must not be merged");
  });

  it("a pre-existing failure alone does not flip the verdict red (I8)", () => {
    const md = renderReport({ ...baseInput, green: true, queues: [] });
    expect(md).toContain("pre-existing failure(s) excluded");
  });
});

// ─── §9.2 citation coverage, computed not asserted ───────────────────────────

describe("§9.2 citation coverage", () => {
  it("is 1.0 when every applied edit resolves to a cited plan item", () => {
    const cov = computeCitationCoverage(
      [
        queueResult({
          files: [
            {
              file: "src/routes/users.js",
              outcome: "fixed",
              edits: [edit("EX-08"), edit("EX-09")],
              attempts: 1,
            },
          ],
        }),
      ],
      plan.items
    );
    expect(cov.applied).toBe(2);
    expect(cov.cited).toBe(2);
    expect(cov.ratio).toBe(1);
  });

  it("an edit whose itemId is not in the plan is uncited and reported as H1", () => {
    // "EX-42" is deliberately absent from the canned plan — unlike EX-99, which IS
    // a real plan item (the seeded no-match item) and therefore resolves fine.
    const GHOST = "EX-42";
    const cov = computeCitationCoverage(
      [
        queueResult({
          files: [
            {
              file: "src/routes/users.js",
              outcome: "fixed",
              edits: [edit("EX-01"), edit(GHOST)],
              attempts: 1,
            },
          ],
        }),
      ],
      plan.items
    );
    expect(cov.applied).toBe(2);
    expect(cov.uncited.map((e) => e.itemId)).toEqual([GHOST]);
    expect(cov.ratio).toBeCloseTo(0.5, 5);

    const md = renderReport({
      ...baseInput,
      green: true,
      queues: [
        queueResult({
          files: [
            {
              file: "src/routes/users.js",
              outcome: "fixed",
              edits: [edit("EX-01"), edit(GHOST)],
              attempts: 1,
            },
          ],
        }),
      ],
    });
    expect(md).toMatch(/H1 - src\/routes\/users\.js/);
  });

  it("an edit whose quote does NOT resolve in the guide is uncited even though the item exists", () => {
    // quoteResolves=false models a citation that cannot be found in the artifact.
    const cov = computeCitationCoverage(
      [
        queueResult({
          files: [
            { file: "src/routes/users.js", outcome: "fixed", edits: [edit("EX-08")], attempts: 1 },
          ],
        }),
      ],
      plan.items,
      () => false
    );
    expect(cov.cited).toBe(0);
    expect(cov.ratio).toBe(0);
  });

  it("reports 100% coverage in the summary table", () => {
    const md = renderReport({
      ...baseInput,
      green: true,
      queues: [
        queueResult({
          files: [
            { file: "src/routes/users.js", outcome: "fixed", edits: [edit("EX-08")], attempts: 1 },
          ],
        }),
      ],
    });
    expect(md).toContain("| citation coverage | - | 100% |");
  });
});

// ─── §9.3 HUMAN REVIEW taxonomy ──────────────────────────────────────────────

describe("§9.3 HUMAN REVIEW taxonomy", () => {
  it("H2 — fixer exhausted the attempt budget", () => {
    const md = renderReport({
      ...baseInput,
      green: true,
      queues: [
        queueResult({
          files: [
            {
              file: "src/routes/legacy.js",
              outcome: "human-review",
              edits: [],
              attempts: 5,
              humanReview: { code: "H2", reason: "fixer exhausted 5 attempts" },
            },
          ],
        }),
      ],
    });
    expect(md).toMatch(/H2 - src\/routes\/legacy\.js - fixer exhausted 5 attempts/);
  });

  it("H3 — a plan item below the 0.6 confidence floor", () => {
    const low: PlanItem = { ...plan.items[0]!, id: "EX-20", confidence: 0.4 };
    const md = renderReport({ ...baseInput, green: true, queues: [], items: [...plan.items, low] });
    expect(md).toMatch(/H3 - EX-20 - plan item confidence 0\.4/);
  });

  it("H5 — a failure in a file owned by no queue is never silently reassigned", () => {
    const md = renderReport({
      ...baseInput,
      green: false,
      failures: [
        {
          testId: "src/unknown.js::s::t",
          classification: "migration_caused",
          message: "e",
          file: "src/unknown.js",
          queueId: null,
          orphaned: true,
          assertion: null,
        },
      ] as ClassifiedFailure[],
      queues: [],
    });
    expect(md).toMatch(/H5 - src\/unknown\.js::s::t/);
  });

  it("H6 — a plan warning requiring a decision", () => {
    const md = renderReport({
      ...baseInput,
      green: true,
      queues: [],
      planWarnings: [
        { code: "W_VERSION_UNMENTIONED", message: "guide does not mention the target version" },
      ],
    });
    expect(md).toMatch(/H6 - W_VERSION_UNMENTIONED/);
  });
});

// ─── I1: protected branches ───────────────────────────────────────────────────

describe("I1 protected branch rules (§9.4)", () => {
  it("refuses main and master with E_PROTECTED_BRANCH", () => {
    for (const b of PROTECTED_BRANCHES) {
      expect(() => assertNotProtected(b)).toThrowError(ProtectedBranchError);
      try {
        assertNotProtected(b);
      } catch (e) {
        expect((e as Error).message).toContain("E_PROTECTED_BRANCH");
      }
    }
  });

  it("allows an ordinary feature branch", () => {
    expect(() => assertNotProtected("develop")).not.toThrow();
  });

  it("always builds the run branch as majortom/<runId>", () => {
    expect(branchNameFor("01M3CSNT41F001")).toBe("majortom/01M3CSNT41F001");
    expect(branchNameFor("x").startsWith("majortom/")).toBe(true);
  });

  it("uses the spec's commit message format", () => {
    expect(commitMessageFor(["EX-01", "EX-06"], "phase 3 scanner and work map")).toBe(
      "majortom: EX-01,EX-06 - phase 3 scanner and work map"
    );
  });

  it("opens the PR as DRAFT when not green, ready when green", () => {
    expect(prOptions({ green: true, report: "r" }).draft).toBe(false);
    expect(prOptions({ green: false, report: "r" }).draft).toBe(true);
  });

  it("the PR body IS the report", () => {
    expect(prOptions({ green: true, report: "# report body" }).body).toBe("# report body");
  });
});

// ─── I5: the report carries its own diff-scope proof ──────────────────────────

describe("I5 scope proof in the report", () => {
  it("names any file that changed outside the work map", () => {
    const md = renderReport({
      ...baseInput,
      green: true,
      changedFiles: ["src/routes/users.js", "src/config.js"],
      workMapFiles: ["src/routes/users.js"],
      queues: [],
    });
    expect(md).toContain("src/config.js");
    expect(md).toMatch(/changed outside the work map/);
  });

  it("says so plainly when every change is in scope", () => {
    const md = renderReport({ ...baseInput, green: true, queues: [] });
    expect(md).toContain("Every changed file appears in the work map");
  });
});

// ─── review order ─────────────────────────────────────────────────────────────

describe("suggested review order", () => {
  it("ranks a human-review file above a merely-edited one", () => {
    const order = reviewOrder(
      [
        queueResult({
          files: [
            {
              file: "src/routes/clean.js",
              outcome: "fixed",
              edits: [edit("EX-08", "src/routes/clean.js")],
              attempts: 1,
            },
            {
              file: "src/routes/legacy.js",
              outcome: "human-review",
              edits: [],
              attempts: 5,
              humanReview: { code: "H2", reason: "budget" },
            },
          ],
        }),
      ],
      [],
      plan.items
    );
    expect(order[0]?.file).toBe("src/routes/legacy.js");
  });
});

// ─── §9.5 redaction ───────────────────────────────────────────────────────────

describe("§9.5 redaction", () => {
  it("strips a GitHub personal access token", () => {
    const out = redact("token is ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).toContain(REDACTED);
  });

  it("strips a fine-grained github_pat_ token", () => {
    expect(redact("github_pat_11ABCDEFG0abcdefghijklmnop")).toContain(REDACTED);
  });

  it("strips an AWS access key id", () => {
    expect(redact("AKIAIOSFODNN7EXAMPLE")).toBe(REDACTED);
  });

  it("strips a PEM private key block entirely", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(redact(pem)).toBe(REDACTED);
  });

  it("strips a bearer token", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toContain(REDACTED);
  });

  it("keeps the key name so the report stays readable", () => {
    const out = redact("GITHUB_TOKEN=supersecretvalue123");
    expect(out).toContain("GITHUB_TOKEN=");
    expect(out).not.toContain("supersecretvalue123");
  });

  it("reports what it removed without echoing the secret", () => {
    const { hits } = redactWithReport("AKIAIOSFODNN7EXAMPLE");
    expect(hits.length).toBeGreaterThan(0);
    expect(typeof hits[0]?.kind).toBe("string");
    expect(JSON.stringify(hits)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("leaves ordinary prose untouched", () => {
    const prose = "Replaced res.send(404) with res.sendStatus(404) in src/routes/auth.js";
    expect(redact(prose)).toBe(prose);
  });

  it("is applied to the rendered report", () => {
    const md = renderReport({
      ...baseInput,
      green: true,
      queues: [
        queueResult({
          files: [
            {
              file: "src/config.js",
              outcome: "fixed",
              edits: [
                {
                  ...edit("EX-08", "src/config.js"),
                  after: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
                },
              ],
              attempts: 1,
            },
          ],
        }),
      ],
    });
    expect(md).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
