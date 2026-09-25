# MajorTom — Roadmap

This document is honest about three separate things: **what works today**, **what was
deliberately left out**, and **what comes next**. Nothing in "Not built" is claimed
elsewhere in this repo.

---

## Status legend

| | Meaning |
|---|---|
| ✅ **Built** | Implemented and covered by an acceptance test that runs in CI |
| ⚠️ **Partial** | Works, but with a known limitation stated below |
| ⛔ **Not built** | Deliberately out of scope or blocked on a decision |

---

## 1. Core pipeline — ✅ Built

All seven stages are implemented, ledgered, and resumable.

| Stage | Status | Notes |
|---|---|---|
| `INTAKE` | ✅ | Repo snapshot, base commit, run branch, guide fingerprint |
| `PLAN` | ✅ | Guide → structured plan; every item carries a verbatim quote |
| `IMPACT` | ✅ | Regex discovery + ts-morph confirmation; disjoint queue partition |
| `BASELINE` | ✅ | Honest pre-edit test capture; no tests ⇒ fatal `E_NO_TESTS` |
| `EXECUTE` | ✅ | Cited, queue-scoped edits + rollback, manifest bump, reinstall |
| `VERIFY` | ✅ | Bounded loop; migration-caused vs pre-existing separated |
| `REPORT` | ✅ | Cited Markdown, computed coverage, diff patch, metrics |

### Invariants — ✅ Enforced by tests

- **I1** never touches a protected branch; no force-push, no merge path exists
- **I2** every edit is plan-driven and carries a citation; coverage is computed from
  real edit records, never passed in by a caller
- **I3** guide content is data; injected instructions are ignored
- **I4** bounded retries everywhere — fixers and the verify loop both terminate
- **I5** fixer writes are physically confined to its queue by a filesystem facade
- **I7** runs are resumable and idempotent; same key ⇒ same runId
- **I8** pre-existing failures are excluded from migration accounting
- **I9** no user data is ever interpolated into a shell command

### Proven end to end

`npm run demo` performs a real express 4.18.2 → 5.1.0 migration: 10 files changed,
15 edits, 100% citation coverage, **GREEN** with the one seeded pre-existing failure
correctly excluded. Exit code `0`.

---

## 2. Deliberately NOT built

This is the section that matters most. Each item is a real gap, not an oversight.

### ⛔ External integrations — none exist

There is **no** GitHub API integration, **no** OSV/CVE lookup, **no** Slack
notification, and **no** live ticker UI. Concretely:

- `src/report/git.ts` accepts an **injected** `octokit`-shaped object. No `octokit`
  dependency is installed, nothing constructs that object, and no call site exists.
  The module is a tested seam, not a working integration.
- There is no HTTP client anywhere in `src/`. The only outbound calls are `npm install`
  and guide-by-URL ingestion.
- A demo PR cannot be opened. `npm run demo` produces the **draft-PR payload and
  report artifacts on disk**, which is what a human or a follow-up step would submit.

**Why:** adding `octokit` would violate the standing project constraint *"don't add
dependencies beyond what the spec pins."* A real PR additionally requires a GitHub
token that is not present in this environment. Both need an explicit decision.

### ⛔ No web dashboard

MajorTom is a CLI. There is no browser UI and no server component.

### ⚠️ Single ecosystem

Only `npm` manifests are handled end to end. `go.mod`, `pyproject.toml` and
`Cargo.toml` have version *readers* in `src/core/manifest.ts`, but no ecosystem
scanner, codemod set, or test-runner adapter exists for them.

### ⚠️ Express-5-shaped codemods

The 21 codemods are written against the Express 5 guide. They are not a general
codemod engine: migrating a different dependency means writing new ones. The
*framework* (plan → queue → facade → verify → report) is generic; the knowledge is not.

### ⛔ No hosted service

No multi-tenancy, no auth, no database, no job queue. This is a library and a CLI.

---

## 3. Known limitations

Stated plainly, because a tool that overstates itself is worse than one that doesn't work.

| Limitation | Impact |
|---|---|
| **The guide is not always literally correct.** | For optional route params, the Express 5 guide's example (`/:format{:format}`) throws on express 5.1.0 — verified against the real router. MajorTom emits `/:id{/:format}` and documents why in `src/agents/fixer.ts`. **It follows verified working syntax over the guide's literal text.** |
| **Anthropic models may drift on plan extraction.** | Guide parsing is deterministic and regex/structure-driven, with no LLM in the hot path, so this is largely mitigated. But document-understanding quality still bounds extraction quality on unusual guides. |
| **A committed lockfile can hide a failed bump.** | `npm install` honours an existing `package-lock.json`. MajorTom therefore installs the target spec explicitly and verifies the result. |
| **Reinstall cost.** | The manifest bump triggers a real `npm install`, which can take minutes on a large repo. Bounded by a timeout; a failure is reported, never swallowed. |
| **One fixture.** | Acceptance testing is against one seeded express@4 app with 21 known breakages. That is a real migration, but it is not a broad corpus. |
| **Route-regex codemods are textual.** | EX-12 (`/api/(v1|v2)/status` → an array of paths) is a source transform, not an AST rewrite. It is validated by parse-check and rollback, but it is not semantically equivalent to a full router analysis. |

---

## 4. Next — in priority order

### Near term

1. **GitHub PR integration.** Wire `octokit` into the existing `git.ts` seam: create the
   draft PR, apply labels, post the metrics comment. Blocked on: a dependency decision
   and a scoped token.
2. **OSV.dev CVE lookup.** Drives prioritisation and a report header. Public API, no
   auth. Needs a cached-fixture fallback so the demo survives venue wifi.
3. **Live terminal ticker.** Render the three parallel fixer queues as live cards. Pure
   output — no new dependencies.
4. **A second ecosystem.** Pick the highest-value target (Go modules or Python) and prove
   the framework generalises beyond npm.

### Medium term

5. **CONSTRAINTS.md support** — read the repo's own stated constraints and reflect them in
   the report.
6. **Widening the fixture corpus** — more breakages, more guide shapes, malformed guides.
7. **Non-Express codemods** to demonstrate the framework generalising.

### Longer term

8. **Constrained planning under a real LLM** for guides whose rules resist deterministic
   extraction, with the existing schema as the validation boundary.
9. **CI for a real customer-shaped repo**, not only the fixture.

---

## 5. If you only read one thing

MajorTom's value is not that it upgrades dependencies. It is that it **refuses to claim
success it cannot prove**: it captures an honest baseline before touching anything, cites
the guide for every edit, separates pre-existing failures from migration regressions, and
reports NOT GREEN when the migration is not green.

That property is the product. Everything else is a means of earning the right to say it.
