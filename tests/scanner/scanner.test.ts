// tests/scanner/scanner.test.ts
// Phase 3 acceptance tests for the scanner → work map (SPEC.md §6)

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { impactScan } from "../../src/scanner/impact.js";
import { partition, findQueueOverlap } from "../../src/scanner/partition.js";
import { scanManifest } from "../../src/scanner/manifest.js";

const FIXTURE_ROOT = resolve("fixtures/express4");
const CANNED_PLAN_PATH = resolve("tests/fixtures/canned-plan.json");

interface PlanItem {
  id: string;
  detect: {
    regex: string[];
    astQuery: string | null;
    filesGlob: string[];
  };
}

interface CannedPlan {
  items: PlanItem[];
}

function loadCannedPlan(): CannedPlan {
  return JSON.parse(readFileSync(CANNED_PLAN_PATH, "utf8")) as CannedPlan;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("impactScan — breakage coverage", () => {
  it("covers every seeded breakage in BREAKAGES.json", async () => {
    const plan = loadCannedPlan();
    const breakages = JSON.parse(
      readFileSync(join(FIXTURE_ROOT, "BREAKAGES.json"), "utf8")
    ) as { entries: Array<{ planItemRef: string }> };

    const result = await impactScan(FIXTURE_ROOT, plan.items);

    // All breakage planItemRefs should appear in matched items
    const matchedItems = new Set(
      result.entries.flatMap((e) => e.hits.filter((h) => !h.suppressed).map((h) => h.itemId))
    );

    const seededRefs = new Set(breakages.entries.map((b) => b.planItemRef));

    for (const ref of seededRefs) {
      // EX-99 is deliberately unmatched
      if (ref === "EX-99") continue;
      expect(matchedItems.has(ref), `Plan item ${ref} should have matches`).toBe(true);
    }
  });

  it("EX-99 plan item with zero call sites lands in unmatchedItemIds", async () => {
    const plan = loadCannedPlan();
    const result = await impactScan(FIXTURE_ROOT, plan.items);
    expect(result.unmatchedItemIds).toContain("EX-99");
  });
});

describe("impactScan — false-positive suppression", () => {
  it("does NOT match occurrences inside comments", async () => {
    const plan = loadCannedPlan();
    const result = await impactScan(FIXTURE_ROOT, plan.items);

    // The logger.js file has patterns inside comments that should be suppressed
    const loggerEntry = result.entries.find((e) => e.file.includes("logger"));
    if (!loggerEntry) return; // ok if logger.js has no hits at all

    // Any hit in logger.js should be suppressed or not in the code paths
    // (The real code in logger.js doesn't call these methods — they're in comments/strings)
    const unsuppressedInLogger = loggerEntry.hits.filter((h) => !h.suppressed);
    // logger.js contains no real calls, only comments and string literals
    expect(unsuppressedInLogger).toHaveLength(0);
  });

  it("suppressed hits have a non-null suppressionReason", async () => {
    const plan = loadCannedPlan();
    const result = await impactScan(FIXTURE_ROOT, plan.items);

    const suppressedHits = result.entries.flatMap((e) => e.hits.filter((h) => h.suppressed));
    for (const hit of suppressedHits) {
      expect(hit.suppressionReason).not.toBeNull();
      expect(hit.suppressionReason!.length).toBeGreaterThan(0);
    }
  });
});

describe("partition — disjoint queues", () => {
  it("queues are provably disjoint", async () => {
    const plan = loadCannedPlan();
    const result = await impactScan(FIXTURE_ROOT, plan.items);
    const queues = partition(result.entries, 3);

    const overlap = findQueueOverlap(queues);
    expect(overlap).toHaveLength(0);
  });

  it("every file appears in exactly one queue", async () => {
    const plan = loadCannedPlan();
    const result = await impactScan(FIXTURE_ROOT, plan.items);
    const queues = partition(result.entries, 3);

    const allFiles = queues.flatMap((q) => q.files);
    const unique = new Set(allFiles);
    expect(allFiles).toHaveLength(unique.size);
  });

  it("partitioning is deterministic — same input produces same queues twice", async () => {
    const plan = loadCannedPlan();
    const result1 = await impactScan(FIXTURE_ROOT, plan.items);
    const result2 = await impactScan(FIXTURE_ROOT, plan.items);

    // Sort entries the same way partition does (by estimatedEdits desc, then path)
    const sortEntries = (entries: typeof result1.entries) =>
      [...entries]
        .filter((e) => e.estimatedEdits > 0)
        .sort((a, b) =>
          b.estimatedEdits !== a.estimatedEdits
            ? b.estimatedEdits - a.estimatedEdits
            : a.file.localeCompare(b.file)
        )
        .map((e) => e.file);

    const sorted1 = sortEntries(result1.entries);
    const sorted2 = sortEntries(result2.entries);

    expect(sorted1).toEqual(sorted2);

    // File assignment order should be deterministic
    const q1 = partition(result1.entries, 3).map((q) => [...q.files].sort());
    const q2 = partition(result2.entries, 3).map((q) => [...q.files].sort());

    // Sort queues by their first file for comparison
    const sortQueues = (qs: typeof q1) => [...qs].sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
    expect(sortQueues(q1)).toEqual(sortQueues(q2));
  });

  it("at least 3 queues get real work from the fixture", async () => {
    const plan = loadCannedPlan();
    const result = await impactScan(FIXTURE_ROOT, plan.items);
    const queues = partition(result.entries, 3);
    // All 3 queues should have files
    expect(queues.length).toBe(3);
    for (const q of queues) {
      expect(q.files.length).toBeGreaterThan(0);
      expect(q.estimatedEdits).toBeGreaterThan(0);
    }
  });
});

describe("scanManifest", () => {
  it("detects express@4 as a dependency in the fixture", () => {
    const manifest = scanManifest(FIXTURE_ROOT);
    const express = manifest.dependencies.find((d) => d.name === "express");
    expect(express).toBeDefined();
    expect(express?.declaredRange).toBe("4.21.2");
  });

  it("detects package manager and lockfile", () => {
    const manifest = scanManifest(FIXTURE_ROOT);
    expect(["npm", "pnpm"]).toContain(manifest.packageManager);
    expect(manifest.hasLockfile).toBe(true);
  });

  it("detects test script", () => {
    const manifest = scanManifest(FIXTURE_ROOT);
    expect(manifest.hasTestScript).toBe(true);
  });
});
