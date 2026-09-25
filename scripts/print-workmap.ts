// scripts/print-workmap.ts — Phase 3 reporting helper (not part of src/).
// Prints the work map and queues produced for fixtures/express4 from the canned plan.
import { readFileSync } from "fs";
import { resolve } from "path";
import { impactScan } from "../src/scanner/impact.js";
import { partition, findQueueOverlap } from "../src/scanner/partition.js";

const FIXTURE_ROOT = resolve("fixtures/express4");
const plan = JSON.parse(readFileSync(resolve("tests/fixtures/canned-plan.json"), "utf8")) as {
  items: Array<{ id: string; detect: { regex: string[]; astQuery: string | null; filesGlob: string[] } }>;
};

const result = await impactScan(FIXTURE_ROOT, plan.items);
const queues = partition(result.entries, 3);

console.log(`\n=== workmap.json (fixtures/express4) ===`);
console.log(`entries: ${result.entries.length}   unmatchedItemIds: [${result.unmatchedItemIds.join(", ")}]\n`);

for (const e of result.entries) {
  const live = e.hits.filter((h) => !h.suppressed);
  const dead = e.hits.filter((h) => h.suppressed);
  console.log(`${e.file}  (estimatedEdits: ${e.estimatedEdits})`);
  for (const h of live) console.log(`   L${String(h.line).padStart(3)}:${String(h.column).padEnd(3)} ${h.itemId} [${h.matchKind}] ${h.snippet.slice(0, 70)}`);
  for (const h of dead) console.log(`   L${String(h.line).padStart(3)}:${String(h.column).padEnd(3)} ${h.itemId} SUPPRESSED (${h.suppressionReason})`);
  console.log("");
}

console.log(`=== queues (maxQueues=3) ===`);
for (const q of queues) {
  console.log(`${q.queueId}  files=${q.files.length} estimatedEdits=${q.estimatedEdits}`);
  console.log(`   items: ${q.itemIds.join(", ")}`);
  for (const f of q.files) console.log(`   - ${f}`);
  console.log("");
}
console.log(`overlap across queues: ${JSON.stringify(findQueueOverlap(queues))}`);
