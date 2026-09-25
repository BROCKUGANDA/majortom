// scripts/inspect-guide.ts — diagnostic: show parsed sections + why items are dropped.
import { resolve } from "path";
import { ingestGuide } from "../src/docs/ingest.js";
import { parseSections, extractQuote, quoteAppearsIn } from "../src/docs/docreader.js";

const artifact = ingestGuide(resolve("."), "guides/express5.md", { maxGuidePages: 60 });
const sections = parseSections(artifact.text);

console.log(`\nsections parsed: ${sections.length}\n`);
for (const s of sections) {
  const q = extractQuote(s.body);
  const verbatim = q ? quoteAppearsIn(q, artifact.text) : null;
  console.log(
    `L${String(s.line).padStart(4)} ${"#".repeat(s.level)} ${s.title}\n` +
      `        locator=${s.locator}\n` +
      `        quote=${q === null ? "<<NULL>>" : `${JSON.stringify(q.slice(0, 90))} verbatim=${verbatim}`}`
  );
}
