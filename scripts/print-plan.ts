// scripts/print-plan.ts — Phase 4 reporting helper: the plan generated from the real guide.
import { resolve } from "path";
import { ingestGuide } from "../src/docs/ingest.js";
import { readGuide } from "../src/docs/docreader.js";

const artifact = ingestGuide(resolve("."), "guides/express5.md", { maxGuidePages: 60 });
const { plan, injectionFindings, droppedForMissingQuote } = readGuide({
  artifact,
  dependency: { name: "express", from: "4.21.2", to: "5.1.0" },
});

console.log(`\n=== plan.json (generated from ${artifact.docId}) ===`);
console.log(`planId: ${plan.planId}`);
console.log(`source: ${plan.sources[0]?.title}  sha256=${plan.sources[0]?.sha256.slice(0, 16)}…`);
console.log(`items: ${plan.items.length}\n`);

for (const item of plan.items) {
  console.log(
    `${item.id}  [${item.kind}/${item.severity}] conf=${item.confidence}` +
      `${item.requiresHumanReview ? "  HUMAN-REVIEW" : ""}\n` +
      `   title: ${item.title}\n` +
      `   guide: section "${item.citation.sectionTitle}" ${item.citation.locator}\n` +
      `   quote: "${item.citation.quote.slice(0, 110)}${item.citation.quote.length > 110 ? "…" : ""}"\n` +
      `   fix:   ${item.fix.strategy} — ${item.fix.instruction.slice(0, 100)}${item.fix.instruction.length > 100 ? "…" : ""}\n` +
      `   detect: ${item.detect.regex.map((r) => `/${r}/`).join("  ")}\n`
  );
}

console.log(`warnings: ${plan.warnings.length === 0 ? "(none)" : ""}`);
for (const w of plan.warnings) console.log(`  ${w.code}: ${w.message}`);
console.log(`\ninjection findings: ${injectionFindings.length}`);
console.log(`dropped for missing quote: ${droppedForMissingQuote.length === 0 ? "(none)" : droppedForMissingQuote.join(", ")}`);
