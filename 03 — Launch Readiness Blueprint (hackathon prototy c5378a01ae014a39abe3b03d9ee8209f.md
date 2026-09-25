# 03 — Launch Readiness Blueprint (hackathon prototype → controlled paid launch)

<aside>
🧭

Launch definition for MajorTom: *a new customer can discover it, install the GitHub App, run a real upgrade on a real repo, review a cited PR, pay, recover from a failed run, contact support, and uninstall — without you touching a terminal or the database.*

</aside>

## §0 Launch contract

| Field | MajorTom |
| --- | --- |
| Target customer | Platform engineers and team leads at SMB–midmarket product companies (5–100 services) on Node/TypeScript, behind on majors and CVE patches. Secondary: solo builders maintaining 3+ active repos. |
| Painful job | Major-version and CVE-driven upgrades stall 2–6 weeks each. Bumping the version is easy; fixing scattered breakage is the job. Patches deferred, PRs rot, "next quarter" forever. |
| Before → after | Before: multi-week manual migration, uncited changes, unclear blast radius. After: a tested upgrade PR on a throwaway branch within the hour, every change cited to the official guide, pre-existing failures separated from migration failures. |
| Activation event | First run completes on the customer's own repo and a PR opens with a Migration Report. |
| Retention signal | The PR gets merged. Then the next dependency. |
| Core loop | Drift scan → CVE or major release fires → pick candidate → run → review cited PR → merge. Monthly, budgetable, predictable. |
| Paid claim | "Install the GitHub App, pick a dependency, point at a migration guide. Get a tested, guide-cited upgrade PR within the hour. You review, you merge." |
| Non-goals v1 | One ecosystem (npm) done deep, GitHub only, PR-gated human approval only. No auto-merge, no dashboard, no fleet view, no other languages, no self-hosted. |

## §1 Product readiness

### 1.1 Critical user journeys — each with the failure paths that must be handled

| # | Journey | Failure paths that must be finished, not just happy path |
| --- | --- | --- |
| 1 | Landing → sign up with GitHub → workspace → App install → repo select | Install revoked mid-onboarding; org install needs admin approval; zero accessible repos (empty state offering the public demo repo) |
| 2 | First run: own repo or sample repo → plan → execute → PR + report | Repo with no tests (blocked with an explanation and an "add a baseline first" path); no lockfile; monorepo; pre-existing failing tests (proceed, flagged) |
| 3 | Main workflow: pick dependency → attach guide (PDF or URL) → run → review PR | Corrupt PDF; 500-page guide (page cap); guide for the wrong version (mismatch warning); no breaking patterns found (report says so honestly — a good outcome) |
| 4 | Auth: GitHub OAuth primary, email+password fallback, reset and recovery | Session expires mid-configuration; GitHub authorization revoked (re-auth path, runs keep state) |
| 5 | Run errors | Worker killed mid-run; sandbox network loss during install; GitHub rate limit; model provider outage; hard timeout. Run is resumable from the ledger, never silently lost; branch left clean; stage-level reason shown |
| 6 | Subscription: 14-day trial → paid → failed payment → cancel → reactivate | Payment fails mid-run: in-flight run completes, new runs blocked; dunning; grace period |
| 7 | Data lifecycle: export, delete workspace, remove member | **GitHub App uninstall is the critical leave path**: webhook → revoke tokens → scheduled deletion → confirmation email, no support ticket needed |
| 8 | Support: docs, contact email, in-app "report run issue" | Support can pull a redacted run audit trail by run ID without database access |

### 1.2 Launch scope tiers

**Must have:** journeys 1–8, billing, backups with a tested restore, per-run sandbox isolation, audit trail, privacy/terms/DPA, support email, status page.
**Can launch without:** fleet dashboard, multi-ecosystem, scheduled recurring runs, Slack notifications, roles beyond owner/member, SSO.
**Do not build yet:** auto-merge, org policy engine, self-hosted deployment, fine-tuned models, metered billing (hard limits are simpler and shippable).

## §2 Production checklist

### 2.1 Architecture

```
Next.js app (marketing + app + API)
  ├─ Postgres (managed, PITR)   workspaces, installations, repos, runs, run_events,
  │                             plan_items, applied_changes, webhook_events,
  │                             entitlements, usage_counters, audit_log
  ├─ Object storage (private)   uploaded guides, reports, run artifacts, exports
  ├─ Durable queue             run jobs, webhook processors, deletion jobs
  ├─ Orchestrator worker       drives the 7-stage state machine, checkpoints per stage
  └─ Ephemeral sandbox         one single-use microVM/container per run
GitHub App (webhooks + short-lived installation tokens)
Stripe (Checkout + Customer Portal + webhooks)
```

The hackathon's JSON run ledger becomes the `runs` + `run_events` tables unchanged in shape. API validates and enqueues; the customer never waits on an HTTP request for a 45-minute agent run; the UI polls durable job status.

### 2.2 Idempotency and degradation

Idempotent: run creation (key = repo + commit SHA + target dep@version + no active run), Stripe and GitHub webhook processing, stage retries, deletion jobs. Degradation: model provider down → run parks in `paused/provider_unavailable` and auto-resumes; GitHub down → same; queue stuck → alert plus stale-run marking. Capacity: 1 concurrent run on Solo, 2 on Team; repo size cap; 5,000-file scan cap; 20 MB / 60-page guide cap; rate limits on auth and run-start.

### 2.3 Data model (starting DDL — hand to Opus to complete)

```sql
create table workspaces (
  id uuid primary key, name text not null, created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table installations (
  id uuid primary key, workspace_id uuid not null references workspaces(id),
  github_installation_id bigint not null unique, account_login text not null,
  suspended_at timestamptz, uninstalled_at timestamptz
);
create table repos (
  id uuid primary key, workspace_id uuid not null references workspaces(id),
  installation_id uuid not null references installations(id),
  github_repo_id bigint not null, full_name text not null, default_branch text not null,
  unique (workspace_id, github_repo_id)
);
create table runs (
  id uuid primary key, workspace_id uuid not null references workspaces(id),
  repo_id uuid not null references repos(id),
  idempotency_key text not null unique,
  dep_name text not null, from_version text, to_version text not null,
  base_commit_sha text not null, work_branch text not null,
  stage text not null, status text not null,          -- running|completed|failed|cancelled
  citation_coverage numeric, wall_clock_ms integer,
  pr_url text, created_at timestamptz not null default now(), ended_at timestamptz
);
create index on runs (workspace_id, created_at desc);
create table run_events (                              -- append-only checkpoint log
  id bigserial primary key, run_id uuid not null references runs(id),
  seq integer not null, stage text not null, state text not null,
  payload_ref text, error_code text, at timestamptz not null default now(),
  unique (run_id, seq)
);
create table plan_items (
  id uuid primary key, run_id uuid not null references runs(id),
  item_id text not null, kind text not null, severity text not null,
  citation_section text not null, citation_locator text not null, confidence numeric
);
create table applied_changes (
  id uuid primary key, run_id uuid not null references runs(id),
  file_path text not null, plan_item_id text, queue_id text,
  human_review_code text, created_at timestamptz not null default now()
);
create table webhook_events (
  id uuid primary key, source text not null,           -- stripe|github
  external_id text not null, payload jsonb not null, signature_verified boolean not null,
  processed_at timestamptz, unique (source, external_id)
);
create table entitlements (
  workspace_id uuid primary key references workspaces(id),
  plan text not null, status text not null,            -- trialing|active|past_due|canceled
  repo_limit integer not null, runs_per_month integer not null, concurrency integer not null,
  current_period_end timestamptz
);
create table usage_counters (
  workspace_id uuid not null references workspaces(id), period_start date not null,
  runs_started integer not null default 0, primary key (workspace_id, period_start)
);
create table audit_log (
  id bigserial primary key, workspace_id uuid not null, actor text not null,
  action text not null, target text, metadata jsonb, at timestamptz not null default now()
);
```

Every query is scoped by `workspace_id`, and every repo access is re-verified against the live GitHub App installation for the requesting user. Never trust a repo ID from the client.

### 2.4 The sandbox is the security core

MajorTom installs dependencies and runs tests on customer code — the same risk class as CI, plus an agent.

| Control | Requirement |
| --- | --- |
| Isolation | Fresh single-use microVM or container per run (Fly Machines / Modal / Fargate — do not build Firecracker yourself), destroyed after the run |
| Network | Egress allowlist: package registry only. Cloud metadata endpoint `169.254.169.254` blocked. No arbitrary outbound |
| Install | `--ignore-scripts` by default; lifecycle scripts opt-in per repo, logged, surfaced in the report |
| Credentials | Installation-scoped GitHub token: contents RW, pull requests RW, metadata R — nothing else. Short TTL, injected per run, revoked after |
| Limits | CPU/memory caps, 45-minute hard timeout, bounded fix loop, per-tenant token budget enforced mid-run |
| State | No persistent storage in the sandbox; all durable state exits via orchestrator checkpoints |

### 2.5 Threat model

| Threat | Control |
| --- | --- |
| Supply-chain attack via package lifecycle scripts | Ephemeral sandbox, `--ignore-scripts`, egress allowlist, no credentials inside, timeout kill |
| Sandbox escape / metadata theft | Single-use VMs, metadata endpoint blocked, no long-lived credentials present |
| Repo secrets exfiltrated through model context | Secret-pattern redaction before any content reaches a model; contents never logged; disclosed on the security page |
| Prompt injection from migration guides *and* repo files | Guides and repo content are data (I3); allowlisted tools only; no arbitrary shell; no network from fixers; injection attempts logged as warnings |
| Model output corrupts code or escapes scope | Filesystem facade rejects out-of-queue paths; AST/parse validation before commit; uncited edits flagged, not applied |
| Cross-tenant repo access | Installation re-verified per request; tenant-scoped queries; automated cross-tenant probe suite in CI |
| Provider retains customer code | Zero-retention API terms, published sub-processor list, "we do not train on your code" |
| Runaway agent spend | Per-tenant token, duration, and concurrency caps enforced mid-run |

### 2.6 OWASP ASVS L2 mapping (condensed)

| ASVS area | MajorTom control |
| --- | --- |
| Architecture | Documented trust boundaries: browser → API → queue → orchestrator → sandbox → GitHub |
| Authentication | GitHub OAuth primary; hardened email fallback; MFA on internal admin |
| Session management | Secure httpOnly cookies, short-lived tokens, revocation on GitHub deauthorization |
| Access control | Server-side authorization on every action; workspace scoping; installation re-verification |
| Validation and encoding | Zod on every API boundary; PDF type/size/page validation; output encoding |
| Cryptography and secrets | Managed secret store, rotation policy, no secrets in Git, logs, bundles, or sandbox images |
| Errors and logging | Structured logs with run_id and workspace_id; PII and secret redaction; append-only audit log |
| Data protection | Encryption in transit and at rest; retention and deletion policy; export |
| API and config | Rate limits on auth, run-start, uploads; immutable build artifacts; pinned dependencies |
| Business logic | Idempotent run creation and webhooks; plan limits enforced server-side |

### 2.7 Data protection and recovery

Managed Postgres with automated backups and PITR, plus a **monthly restore drill into a clean environment** — tested, not assumed. Retention: run artifacts and logs 30 days, reports 90 days (1 year on Team), account data until deletion plus a 30-day grace. Uninstall triggers token revocation and a scheduled deletion job with an emailed confirmation. Export is a self-serve zip of reports and run ledgers.

**The 2 PM drill, MajorTom edition:** the `runs` table corrupts mid-day. Restore from PITR, estimate lost runs, re-enqueue incomplete runs from their last checkpoint, notify affected customers, resume. If any step is unclear, you are not ready.

### 2.8 Observability

**Metrics:** run start/success/fail rate, per-stage duration, fixer iterations, citation coverage distribution, token spend per run and per tenant, queue depth, webhook failures, signup→activation conversion, PR merge rate (the real product metric).
**Alerts** (each states what failed, who owns it, likely impact, first action): queue stuck > 15 min, run-failure rate spike, GitHub or Stripe webhook failures, backup job failure, sandbox timeout spike, token-spend anomaly, activation-rate drop.
**Runbooks:** stuck run, failed restore, GitHub outage, Stripe webhook outage, suspected malicious package, suspected prompt-injection incident, bad migration reported by a customer, deployment rollback.

## §3 Commercial readiness

### 3.1 Pricing and packaging (2 self-serve tiers + contact)

|  | Solo — $49/mo | Team — $149/mo |
| --- | --- | --- |
| Repos | 3 | 15 |
| Runs per month | 5 | 25 (hard limit → upgrade prompt) |
| Concurrency | 1 | 2 |
| Report retention | 90 days | 1 year + export |
| Support | Email | Priority email |

Business (SSO, DPA, longer retention, more repos) is "contact us" — do not self-serve enterprise during a controlled launch. **Pricing needs validation:** benchmark against Codemod, OpenRewrite support contracts, and per-seat AI dev tools before publishing.

**Policies to publish:** 14-day Team trial, no card. At plan limits new runs are blocked with an upgrade CTA while in-flight runs finish. Failed payment blocks new runs immediately, 7-day grace, then read-only — reports and export stay accessible forever. Cancellation is end-of-period, self-serve. Refunds: 14 days, no questions, first subscription. The charge is justified by the completed run and cited PR.

### 3.2 Billing implementation

Stripe Checkout and Customer Portal so card data never touches your server. Verify webhook signatures, store raw events for replay, process idempotently. **Entitlements derive only from verified webhook state, never from a redirect.** Plan and price IDs in config.

Sandbox test matrix: new subscription, trial conversion, upgrade, downgrade, payment failure, payment recovery, cancellation, reactivation, duplicate webhook, out-of-order webhook, late webhook after the browser closed. All must converge to correct entitlement state.

### 3.3 Trust assets (for a code-touching AI product these are the sales collateral)

Standard: ToS, privacy policy, cookie notice, AUP, refund/cancellation policy, retention/deletion policy, DPA, security page with vulnerability disclosure, company identity and tax info.
MajorTom-specific: a plain-language **code-handling disclosure** (what is sent to models, which sub-processors under zero-retention terms, no training on customer code, retention windows, deletion mechanics); a **security page describing the ephemeral sandbox** — most AI coding tools cannot say this, so say it loudly; documented deletion-on-uninstall and pre-departure export.

### 3.4 Sales surface

Under a minute the site must answer: what it is (autonomous dependency-upgrade engineer), who it is for (teams behind on majors and CVEs), the result ("tested, guide-cited upgrade PR in under an hour"), how (install → run → review PR), cost, data safety, how to try, how to get help or leave.

**Proof beats claims, and MajorTom's proof is inherently shareable:** publish one full sample Migration Report as a public page, a public demo repo anyone can install on, a 90-second real run with a timer, and pilot metrics. Pages: home, product, pricing, sign-up/login, getting started, FAQ (lead with security), privacy, terms, contact, status.

## §4 Launch acceptance tests

**Core:** fresh account → GitHub sign-up → App install → run on a *realistic* repo (pre-existing failures, imperfect lockfile, monorepo-ish) → activation reached → every error explains the next step → invite and remove a member → export → uninstall triggers deletion confirmation. Zero manual database edits anywhere.
**Payment:** trial → paid → correct entitlements; duplicate webhook leaves state correct; failed payment produces the documented state; upgrade/downgrade/cancel self-serve; invoices reachable; state correct after closed browser, failed redirect, and late webhook.
**Failure (break it on purpose in staging):** kill the worker mid-run (resumable, no silent loss); kill the sandbox mid-install (clean failure, branch untouched, retry works); duplicate and out-of-order webhooks; GitHub outage mid-run; model provider outage; invalid PDF; 5,000-file repo; session expiry mid-config; DB restore into a clean environment; deployment rollback; cross-tenant probing via manipulated IDs and payloads must be denied.

<aside>
🛑

**Block launch if:** you cannot restore production data · cross-tenant repo access is possible · duplicate charges are possible · there is no rollback path · errors vanish without logs or alerts · a customer cannot reset access or reach support · **the sandbox can reach cloud credentials, or repo secrets appear in logs or reports** · you cannot say what code you store, who can access it, and how it is deleted · every signup needs you.

</aside>

## §5 Lean v1 stack (solo-builder standard)

Next.js app · managed Postgres with PITR · managed private object storage · GitHub OAuth + GitHub App · per-run sandboxes on Fly Machines or Modal (do not build isolation yourself) · managed queue · Stripe Checkout + Portal · CI/CD with staging, production, and versioned migrations · error tracking, uptime monitor, the alert set in §2.8 · legal pages and support email · onboarding aimed at first run in under 10 minutes. No Kubernetes, no microservices, no SOC 2 yet — but do the restore drill and the failure tests.

## §6 Ship / no-ship

Ready for a controlled paid launch when: 5–20 target users independently install and reach a first cited PR · the main workflow is reliable on realistic repos and realistic failures · billing state survives webhook chaos · you can deploy, observe, roll back, restore, and support · pricing, terms, privacy, and cancellation are public and plain · a weekly feedback-to-fix loop is actually running.

## §7 Opus expansion queue (post-hackathon track)

1. Benchmark pricing against Codemod, CodeRabbit, and comparable dev-tool SaaS; validate tiers and run limits.
2. Compare Fly Machines vs Modal vs Fargate for per-run sandboxes: cost per 45-minute run, cold start, egress control. Pick one, with rationale.
3. Complete the threat model and the full ASVS L2 control mapping.
4. Finish the DDL in §2.3: indexes, constraints, retention jobs, migration order.
5. Draft the security page and code-handling disclosure in customer language; list sub-processors and their zero-retention options.
6. Write the GitHub App permission manifest (least privilege) and the secret-redaction pattern list with tests.
7. Turn §4 into executable test scripts; script the 2 PM restore drill step by step.
8. Landing and pricing page copy built on the proof assets (sample report, demo repo, run video).