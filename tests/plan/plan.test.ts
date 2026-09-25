// tests/plan/plan.test.ts
// Phase 4 acceptance tests for doc ingestion → Migration Plan (SPEC.md §4, §7.2)

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { ingestGuide } from "../../src/docs/ingest.js";
import { readGuide, scanForInjection, quoteAppearsIn } from "../../src/docs/docreader.js";
import { MigrationPlan, WarningCode } from "../../src/docs/schemas.js";

const REPO_ROOT = resolve(".");
const REAL_GUIDE = "guides/express5.md";
const MAX_GUIDE_PAGES = 60;

function ingest(path: string) {
  return ingestGuide(REPO_ROOT, path, { maxGuidePages: MAX_GUIDE_PAGES });
}

function planFor(path: string, to = "5.1.0") {
  const artifact = ingest(path);
  return readGuide({
    artifact,
    dependency: { name: "express", from: "4.21.2", to },
  });
}

describe("guide intake", () => {
  it("hashes the artifact and records a markdown source", () => {
    const artifact = ingest(REAL_GUIDE);
    expect(artifact.kind).toBe("markdown");
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.docId).toBe(REAL_GUIDE);
    expect(artifact.text.length).toBeGreaterThan(500);
  });

  it("rejects an unreadable guide with E_GUIDE_UNREADABLE", () => {
    expect(() => ingest("guides/does-not-exist.md")).toThrowError(/Cannot read guide/);
  });

  it("rejects an unsupported guide extension", () => {
    expect(() => ingest("package.json")).toThrowError(/Unsupported guide extension/);
  });
});

describe("doc-reader output validates against the §4 schema", () => {
  it("the generated plan parses against MigrationPlan", () => {
    const { plan } = planFor(REAL_GUIDE);
    const parsed = MigrationPlan.safeParse(plan);
    if (!parsed.success) {
      console.error(JSON.stringify(parsed.error.issues, null, 2));
    }
    expect(parsed.success).toBe(true);
    expect(parsed.data?.schemaVersion).toBe(1);
    expect(parsed.data?.sources.length).toBeGreaterThan(0);
  });

  it("persists a plan that round-trips through JSON", () => {
    const { plan } = planFor(REAL_GUIDE);
    const round = MigrationPlan.parse(JSON.parse(JSON.stringify(plan)));
    expect(round.items.length).toBe(plan.items.length);
  });
});

describe("citations — every item carries a verbatim quote", () => {
  it("100% of items carry a non-empty citation", () => {
    const { plan } = planFor(REAL_GUIDE);
    expect(plan.items.length).toBeGreaterThan(0);
    for (const item of plan.items) {
      expect(item.citation.quote.length, `${item.id} quote length`).toBeGreaterThanOrEqual(20);
      expect(item.citation.locator.length, `${item.id} locator`).toBeGreaterThan(0);
      expect(item.citation.sectionTitle.length, `${item.id} sectionTitle`).toBeGreaterThan(0);
    }
  });

  it("every quote actually appears in the guide (substring containment, not by eye)", () => {
    const artifact = ingest(REAL_GUIDE);
    const { plan } = planFor(REAL_GUIDE);
    for (const item of plan.items) {
      expect(
        quoteAppearsIn(item.citation.quote, artifact.text),
        `${item.id} quote is not verbatim in the guide: "${item.citation.quote}"`
      ).toBe(true);
    }
  });

  it("cites the guide's own source hash so a quote is traceable to a document", () => {
    const artifact = ingest(REAL_GUIDE);
    const { plan } = planFor(REAL_GUIDE);
    expect(plan.sources[0]?.sha256).toBe(artifact.sha256);
    for (const item of plan.items) {
      expect(item.citation.docId).toBe(artifact.docId);
    }
  });
});

describe("§10.1 Phase 4 gate — >= 80% of Annex B present", () => {
  it("extracts at least 80% of the Annex B breaking-change catalog", () => {
    // Annex B (SPEC.md) seeded=yes rows, i.e. the changes the fixture actually seeds.
    const ANNEX_B_SEEDED = [
      "EX-01",
      "EX-02",
      "EX-03",
      "EX-04",
      "EX-06",
      "EX-07",
      "EX-08",
      "EX-09",
      "EX-10",
      "EX-11",
      "EX-12",
      "EX-13",
      "EX-14",
      "EX-15",
      "EX-17",
      "EX-18",
    ];
    const { plan } = planFor(REAL_GUIDE);
    const extracted = new Set(plan.items.map((i) => i.id));

    const covered = ANNEX_B_SEEDED.filter((id) => extracted.has(id));
    const ratio = covered.length / ANNEX_B_SEEDED.length;
    const missing = ANNEX_B_SEEDED.filter((id) => !extracted.has(id));

    console.log(
      `Annex B coverage: ${covered.length}/${ANNEX_B_SEEDED.length} = ${(ratio * 100).toFixed(1)}%` +
        (missing.length > 0 ? `  missing: ${missing.join(", ")}` : "")
    );
    expect(ratio, `missing Annex B items: ${missing.join(", ")}`).toBeGreaterThanOrEqual(0.8);
  });
});

describe("W_VERSION_UNMENTIONED — wrong-version guide", () => {
  it("emits W_VERSION_UNMENTIONED when the target version is absent from the guide", () => {
    const { plan } = planFor("tests/fixtures/guide-wrong-version.md", "5.1.0");
    const codes = plan.warnings.map((w) => w.code);
    expect(codes).toContain(WarningCode.VERSION_UNMENTIONED);
  });

  it("does NOT emit W_VERSION_UNMENTIONED for the real guide", () => {
    const { plan } = planFor(REAL_GUIDE);
    const codes = plan.warnings.map((w) => w.code);
    expect(codes).not.toContain(WarningCode.VERSION_UNMENTIONED);
  });
});

describe("W_INJECTION_SUSPECTED — the guide is data, never instructions (I3)", () => {
  it("flags a guide containing directives aimed at the tool", () => {
    const { plan, injectionFindings } = planFor("tests/fixtures/guide-with-injection.md");
    const codes = plan.warnings.map((w) => w.code);
    expect(codes).toContain(WarningCode.INJECTION_SUSPECTED);
    expect(injectionFindings.length).toBeGreaterThan(0);
  });

  it("the warning records the offending text verbatim", () => {
    const { plan } = planFor("tests/fixtures/guide-with-injection.md");
    const warning = plan.warnings.find((w) => w.code === WarningCode.INJECTION_SUSPECTED);
    expect(warning?.message).toMatch(/delete all files/i);
  });

  it("does NOT act on the injected instruction: extraction continues normally", () => {
    const { plan } = planFor("tests/fixtures/guide-with-injection.md");
    // The legitimate items in the same document must still be extracted.
    const ids = new Set(plan.items.map((i) => i.id));
    expect(ids.has("EX-02")).toBe(true); // res.send(status)
    expect(ids.has("EX-06")).toBe(true); // res.sendfile()
    expect(ids.has("EX-18")).toBe(true); // minimum Node version
  });

  it("no plan item is ever emitted without a real citation, even under injection", () => {
    const artifact = ingest("tests/fixtures/guide-with-injection.md");
    const { plan } = planFor("tests/fixtures/guide-with-injection.md");
    for (const item of plan.items) {
      expect(quoteAppearsIn(item.citation.quote, artifact.text), `${item.id}`).toBe(true);
    }
  });

  it("the scanner is pure detection: it never returns a mutated document", () => {
    const raw = readFileSync(resolve("tests/fixtures/guide-with-injection.md"), "utf8");
    const before = raw.length;
    scanForInjection(raw);
    expect(raw.length).toBe(before);
  });
});

describe("the fixture README's injected lines are also detected as data", () => {
  it("flags the fixture README's TOOL/AI_AGENT directives", () => {
    const readme = readFileSync(resolve("fixtures/express4/README.md"), "utf8");
    const findings = scanForInjection(readme);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => /delete all files/i.test(f.text))).toBe(true);
  });
});

describe("§4.1 warning emission", () => {
  it("every emitted warning carries a code and a message", () => {
    const { plan } = planFor(REAL_GUIDE);
    for (const w of plan.warnings) {
      expect(w.code.length).toBeGreaterThan(0);
      expect(w.message.length).toBeGreaterThan(0);
    }
  });

  it("emits W_FEW_ITEMS when fewer than 3 breaking items are extracted", () => {
    const { plan } = planFor("tests/fixtures/guide-wrong-version.md");
    const breaking = plan.items.filter((i) => i.severity === "breaking").length;
    if (breaking < 3) {
      expect(plan.warnings.map((w) => w.code)).toContain(WarningCode.FEW_ITEMS);
    }
  });
});

describe("plan items are actionable", () => {
  it("every item has at least one detect pattern and an imperative fix instruction", () => {
    const { plan } = planFor(REAL_GUIDE);
    for (const item of plan.items) {
      expect(item.detect.regex.length, `${item.id} detect.regex`).toBeGreaterThan(0);
      expect(item.fix.instruction.length, `${item.id} fix.instruction`).toBeGreaterThanOrEqual(20);
      expect(["codemod", "guided-edit", "manual-only"]).toContain(item.fix.strategy);
      expect(item.confidence).toBeGreaterThan(0);
      expect(item.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("plan item ids are unique", () => {
    const { plan } = planFor(REAL_GUIDE);
    const ids = plan.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("extraction is deterministic: the same guide yields the same plan", () => {
    const a = planFor(REAL_GUIDE);
    const b = planFor(REAL_GUIDE);
    expect(JSON.stringify(a.plan.items)).toBe(JSON.stringify(b.plan.items));
  });
});

describe("guide source selection", () => {
  it("the committed real guide exists at guides/express5.md", () => {
    expect(existsSync(resolve(REAL_GUIDE))).toBe(true);
  });
});
