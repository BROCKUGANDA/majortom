// scripts/inspect-plan.ts — diagnostic: which shapes match which sections, and why.
import { resolve } from "path";
import { ingestGuide } from "../src/docs/ingest.js";
import { readGuide, parseSections } from "../src/docs/docreader.js";
import { PlanItem } from "../src/docs/schemas.js";

const artifact = ingestGuide(resolve("."), "guides/express5.md", { maxGuidePages: 60 });
const sections = parseSections(artifact.text);
console.log(`sections: ${sections.length}`);

const { plan, droppedForMissingQuote } = readGuide({
  artifact,
  dependency: { name: "express", from: "4.21.2", to: "5.1.0" },
});
console.log(`items emitted: ${plan.items.length}`);
console.log(`dropped: ${JSON.stringify(droppedForMissingQuote)}`);
console.log(`warnings: ${plan.warnings.map((w) => w.code).join(", ")}`);

// For the first section title, show the raw title text with codepoints for whitespace.
const t = sections[0]?.title ?? "";
console.log(`\nsection[0].title = ${JSON.stringify(t)}`);
const shaped = sections.filter((s) => /^app\.del\(\)$/i.test(s.title));
console.log(`sections matching /^app\\.del\\(\\)$/i : ${shaped.length}`);
console.log(`titles sample: ${JSON.stringify(sections.slice(0, 6).map((s) => s.title))}`);

// Check whether an emitted-less item is because PlanItem.safeParse failed on `q` unused etc.
console.log(`\nfirst item schema probe:`);
const probe = PlanItem.safeParse({
  id: "EX-01",
  title: "app.del() removed",
  summary: "Express 5 no longer supports the app.del() function. Use app.delete() to register HTTP DELETE routes.",
  kind: "removal",
  severity: "breaking",
  detect: { regex: ["\\.del\\s*\\("], astQuery: null, filesGlob: ["**/*.{ts,js,mjs,cjs}"] },
  fix: {
    strategy: "codemod",
    instruction: "Replace every app.del(path, handler) call with app.delete(path, handler) in this file.",
    example: { before: "app.del('/user/:id', handler)", after: "app.delete('/user/:id', handler)" },
  },
  citation: { docId: "guides/express5.md", sectionTitle: "app.del()", locator: "#app-del", quote: "x".repeat(30) },
  testExpectation: "None: routing behaviour is unchanged.",
  confidence: 0.95,
  requiresHumanReview: false,
});
console.log(`  success=${probe.success}`);
if (!probe.success) console.error(JSON.stringify(probe.error.issues, null, 2));
