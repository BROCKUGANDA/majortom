# Demo narration script — MajorTom

Spoken track for `media/demo-narrated.mp4`. Timed to the 5-minute demo script.

These are **delivery notes**, not a teleprompter read. The phrasing is deliberately
conversational — short sentences, contractions, the kind of thing a person actually
says out loud. Numbers are the real ones from the recorded run.

## 0:00–0:30 — The problem

> Here's the thing about major version upgrades. The version bump itself is easy.
> It's one line. The breakage is what rots.
>
> So you get a Dependabot PR that sits open for three months, because nobody's
> willing to do the actual work. And look — the diff looks right. That's the
> problem. It looks correct, and then it throws at runtime.

## 0:30–1:15 — Launching the run

> MajorTom reads the official migration guide the same way you would — except it
> doesn't skim it.
>
> One command. Repo, dependency, target version, guide. And the timer starts.
>
> Watch what happens next.

## 1:15–2:00 — Plan and impact

> First it turns the guide into a structured plan. Twenty-one breaking changes,
> each one carrying a verbatim quote from the guide itself. Not a summary — the
> actual sentence.
>
> Then it scans the codebase and finds every call site. And here's the part I like:
> it splits the work into three completely disjoint queues. No two fixers can ever
> touch the same file.

## 2:00–2:45 — Parallel fixers

> Three fixers, running at the same time, on separate file sets. Each one is boxed
> in — it physically cannot write outside its own queue.
>
> And yes — we're running parallel agents to build the thing whose entire idea is
> running parallel agents.

## 2:45–3:30 — The trust moment

> This is the part that matters. Every single edit cites the guide section that
> justifies it.
>
> Scroll down. Here's `EX-02`. The change is `res.send` becoming `sendStatus` —
> and right above it, the guide's own words: *"Express 5 no longer supports the
> signature res.send(status)."*
>
> Nothing gets applied unless something in the guide justifies it. If it can't be
> cited, it gets flagged for human review instead. It refuses to guess.

## 3:30–4:15 — Verification

> Now the part that makes me trust it. Before touching anything, it snapshotted
> the test suite.
>
> Sixteen tests. One was already failing — and it's not Express, it's an
> arithmetic check we deliberately broke.
>
> After the run: still fifteen of sixteen, and that same one still failing. But
> zero failures attributable to the migration. It separates what it broke from
> what it inherited.
>
> It doesn't get credit for fixing the old one. And it doesn't get blamed for it.

## 4:15–4:45 — The PR

> Everything lands on a branch. Never main. Never force-pushed. Never merged.
> The pull request is the approval gate — that's the point.

## 4:45–5:00 — Close

> Fifteen seconds of wall clock, nine files, a hundred percent citation coverage,
> and it never once claimed a success it couldn't prove.
>
> Same pipeline runs against your internal library when no public codemod exists.
>
> `npm install` and `npm run demo`. That's it.
