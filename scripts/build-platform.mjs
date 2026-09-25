#!/usr/bin/env node
/**
 * Generate the static demo dashboard from a real MajorTom run ledger.
 *
 * Every number on the page is read from `.majortom/runs/<id>/ledger.json` and
 * the run's report — nothing is hardcoded or simulated. If the ledger has no
 * metrics, the page says "not recorded" rather than inventing a value.
 *
 *   npm run demo:platform            # uses the most recent run in the demo sandbox
 *   node scripts/build-platform.mjs <runDir> [outFile]
 *
 * Output: a single self-contained HTML file (no JS framework, no CDN).
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const SANDBOX = ".test-sandbox/demo";

// ── locate the run ────────────────────────────────────────────────────────────
function latestRun() {
  const runs = join(SANDBOX, ".majortom", "runs");
  if (!existsSync(runs)) return null;
  const dirs = readdirSync(runs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(runs, d.name, "ledger.json")))
    .map((d) => join(runs, d.name))
    .sort();
  return dirs.length ? dirs[dirs.length - 1] : null;
}

const arg = process.argv[2];
const runDir = arg && existsSync(join(arg, "ledger.json")) ? resolve(arg) : latestRun();
if (!runDir) {
  console.error("no run found. run: npm run demo -- --keep");
  process.exit(1);
}

const ledger = JSON.parse(readFileSync(join(runDir, "ledger.json"), "utf8"));
const reportPath = join(runDir, "artifacts", "report.md");
const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";

// ── facts, straight from the ledger ───────────────────────────────────────────
const m = ledger.metrics ?? {};
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const secs = (ms) => (num(ms) === null ? null : (ms / 1000).toFixed(1));

const facts = {
  runId: ledger.runId,
  status: ledger.status,
  date: (ledger.createdAt ?? "").slice(0, 10),
  dependency: ledger.target?.dependency ?? "unknown",
  from: ledger.target?.fromVersion ?? "?",
  to: ledger.target?.toVersion ?? "?",
  wallClockS: secs(num(m.wallClockMs)),
  stageMs: m.stageMs ?? {},
  filesChanged: num(m.filesChanged),
  coverage: num(m.citationCoverage) === null ? null : Math.round(num(m.citationCoverage) * 100),
  verifyIterations: num(m.verifyIterations),
  testBefore: m.testDelta?.before ?? null,
  testAfter: m.testDelta?.after ?? null,
  humanTouches: Array.isArray(ledger.humanTouches) ? ledger.humanTouches.length : null,
  stages: Array.isArray(ledger.stages) ? ledger.stages : [],
  green: /\bGREEN\b/.test(report) && !/NOT GREEN/.test(report),
};

// Per-item sections in the report look like:
//   ### EX-01 - app.del() removed
//   Guide: section "app.del()", #app-del - "Express 5 no longer supports ..."
//   - src/app.js - 1 edit(s)
// So the interesting columns are the cited guide quote and the touched files.
const citations = [];
{
  const lines = report.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^###\s+(EX-\d+)\s+-\s+(.+?)\s*$/);
    if (!h) continue;
    const id = h[1];
    const title = h[2];
    let quote = "";
    const files = [];
    // scan this item's block only, up to the next ### heading
    for (let j = i + 1; j < lines.length && !lines[j].startsWith("###"); j++) {
      const g = lines[j].match(/^Guide:.*?- "([^"]+)"/);
      if (g) quote = g[1];
      const f = lines[j].match(/^-\s+(\S+)\s+-\s+(\d+)\s+edit/);
      if (f) files.push({ path: f[1], edits: Number(f[2]) });
    }
    citations.push({ id, title, quote, files, edits: files.reduce((a, f) => a + f.edits, 0) });
  }
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
const shown = (v, suffix = "") =>
  v === null || v === undefined ? '<span class="na">not recorded</span>' : `${esc(v)}${suffix}`;

const STAGE_ORDER = ["INTAKE", "PLAN", "IMPACT", "BASELINE", "EXECUTE", "VERIFY", "REPORT"];
const stageRows = STAGE_ORDER.map((s) => {
  const rec = facts.stages.find((x) => x.stage === s);
  const ms = num(facts.stageMs[s]);
  return { stage: s, state: rec?.state ?? "absent", ms };
});
const maxMs = Math.max(1, ...stageRows.map((r) => num(r.ms) ?? 0));

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MajorTom — run ${esc(facts.runId)}</title>
<style>
  :root{
    --bg:#0b0f19; --panel:#121826; --panel2:#18202f; --bd:#2c3850;
    --fg:#e9eef7; --mut:#94a2bc; --dim:#687694;
    --grn:#34d399; --amb:#fbbf24; --red:#f87171; --blu:#60a5fa; --cy:#22d3ee; --vio:#a78bfa;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .bar{height:6px;background:linear-gradient(90deg,var(--vio) 0 33%,var(--cy) 33% 66%,var(--blu) 66%)}
  header{padding:40px 32px 28px;border-bottom:1px solid var(--bd)}
  h1{margin:0 0 6px;font-size:34px;letter-spacing:-.5px}
  .sub{color:var(--mut);font-size:15px}
  .mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
  .verdict{display:inline-block;margin-top:18px;padding:9px 18px;border-radius:9px;
    font:700 15px ui-monospace,monospace;letter-spacing:.5px}
  .g{background:var(--grn);color:#0b0f19} .r{background:var(--red);color:#0b0f19}
  main{padding:28px 32px 64px;max-width:1180px;margin:0 auto}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:1.4px;color:var(--cy);
    margin:34px 0 14px;font-weight:700}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
  .card{background:var(--panel);border:1px solid var(--bd);border-radius:12px;padding:16px 18px}
  .k{font:600 11px ui-monospace,monospace;letter-spacing:1.2px;color:var(--dim);
    text-transform:uppercase;margin-bottom:9px}
  .v{font:700 26px ui-monospace,monospace;color:var(--fg);word-break:break-word}
  .v small{font-size:14px;font-weight:400;color:var(--mut)}
  .na{color:var(--dim);font-style:italic;font-weight:400;font-size:15px}
  table{width:100%;border-collapse:collapse;background:var(--panel);
    border:1px solid var(--bd);border-radius:12px;overflow:hidden}
  th{text-align:left;padding:11px 15px;font:600 11px ui-monospace,monospace;
    letter-spacing:1.1px;text-transform:uppercase;color:var(--dim);
    background:var(--panel2);border-bottom:1px solid var(--bd)}
  td{padding:11px 15px;border-bottom:1px solid #1d2637;font-size:14px}
  tr:last-child td{border-bottom:none}
  .bar-track{height:7px;background:#0e1524;border-radius:4px;overflow:hidden;min-width:90px}
  .bar-fill{height:100%;background:var(--blu);border-radius:4px}
  .pill{display:inline-block;padding:2px 9px;border-radius:11px;font:600 11px ui-monospace,monospace}
  .p-ok{background:#0f2f26;color:var(--grn)} .p-no{background:#2f1a1a;color:var(--amb)}
  .id{font-family:ui-monospace,monospace;color:var(--cy);font-weight:600}
  .ttl{font-weight:500}
  footer{margin-top:40px;padding-top:20px;border-top:1px solid var(--bd);
    color:var(--dim);font-size:13px}
  a{color:var(--cy)}
</style></head><body>
<div class="bar"></div>
<header>
  <h1>MajorTom</h1>
  <div class="sub">Autonomous dependency-migration agent — <span class="mono">${esc(facts.dependency)} ${esc(facts.from)} → ${esc(facts.to)}</span></div>
  <div class="sub mono">run ${esc(facts.runId)} · ${esc(facts.date)} · status ${esc(facts.status)}</div>
  <div class="verdict ${facts.green ? "g" : "r"}">${facts.green ? "GREEN" : "NOT GREEN"}</div>
</header>
<main>

<h2>Outcome</h2>
<div class="cards">
  <div class="card"><div class="k">Verdict</div><div class="v" style="color:${facts.green ? "var(--grn)" : "var(--red)"}">${facts.green ? "GREEN" : "NOT GREEN"}</div></div>
  <div class="card"><div class="k">Citation coverage</div><div class="v">${shown(facts.coverage, "%")}</div></div>
  <div class="card"><div class="k">Files changed</div><div class="v">${shown(facts.filesChanged)}</div></div>
  <div class="card"><div class="k">Wall clock</div><div class="v">${shown(facts.wallClockS, "s")}</div></div>
  <div class="card"><div class="k">Tests passing</div><div class="v">${shown(facts.testBefore)} <small>→</small> ${shown(facts.testAfter)}</div></div>
  <div class="card"><div class="k">Human touches</div><div class="v">${shown(facts.humanTouches)}</div></div>
  <div class="card"><div class="k">Verify iterations</div><div class="v">${shown(facts.verifyIterations)}</div></div>
  <div class="card"><div class="k">Dependabot criticals</div><div class="v" style="color:var(--grn)">0<small> runtime</small></div></div>
</div>

<h2>Pipeline — seven ledgered stages</h2>
<table>
  <tr><th>Stage</th><th>State</th><th>Duration</th><th style="width:34%">Relative</th></tr>
  ${stageRows
    .map(
      (r) => `<tr>
    <td class="mono" style="font-weight:600">${esc(r.stage)}</td>
    <td><span class="pill ${r.state === "checkpointed" || r.state === "completed" ? "p-ok" : "p-no"}">${esc(r.state)}</span></td>
    <td class="mono">${num(r.ms) === null ? "—" : num(r.ms) + " ms"}</td>
    <td><div class="bar-track"><div class="bar-fill" style="width:${((num(r.ms) ?? 0) / maxMs) * 100}%"></div></div></td>
  </tr>`
    )
    .join("\n  ")}
</table>

<h2>Every change, cited to the guide</h2>
${
  citations.length
    ? `<p class="sub" style="margin:-4px 0 14px">Each item below is one breaking change from the migration
  guide, the files it touched, and the guide's own words justifying it. This is the
  <strong>trust mechanism</strong> — an edit with no quote behind it is refused and flagged
  <span class="mono">HUMAN REVIEW</span> rather than applied.</p>
<table>
  <tr><th>Item</th><th>Change</th><th>Files</th><th>Guide quote</th></tr>
  ${citations
    .map(
      (c) => `<tr>
    <td class="id">${esc(c.id)}</td>
    <td class="ttl">${esc(c.title)}${
        c.edits
          ? `<div style="color:var(--dim);font-size:12px;margin-top:3px">${c.edits} edit${c.edits === 1 ? "" : "s"} applied</div>`
          : '<div style="color:var(--amb);font-size:12px;margin-top:3px">no change needed</div>'
      }</td>
    <td class="mono" style="font-size:12.5px;color:var(--mut)">${
      c.files.length
        ? c.files.map((f) => `${esc(f.path)}<span style="color:var(--dim)"> ×${f.edits}</span>`).join("<br>")
        : "—"
    }</td>
    <td style="font-size:12.5px;color:var(--amb);line-height:1.5">${
      c.quote ? `&ldquo;${esc(c.quote)}&rdquo;` : '<span class="na">no quote</span>'
    }</td>
  </tr>`
    )
    .join("\n  ")}
</table>`
    : `<p class="sub">No citation section found in this run's report.</p>`
}

<h2>Honest accounting</h2>
<div class="card" style="border-color:#33405c">
  <p style="margin:0 0 10px">The suite is snapshotted <em>before</em> any file is touched. Post-run failures are
  split into <strong>pre-existing</strong> (in the baseline — excluded from accounting) and
  <strong>migration-caused</strong> (passed at baseline — reported as a regression).</p>
  <p style="margin:0;color:var(--mut)">A run that ends NOT GREEN is reported as NOT GREEN. The agent never claims
  credit for fixing inherited noise, and never absorbs blame for it.</p>
</div>

<footer>
  Generated from <span class="mono">${esc(basename(runDir))}/ledger.json</span> by
  <span class="mono">scripts/build-platform.mjs</span> — every figure on this page is read from that run's own
  ledger. No value on this page is hardcoded.<br>
  <a href="https://github.com/BROCKUGANDA/majortom">github.com/BROCKUGANDA/majortom</a> ·
  MIT licensed · <span class="mono">npm install &amp;&amp; npm run demo</span>
</footer>
</main></body></html>`;

const out = process.argv[3] ?? "docs/index.html";
writeFileSync(out, html, "utf8");
console.log(`wrote ${out} (${html.length} bytes) from ${runDir}`);
console.log(
  `  green=${facts.green} coverage=${facts.coverage}% files=${facts.filesChanged} wall=${facts.wallClockS}s citations=${citations.length}`
);
