# Submission form answers

Copy-paste blocks. Counts verified against the form limits.
Numbers match the repo at `c1ae870` — 138/138 tests, `npm audit --omit=dev` = 0,
demo verdict GREEN, 9 files changed, 100% citation coverage, 19.5s wall clock.

---

## 1. Short Description

**233 characters** (limit 255, min 50)

> MajorTom is an autonomous dependency-migration agent that upgrades a package from the vendor's own migration guide, cites every change to the guide section justifying it, and refuses to report success unless the test suite proves it.

---

## 2. Long Description — Problem & Solution Statement

**500 words** (limit 500)

A major-version dependency upgrade is one of the most feared tasks in software maintenance, and the reason is not the size of the diff — it is that **the diff looks right and the software is still broken.**

Express 5 is a concrete case. `app.del()` and `res.send(status)` were removed, wildcard routes must be named, optional route parameters need braces, and regex-style paths no longer compile. A developer who edits each removed symbol ships code that then throws at runtime: `/:format?` became required, `/*` fails at registration, and the route table silently matches nothing.

**Target users** are teams on frameworks and libraries — the engineers who own upgrades, and the security teams waiting on the CVE behind one.

Existing tools do not solve this. Documentation says what changed, not which lines in *this* repository are affected. Search-and-replace finds tokens without knowing whether an occurrence is a call, a comment, or a same-named variable. An LLM asked to "upgrade this" produces a plausible diff, cites nothing, and cannot say which were guesses.

**Our solution.** MajorTom performs the migration from the vendor's own guide and refuses to claim success it cannot prove. It takes a repository, a dependency, a target version, and that guide as PDF, Markdown, or URL, then runs seven ledgered stages.

**PLAN** turns the guide into a plan where every item carries a verbatim quote. **IMPACT** scans the repository and partitions affected files into disjoint queues. **BASELINE** captures a pre-edit test result; with no tests the run is fatal, because nothing can be claimed without them. **EXECUTE** applies edits through a facade that confines each worker to its own queue, validates every result by parsing it, rolls back failures, then bumps the manifest and reinstalls. **VERIFY** re-runs the suite and classifies each failure. **REPORT** traces every change to its guide section.

Three invariants make it trustworthy. **I1:** work happens on `majortom/<runId>`; `main` and `master` are refused and no force-push or merge path exists. **I2:** an edit is applied only when a plan item authorises it, and citation coverage is computed from real edit records, never declared by the caller. **I3:** the guide is treated as data, so a malicious document cannot redirect the tool.

What makes it creative is the trust mechanism. Citation coverage is a computed number, not a promise — an edit with no guide quote behind it is refused and flagged `HUMAN REVIEW` rather than applied. The distinguishing property is **honest accounting**. A test that failed before the migration is recorded and excluded; a test that fails because of it is reported as such; and when the run is not green, MajorTom says NOT GREEN and exits non-zero. A passing run and a failing run are equally easy to produce, because the tool has no incentive to prefer one.

**Measured on a real run:** Express 4.21.2 → 5.1.0, nine files changed, 16 of 16 edits cited, 19.5 seconds, one pre-existing failure excluded. The project ships 138 tests and zero runtime CVEs.

---

## 3. IBM Bob Usage Statement

**427 words** (limit 500)

IBM Bob was the primary implementation partner for MajorTom across all eight phases. The work was structured as a phase-by-phase build against an immutable 655-line master specification, with a comprehension check required before any code was written.

**How Bob was used, by phase.** Bob read the specification and the phase prompt pack, then produced a written comprehension check — restating the runtime pipeline, the hard invariants, and the non-goals — before a single line of code was authored. This surfaced ambiguities early rather than after they had been encoded into an implementation.

- **Phases 0–2** — repository scaffolding, type definitions, error taxonomy.
- **Phase 3 (scanner)** — regex-based discovery with `ts-morph` confirmation, plus a partitioner producing disjoint fixer queues.
- **Phase 4 (document ingestion)** — PDF, Markdown, and URL ingestion; hash recording; deterministic plan extraction with verbatim-quote validation and defenses against prompt injection inside guide content.
- **Phase 5** — the queue-scoped filesystem facade, the codemod engine, and the dispatcher.
- **Phase 6** — Vitest and Jest adapters, failure classification, the bounded verification loop.
- **Phase 7** — secret redaction, the report generator, git safeguards.
- **Phase 8** — the seven-stage orchestrator, the CLI, and the end-to-end suite.

**Where Bob's assistance was most valuable was diagnosis.** Several defects were misdiagnosed repeatedly before the real cause was found, and each time the productive move was to stop theorising and inspect actual bytes and real output. One bug — a validation step rejecting every valid CommonJS file because it ran the TypeScript *compiler* where the spec required only a *parse* check — was found by running the transformation in isolation and observing that it produced correct output which was then discarded. A second, more serious bug — a regular expression matching a comma inside an object literal and silently corrupting data — surfaced only after wiring the fixer's output through a real parse check and reading the actual mangled line.

**Verification discipline.** Every acceptance command was executed for real, including full end-to-end migrations, and piped output that could mask a failure was refused. The result is 138 passing tests and a green verdict on a live migration.

**On IBM watsonx.ai / watsonx Orchestrate:** not used. The pipeline is deterministic and local — guide ingestion, impact scan, codemods, and verification run without any model call. The one model-shaped step, parallel fixer dispatch, is orchestrated by MajorTom's own ledger, which checkpoints all seven stages for resumability. Adding watsonx Orchestrate would mean making a network dependency out of a process that currently cannot be stalled by a venue's wifi.

---

## Note on stale numbers

`SUBMISSION.md` in the repo still says **153 tests (154 total)** in two places. The real,
verified count is **138 passing across 9 Vitest projects**. Update those lines before
pasting anything from that file into the form.
