// tests/verify/verify.test.ts
// Phase 6 acceptance tests (SPEC.md §8, I6, I8)

import { describe, it, expect } from "vitest";
// Import the module that has NO runtime dependency on the others FIRST. classify.ts
// used to import a value from schemas.ts; a consumer that pulled in classify.ts
// before schemas.ts got `undefined` for that binding (a real cycle, invisible until
// the call site). classify.ts is now types-only, but import classify before schemas
// anyway so this suite can never reintroduce an order dependency.
import { classify, ownershipFromQueues, fileFromMessage, fileFromTestId, COUNTS_AGAINST_MIGRATION } from "../../src/verify/classify.js";
import { Baseline } from "../../src/verify/schemas.js";
import { parseReport } from "../../src/verify/adapters.js";

/**
 * These tests exercise the CLASSIFICATION LOGIC against constructed Baseline
 * objects. The end-to-end loop (which really runs the fixture suite) is proven in
 * Phase 8, where the orchestrator drives baseline → fix → verify against
 * express@5. Here we prove the §8.2 table exactly — the part that decides whether a
 * failure is the migration's fault.
 */
function baselineOf(
  results: Array<[string, "pass" | "fail"]>,
  collectionErrors: string[] = []
): Baseline {
  return {
    runner: "vitest",
    command: "npx vitest run",
    exitCode: 0,
    totalMs: 10,
    results: results.map(([id, status]) => ({
      id,
      status,
      durationMs: 1,
      message: status === "fail" ? "boom" : null,
    })),
    failingIds: results.filter(([, s]) => s === "fail").map(([id]) => id),
    collectionErrors,
  };
}

const OWNERSHIP = ownershipFromQueues([
  { queueId: "q1", files: ["src/routes/users.js", "src/routes/items.js"] },
  { queueId: "q2", files: ["src/routes/auth.js"] },
]);

describe("§8.2 classification table", () => {
  it("post=fail + id in baseline.failingIds -> pre_existing (excluded from accounting)", () => {
    const base = baselineOf([["a::x::t1", "pass"], ["a::x::t2", "fail"]]);
    const post = baselineOf([["a::x::t1", "pass"], ["a::x::t2", "fail"]]);
    const { failures, counts } = classify({ baseline: base, post, ownership: OWNERSHIP });
    const f = failures.find((x) => x.testId === "a::x::t2");
    expect(f?.classification).toBe("pre_existing");
    // I8: pre-existing is NOT counted against the migration.
    expect(COUNTS_AGAINST_MIGRATION.has(f!.classification)).toBe(false);
    expect(counts.pre_existing).toBe(1);
  });

  it("post=fail + id was passing at baseline -> migration_caused (routes back)", () => {
    const base = baselineOf([["a::x::t1", "pass"]]);
    const post = baselineOf([["a::x::t1", "fail"]]);
    const { failures, counts } = classify({ baseline: base, post, ownership: OWNERSHIP });
    const f = failures.find((x) => x.testId === "a::x::t1");
    expect(f?.classification).toBe("migration_caused");
    expect(COUNTS_AGAINST_MIGRATION.has(f!.classification)).toBe(true);
    expect(counts.migration_caused).toBe(1);
  });

  it("post=fail + id absent from baseline -> new_or_renamed (treated as migration_caused, flagged)", () => {
    const base = baselineOf([["a::x::t1", "pass"]]);
    const post = baselineOf([["a::x::t1", "pass"], ["a::y::t9", "fail"]]);
    const { failures, counts } = classify({ baseline: base, post, ownership: OWNERSHIP });
    const f = failures.find((x) => x.testId === "a::y::t9");
    expect(f?.classification).toBe("new_or_renamed");
    expect(COUNTS_AGAINST_MIGRATION.has(f!.classification)).toBe(true);
    expect(counts.new_or_renamed).toBe(1);
  });

  it("post=pass + id in baseline.failingIds -> incidentally_fixed (reported, not celebrated)", () => {
    const base = baselineOf([["a::x::t1", "fail"]]);
    const post = baselineOf([["a::x::t1", "pass"]]);
    const { failures, counts } = classify({ baseline: base, post, ownership: OWNERSHIP });
    const f = failures.find((x) => x.testId === "a::x::t1");
    expect(f?.classification).toBe("incidentally_fixed");
    expect(COUNTS_AGAINST_MIGRATION.has(f!.classification)).toBe(false);
    expect(counts.incidentally_fixed).toBe(1);
  });

  it("id in baseline, absent from post -> collection_regression (high severity)", () => {
    const base = baselineOf([["a::x::t1", "pass"], ["a::x::t2", "pass"]]);
    const post = baselineOf([["a::x::t1", "pass"]]);
    const { failures, counts } = classify({ baseline: base, post, ownership: OWNERSHIP });
    const f = failures.find((x) => x.testId === "a::x::t2");
    expect(f?.classification).toBe("collection_regression");
    expect(COUNTS_AGAINST_MIGRATION.has(f!.classification)).toBe(true);
    expect(counts.collection_regression).toBe(1);
  });
});

describe("flake control (§8.2)", () => {
  it("a test that passes on isolated rerun is flaky_suspect and NOT routed", () => {
    const base = baselineOf([["a::x::t1", "pass"]]);
    const post = baselineOf([["a::x::t1", "fail"]]);
    const { failures, counts, green } = classify({
      baseline: base,
      post,
      ownership: OWNERSHIP,
      flakyIds: ["a::x::t1"],
    });
    expect(counts.flaky_suspect).toBe(1);
    expect(failures.filter((f) => f.classification === "migration_caused")).toHaveLength(0);
    expect(green).toBe(true); // a flake is not a red build
  });
});

describe("routing and the I5 orphan rule", () => {
  it("a migration_caused failure in a queued file routes to that queue", () => {
    const base = baselineOf([["src/routes/users.js::s::t", "pass"]]);
    const post = baselineOf([["src/routes/users.js::s::t", "fail"]]);
    const { failures } = classify({ baseline: base, post, ownership: OWNERSHIP });
    const f = failures.find((x) => x.testId === "src/routes/users.js::s::t");
    expect(f?.queueId).toBe("q1");
    expect(f?.orphaned).toBe(false);
  });

  it("a failure in a file owned by NO queue is orphaned and escalated to H5, never reassigned", () => {
    const base = baselineOf([["src/unknown.js::s::t", "pass"]]);
    const post = baselineOf([["src/unknown.js::s::t", "fail"]]);
    const { failures } = classify({ baseline: base, post, ownership: OWNERSHIP });
    const f = failures.find((x) => x.testId === "src/unknown.js::s::t");
    expect(f?.queueId).toBeNull();
    expect(f?.orphaned).toBe(true); // → HUMAN REVIEW H5 per §8.2
  });

  it("a pre-existing failure is never routed even if its file is queued", () => {
    const base = baselineOf([["src/routes/users.js::s::t", "fail"]]);
    const post = baselineOf([["src/routes/users.js::s::t", "fail"]]);
    const { failures } = classify({ baseline: base, post, ownership: OWNERSHIP });
    const f = failures.find((x) => x.testId === "src/routes/users.js::s::t");
    expect(f?.classification).toBe("pre_existing");
    expect(f?.orphaned).toBe(false);
  });
});

describe("green determination (I6)", () => {
  it("green when only pre-existing failures remain", () => {
    const base = baselineOf([["a::t1", "fail"]]);
    const post = baselineOf([["a::t1", "fail"]]);
    const { green } = classify({ baseline: base, post, ownership: OWNERSHIP });
    expect(green).toBe(true); // pre-existing alone does not make it red
  });

  it("NOT green when a migration_caused failure exists", () => {
    const base = baselineOf([["a::t1", "pass"]]);
    const post = baselineOf([["a::t1", "fail"]]);
    const { green } = classify({ baseline: base, post, ownership: OWNERSHIP });
    expect(green).toBe(false);
  });
});

describe("file attribution helpers", () => {
  it("extracts a repo-relative file from a stack trace", () => {
    const msg = "AssertionError: expected 200 got 500\n    at fn (C:/repo/src/routes/users.js:9:14)";
    expect(fileFromMessage(msg)).toBe("src/routes/users.js");
  });

  it("falls back to the test id's own file segment", () => {
    expect(fileFromTestId("src/routes/auth.js::s::t")).toBe("src/routes/auth.js");
  });

  it("returns null when no file can be determined", () => {
    expect(fileFromMessage(null)).toBeNull();
  });
});

describe("runner report parsing", () => {
  it("parses a vitest JSON report into stable file::suite::test ids", () => {
    const report = JSON.stringify({
      testResults: [
        {
          name: "src/routes/users.js",
          status: "passed",
          assertionResults: [
            {
              title: "returns a user",
              ancestorTitles: ["GET /users/:id"],
              status: "passed",
              duration: 3,
              failureMessages: [],
            },
            {
              title: "preferences",
              ancestorTitles: ["GET /users/preferences"],
              status: "failed",
              duration: 5,
              failureMessages: ["expected 200 got 500"],
            },
          ],
        },
      ],
    });
    const { results } = parseReport("vitest", report, "");
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe("src/routes/users.js::GET /users/:id::returns a user");
    expect(results[1]?.status).toBe("fail");
  });

  it("records a collection error for a suite that failed to load", () => {
    const report = JSON.stringify({
      testResults: [
        { name: "src/broken.js", status: "failed", message: "SyntaxError", assertionResults: [] },
      ],
    });
    const { collectionErrors } = parseReport("vitest", report, "");
    expect(collectionErrors.length).toBe(1);
    expect(collectionErrors[0]).toContain("SyntaxError");
  });

  it("returns empty results for unparseable output rather than throwing", () => {
    const { results } = parseReport("vitest", "not json at all", "");
    expect(results).toHaveLength(0);
  });
});
