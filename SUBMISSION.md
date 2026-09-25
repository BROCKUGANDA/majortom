# MajorTom — Submission

> **Judge's quick start:** `npm install` → `npm run demo`. That's it — no keys, no setup.
> Expect a GREEN verdict, 9 files changed, 100% citation coverage, exit code `0`.

---

## 1. Problem Statement *(467 words)*

A major-version dependency upgrade is one of the most feared tasks in software
maintenance, and the reason is not the size of the diff — it is that **the diff looks
right and the software is still broken.**

Express 5 is a concrete example. `app.del()` was removed. `res.send(status)` was
removed. `res.send(body, status)` was removed. Wildcard routes must be given names.
Optional route parameters must be rewritten with braces. Regex-style route paths no
longer compile. A developer who searches for each removed symbol finds them all,
edits them mechanically, and ships — to discover at runtime that `/:format?` became
required, that `/*` now throws at registration, and that their route table silently
matches nothing.

The existing tools do not solve this. Documentation describes what changed but not
*which lines in this repository are affected*. Search-and-replace finds tokens without
understanding whether a given occurrence is a call, a comment, a string, or a variable
of the same name. An LLM asked to "upgrade this project" will confidently produce a
plausible diff, cite nothing, and cannot tell you which of its changes were guesses.
Manual review catches the mistakes, but only after they have been written.

What is missing is a tool that **treats the vendor's migration guide as the source of
truth, applies only what that guide justifies, and then proves the result by running
the tests** — while being honest when the result is not green.

That honesty is the crux. Most migration tools report success. If a test was already
failing before the migration, the honest answer is "this migration did not break
anything, and it did not fix anything either" — and that distinction is exactly what
gets lost. A tool that cannot tell a pre-existing failure from a regression will
either block every migration on unrelated breakage, or wave through real regressions.

Teams upgrade dependencies rarely, expensively, and with dread. The cost is not the
typing. It is the fear of a silent breakage that surfaces in production.

**Keywords:** dependency migration, major-version upgrade, code modernization,
automated refactoring, static analysis, verification

---

## 2. Solution Statement *(489 words)*

**MajorTom** is a CLI-first agent that performs major-version dependency migrations
from the vendor's own migration guide, and refuses to claim success it cannot prove.

It takes four inputs: a repository, one dependency, a target version, and that
dependency's official migration guide as a PDF, Markdown file, or URL. It then runs
seven ledgered stages.

**PLAN** converts the guide into a structured plan where every item carries a verbatim
quote from the source. **IMPACT** scans the repository and partitions the affected files
into disjoint queues. **BASELINE** captures an honest pre-edit test result — if there are
no tests, the run is fatal, because nothing can be claimed without them. **EXECUTE**
applies edits through a filesystem facade that physically confines each worker to its
own queue, validates every result by parsing it, and rolls back anything that fails.
It then bumps the dependency manifest and reinstalls. **VERIFY** re-runs the suite and
classifies each failure as migration-caused or pre-existing. **REPORT** produces a
Markdown report in which every change is traced to the guide section that justifies it.

Three invariants make the output trustworthy. **I1:** work happens on
`majortom/<runId>`; `main` and `master` are refused, and no force-push or merge path
exists. **I2:** an edit is only made when a plan item authorises it, and citation
coverage is computed from real edit records rather than declared by the caller.
**I3:** the guide is treated strictly as data — instructions found inside a migration
document are ignored, so a malicious or confused document cannot redirect the tool.

The property that distinguishes MajorTom is **honest accounting**. A test that failed
before the migration is recorded in the baseline and excluded. A test that fails
because of the migration is reported as such. And when the migration is not green,
MajorTom says NOT GREEN and exits non-zero. A passing run and a failing run are equally
easy to produce, because the tool has no incentive to prefer either.

The current implementation performs a real express 4.18.2 → 5.1.0 migration: nine
files changed, 100% citation coverage, green, with the fixture's seeded pre-existing
failure correctly identified and excluded.

**Keywords:** autonomous agent, AI-assisted migration, verification, static analysis,
code transformation, developer tooling

---

## 3. IBM Bob Usage Statement *(421 words)*

IBM Bob was used as the primary implementation partner for MajorTom across all eight
phases. The work was structured as a phase-by-phase build against an immutable master
specification, with a comprehension check required before any code was written.

**How Bob was used, by phase.** Bob read the 655-line specification and the phase
prompt pack, then produced a written comprehension check — restating the runtime
pipeline, the hard invariants, and the non-goals — before a single line of code was
authored. This surfaced ambiguities early rather than after they had been encoded into
an implementation.

Phase 3 (scanner) built regex-based discovery with `ts-morph` confirmation, and a
partitioner producing disjoint fixer queues. Phase 4 (document ingestion) built PDF,
Markdown, and URL ingestion, hash recording, and deterministic plan extraction with
verbatim-quote validation and defenses against prompt injection inside guide content.
Phase 5 built the queue-scoped filesystem facade, the codemod engine, and the
dispatcher. Phase 6 built the test-runner adapters, failure classification, and the
bounded verification loop. Phase 7 built secret redaction, the report generator, and
the git safeguards. Phase 8 assembled the seven-stage orchestrator, the CLI, and the
end-to-end suite.

**Where Bob's assistance was most valuable.** Diagnosis. Several defects were
misdiagnosed multiple times before the real cause was found, and each time the
reliably productive move was to stop theorising and inspect actual bytes and real
output. One bug — an edit validator rejecting every valid CommonJS file because it ran
the TypeScript *compiler* where the spec asked only for a *parse* check — was found by
running the transformation in isolation and observing that it produced the correct
output which was then being discarded. A second, more serious bug — a regular
expression matching a comma inside an object literal and silently corrupting data —
was found only after wiring the fixer's output through a real parse check and reading
the actual mangled line.

Bob was also used for verification discipline: running every acceptance command for
real, including full end-to-end migrations, and refusing to accept piped output that
could mask a failure. The result is a project where 138 tests pass and the demo reaches
a green verdict on a live migration.

---

## 4. Application & Code

| Field | Value |
|---|---|
| **Public code repository** | **https://github.com/BROCKUGANDA/majortom** |
| **MIT License** | MIT — see [`LICENSE`](./LICENSE) |
| **Branches** | `main` (stable) · `staging` (release candidate) · `development` (active work) |
| **Application URL** | **https://brockuganda.github.io/majortom/** — live dashboard for the recorded run: verdict, per-stage timings, and every applied change listed with the guide section that justifies it. Regenerate with `npm run demo:platform`. |
| **Demo Application Platform** | GitHub Pages (static, served from `/docs` on `main`). The page is generated from that run's own `ledger.json` — no figure on it is hardcoded. MajorTom itself is a CLI; the platform is the run inspector. |
| **IBM Bob session summaries** | *(attach per-member screenshots — see §7)* |

**Repository layout**

```
src/cli/      CLI entry point          src/verify/   test adapters, classification
src/core/     ledger, orchestrator,    src/report/   redaction, report, git
              manifest bump            fixtures/     seeded express@4 app
src/docs/     guide ingestion          guides/       the Express 5 guide
src/scanner/  impact + partitioning    tests/        9 projects, 138 tests
src/agents/   facade, fixer, dispatcher
```

**Where Bob assisted:** all of `src/`, all of `tests/`, `README.md`, `ROADMAP.md`, and CI.

---

## 5. Media & Presentation

| Deliverable | Status |
|---|---|
| Cover image | *(attach)* |
| Video demonstration | *(attach — **≤ 3 minutes**, with **≥ 90 seconds** showing the solution in action)* |
| Slide presentation | *(attach)* |

**Suggested 3-minute video structure**

| Time | Content |
|---|---|
| 0:00–0:25 | The problem: why a correct-looking upgrade still breaks at runtime |
| 0:25–0:45 | `npm run demo` — the real migration running, live |
| 0:45–1:30 | **The 90-second core:** the generated report, every change citing its guide section |
| 1:30–2:00 | The honest-failure case: seeded pre-existing failure correctly excluded |
| 2:00–2:30 | Code walkthrough: the facade that physically confines edits to their queue |
| 2:30–3:00 | Close: run it yourself with `npm install && npm run demo` |

---

## 6. Requirements checklist

- [x] **Problem & Solution Statement** — both complete, each under 500 words (§1, §2)
- [x] **IBM Bob Usage Statement** — under 500 words (§3)
- [x] **Code in the repository** — all of `src/` and `tests/`
- [x] **MIT License** — `LICENSE` at repo root
- [x] **Public repository URL** — recorded in §4
- [ ] **IBM Bob task session summary screenshots** — attach per team member (§4)
- [ ] **Video ≤ 3 min with ≥ 90 s of the solution in action** — see structure in §5
- [ ] **Cover image and slide deck** — see §5

---

## 7. Notes for the judges

**If you only do one thing:** `npm install && npm run demo`. It needs no API keys and
no network access, and it runs the complete seven-stage pipeline against a real
Express 4 application.

**What to look at afterwards**

1. `.test-sandbox/demo/.majortom/runs/*/artifacts/report.md` — every change cited
2. `src/agents/facade.ts` — how fixer writes are physically confined to their queue
3. `src/verify/classify.ts` — how pre-existing failures are separated from regressions
4. `ROADMAP.md` §2 — what is **not** built, stated plainly

**Known limits, stated up front.** There is no GitHub, OSV, or Slack integration — the
PR path is a tested seam with no implementation behind it. Only npm manifests are
handled end to end. The codemods are written against the Express 5 guide, so migrating
a different dependency means writing new ones; the *framework* is generic, the
knowledge is not. And for one specific case the guide's literal example does not work
on express 5.1.0 — MajorTom emits verified-working syntax instead and documents why.
Full detail in `ROADMAP.md`.
