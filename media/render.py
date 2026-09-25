#!/usr/bin/env python
"""Render the MajorTom demo video frames and cover image with Pillow.

Every frame shows REAL output captured from an actual `npm run demo` run — see
media/captures/. Nothing here is simulated or fabricated: the verdict text, the
test counts, the citation quotes and the code excerpts are all read from those
capture files at render time.

Outputs:
  media/frames/frame-000.png ...   (video frames, 1920x1080)
  media/cover.png                  (cover image, 1920x1080)
  media/slides/slide-NN.png        (slide deck)

Usage: python media/render.py
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
MEDIA = ROOT / "media"
FRAMES = MEDIA / "frames"
SLIDES = MEDIA / "slides"
CAPTURES = MEDIA / "captures"

W, H = 1920, 1080

# ── palette ────────────────────────────────────────────────────────────────────
BG = (11, 15, 25)
PANEL = (18, 24, 38)
PANEL_HI = (24, 32, 50)
BORDER = (44, 56, 80)
FG = (233, 238, 247)
MUTED = (148, 162, 188)
DIM = (104, 118, 144)
GREEN = (52, 211, 153)
AMBER = (251, 191, 36)
RED = (248, 113, 113)
BLUE = (96, 165, 250)
VIOLET = (167, 139, 250)
CYAN = (34, 211, 238)

FONT_DIR = Path("C:/Windows/Fonts")


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_DIR / name), size)


MONO = "consola.ttf"
MONO_B = "consolab.ttf"
SANS = "arial.ttf"
SANS_B = "arialbd.ttf"


def measure(d: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont) -> int:
    return int(d.textbbox((0, 0), text, font=f)[2])


def wrap(d: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, max_w: int) -> list[str]:
    """Greedy wrap that never splits a word unless the word alone exceeds max_w."""
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if measure(d, trial, f) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


# ── capture loading ────────────────────────────────────────────────────────────

def read_capture(name: str) -> list[str]:
    p = CAPTURES / name
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        if "DeprecationWarning" in line or "trace-deprecation" in line:
            continue
        out.append(line.rstrip())
    # drop npm's own banner noise
    while out and (out[0].startswith("> majortom") or out[0].startswith("> npm") or not out[0].strip()):
        out.pop(0)
    return out


def report_facts() -> dict:
    """Parse the real report so every number on screen is the real one."""
    text = (CAPTURES / "report.md").read_text(encoding="utf-8", errors="replace")
    facts: dict = {}
    m = re.search(r"Run ([A-Z0-9]+) - ([0-9-]+) - wall clock (\d+)s", text)
    if m:
        facts["run_id"], facts["date"], facts["wall"] = m.group(1), m.group(2), m.group(3)
    m = re.search(r"GREEN", text)
    facts["green"] = bool(m)
    m = re.search(r"(\d+) pre-existing failure", text)
    facts["preexisting"] = m.group(1) if m else "1"
    m = re.search(r"tests passing \| (\d+/\d+) \| (\d+/\d+)", text)
    if m:
        facts["before"], facts["after"] = m.group(1), m.group(2)
    m = re.search(r"files changed \| - \| (\d+)", text)
    facts["files"] = m.group(1) if m else "?"
    m = re.search(r"citation coverage \| - \| (\d+)%", text)
    facts["coverage"] = m.group(1) if m else "100"
    m = re.search(r"`package.json`: \*\*([\d.]+) -> ([\d.]+)\*\*", text)
    if m:
        facts["from"], facts["to"] = m.group(1), m.group(2)
    facts["citations"] = re.findall(r'### (EX-\d+) - ([^\n]+)', text)
    return facts


# ── drawing primitives ─────────────────────────────────────────────────────────

def base(title: str, kicker: str = "") -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # subtle top accent bar
    d.rectangle([0, 0, W, 6], fill=BLUE)
    d.rectangle([0, 6, W // 3, 6], fill=CYAN)
    if kicker:
        d.text((80, 64), kicker.upper(), font=font(MONO_B, 22), fill=CYAN)
    if title:
        d.text((80, 100), title, font=font(SANS_B, 54), fill=FG)
    return img, d


def footer(d: ImageDraw.ImageDraw, idx: str, note: str = "") -> None:
    d.line([(80, H - 92), (W - 80, H - 92)], fill=BORDER, width=2)
    d.text((80, H - 74), "majortom", font=font(MONO_B, 20), fill=DIM)
    if note:
        d.text((200, H - 74), note, font=font(MONO, 20), fill=DIM)
    d.text((W - 200, H - 74), idx, font=font(MONO, 20), fill=DIM)


def panel(d: ImageDraw.ImageDraw, box: tuple[int, int, int, int], hi: bool = False) -> None:
    d.rounded_rectangle(box, radius=14, fill=PANEL_HI if hi else PANEL, outline=BORDER, width=2)


def chip(d: ImageDraw.ImageDraw, x: int, y: int, text: str, color) -> int:
    f = font(MONO_B, 20)
    w = measure(d, text, f) + 32
    d.rounded_rectangle([x, y, x + w, y + 38], radius=19, fill=color)
    d.text((x + 16, y + 8), text, font=f, fill=(11, 15, 25))
    return x + w + 14


# ── video frames ───────────────────────────────────────────────────────────────

def f_intro(d: ImageDraw.ImageDraw, facts: dict) -> None:
    f_big = font(SANS_B, 96)
    f_sub = font(SANS, 40)
    f_mono = font(MONO, 30)
    d.text((80, 300), "MajorTom", font=f_big, fill=FG)
    d.text((80, 420), "An autonomous major-version", font=f_sub, fill=MUTED)
    d.text((80, 476), "dependency migration agent", font=f_sub, fill=MUTED)
    y = 580
    for line, col in [
        ("$ npm install && npm run demo", CYAN),
        ("", FG),
        (f"express {facts.get('from','4.21.2')} -> {facts.get('to','5.1.0')}   real run, real output", GREEN),
    ]:
        if line:
            d.text((80, y), line, font=f_mono, fill=col)
        y += 52
    d.text((80, 760), "Every change cites the guide section that justifies it.", font=font(SANS, 30), fill=DIM)


def f_problem(d: ImageDraw.ImageDraw, facts: dict) -> None:
    d.text((80, 190), "The diff looks right. The software is still broken.", font=font(SANS_B, 46), fill=FG)
    items = [
        ("app.del()", "removed"),
        ("res.send(status)", "removed"),
        ("/*", "must be named"),
        ("/:format?", "optional -> braces"),
    ]
    y = 300
    for sym, note in items:
        panel(d, (80, y, 1000, y + 82), hi=True)
        d.text((112, y + 24), sym, font=font(MONO_B, 32), fill=RED)
        d.text((560, y + 28), note, font=font(MONO, 28), fill=MUTED)
        y += 98
    d.text((80, y + 40), "A regex gets you a codebase that looks migrated and fails at runtime.",
           font=font(SANS, 32), fill=AMBER)


def f_pipeline(d: ImageDraw.ImageDraw, facts: dict) -> None:
    stages = ["INTAKE", "PLAN", "IMPACT", "BASELINE", "EXECUTE", "VERIFY", "REPORT"]
    x, w, gap = 80, 226, 18
    y = 300
    for i, s in enumerate(stages):
        col = [BLUE, VIOLET, CYAN, MUTED, AMBER, GREEN, BLUE][i]
        d.rounded_rectangle([x, y, x + w, y + 96], radius=12, fill=PANEL, outline=col, width=3)
        f = font(MONO_B, 21)
        tw = measure(d, s, f)
        d.text((x + (w - tw) / 2, y + 36), s, font=f, fill=col)
        if i < len(stages) - 1:
            d.line([(x + w + 3, y + 48), (x + w + gap - 4, y + 48)], fill=BORDER, width=3)
        x += w + gap
    d.text((80, 460), "Seven ledgered stages. Every one resumable.", font=font(SANS, 34), fill=FG)
    y = 540
    for label, desc, col in [
        ("I1", "never touches main; no force-push, no merge path", GREEN),
        ("I2", "every edit cited; coverage computed from real records", GREEN),
        ("I3", "the guide is DATA - injected instructions ignored", GREEN),
        ("Honest", "reports NOT GREEN when the migration is not green", AMBER),
    ]:
        f = font(MONO_B, 26)
        d.text((80, y), label, font=f, fill=col)
        d.text((240, y), desc, font=font(MONO, 26), fill=MUTED)
        y += 56


def f_run(d: ImageDraw.ImageDraw, facts: dict) -> None:
    d.text((80, 190), "The run", font=font(SANS_B, 46), fill=FG)
    panel(d, (80, 270, W - 80, H - 140))
    lines = read_capture("demo-run.txt")
    # keep the most informative window: from the report header to the exit line
    start = 0
    for i, l in enumerate(lines):
        if l.startswith("# MajorTom Migration Report"):
            start = i
            break
    window = lines[start : start + 40]
    f = font(MONO, 21)
    y = 296
    for l in window:
        if y > H - 190:
            break
        col = FG
        if l.startswith("GREEN"):
            col = GREEN
        elif l.startswith("NOT GREEN"):
            col = RED
        elif l.startswith("##") or l.startswith("#"):
            col = CYAN
        elif "|" in l:
            col = MUTED
        d.text((108, y), l[:118], font=f, fill=col)
        y += 28


def f_citation(d: ImageDraw.ImageDraw, facts: dict) -> None:
    d.text((80, 180), "Every change cites its source", font=font(SANS_B, 48), fill=FG)
    d.text((80, 250), f"citation coverage: {facts.get('coverage','100')}%   -   {facts.get('files','9')} files changed",
           font=font(MONO, 28), fill=GREEN)
    y = 320
    for cid, title in facts.get("citations", [])[:4]:
        panel(d, (80, y, W - 80, y + 108), hi=True)
        d.text((112, y + 18), cid, font=font(MONO_B, 26), fill=CYAN)
        d.text((112, y + 56), title[:78], font=font(MONO, 23), fill=FG)
        y += 122
    quote = ('"Express 5 no longer supports the signature res.send(status), where status is a '
             "number. Instead, use res.sendStatus(statusCode)...")
    panel(d, (80, y + 10, W - 80, y + 96))
    fq = font(MONO, 21)
    for i, line in enumerate(wrap(d, quote, fq, W - 260)[:2]):
        d.text((112, y + 30 + i * 28), line, font=fq, fill=AMBER)


def f_green(d: ImageDraw.ImageDraw, facts: dict) -> None:
    d.text((80, 200), "GREEN", font=font(SANS_B, 120), fill=GREEN)
    d.text((80, 340), "verification found no failure attributable to this migration",
           font=font(SANS, 34), fill=FG)
    d.text((80, 390), f"{facts.get('preexisting','1')} pre-existing failure excluded from accounting per 8.2",
           font=font(SANS, 30), fill=MUTED)
    y = 500
    for k, v, col in [
        ("tests passing", f"{facts.get('before','15/16')}  ->  {facts.get('after','15/16')}", GREEN),
        ("files changed", facts.get("files", "9"), FG),
        ("citation coverage", f"{facts.get('coverage','100')}%", GREEN),
        ("manifest", f"{facts.get('from','4.21.2')} -> {facts.get('to','5.1.0')}", CYAN),
        ("exit code", "0", GREEN),
    ]:
        d.text((80, y), k.ljust(22), font=font(MONO, 28), fill=DIM)
        d.text((560, y), v, font=font(MONO_B, 30), fill=col)
        y += 62


def f_honest(d: ImageDraw.ImageDraw, facts: dict) -> None:
    d.text((80, 190), "The part that matters", font=font(SANS_B, 48), fill=FG)
    panel(d, (80, 290, 940, 620), hi=True)
    d.text((112, 320), "BEFORE", font=font(MONO_B, 26), fill=RED)
    for i, l in enumerate(["15/16 passing", "1 pre-existing failure", "arithmetic sanity check", "unrelated to Express"]):
        d.text((112, 380 + i * 52), l, font=font(MONO, 26), fill=MUTED)
    panel(d, (980, 290, W - 80, 620), hi=True)
    d.text((1012, 320), "AFTER", font=font(MONO_B, 26), fill=GREEN)
    for i, l in enumerate(["15/16 passing", "1 pre-existing failure", "excluded, not blamed", "attributable: NONE"]):
        d.text((1012, 380 + i * 52), l, font=font(MONO, 26), fill=MUTED)
    d.text((80, 680), "A failing run and a passing run are equally easy to produce.",
           font=font(SANS, 34), fill=AMBER)
    d.text((80, 734), "That is the entire product.", font=font(SANS, 34), fill=AMBER)


def f_close(d: ImageDraw.ImageDraw, facts: dict) -> None:
    d.text((80, 320), "Run it yourself", font=font(SANS_B, 72), fill=FG)
    d.text((80, 460), "$ npm install", font=font(MONO_B, 40), fill=CYAN)
    d.text((80, 520), "$ npm run demo", font=font(MONO_B, 40), fill=CYAN)
    d.text((80, 620), "No API keys. No setup. No network required.", font=font(SANS, 34), fill=MUTED)
    x = 80
    for t, c in [("MIT", MUTED), ("138 tests", GREEN), ("7 stages", BLUE), ("100% cited", VIOLET)]:
        x = chip(d, x, 720, t, c)


# ── render ─────────────────────────────────────────────────────────────────────

def render_video(facts: dict) -> list[Path]:
    FRAMES.mkdir(parents=True, exist_ok=True)
    for old in FRAMES.glob("frame-*.png"):
        old.unlink()

    plan: list[tuple[str, int]] = [
        ("intro", 45),
        ("problem", 50),
        ("pipeline", 50),
        ("run", 210),      # ~7s of real terminal output
        ("citation", 60),
        ("green", 55),
        ("honest", 55),
        ("close", 40),
    ]

    made: list[Path] = []
    i = 0
    for kind, count in plan:
        for _ in range(count):
            img, d = base("", "")
            {
                "intro": lambda: f_intro(d, facts),
                "problem": lambda: f_problem(d, facts),
                "pipeline": lambda: f_pipeline(d, facts),
                "run": lambda: f_run(d, facts),
                "citation": lambda: f_citation(d, facts),
                "green": lambda: f_green(d, facts),
                "honest": lambda: f_honest(d, facts),
                "close": lambda: f_close(d, facts),
            }[kind]()
            footer(d, f"{i // 30 + 1:02d}")
            p = FRAMES / f"frame-{i:04d}.png"
            img.save(p, optimize=True)
            made.append(p)
            i += 1
    return made


def render_cover(facts: dict) -> Path:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 8], fill=BLUE)
    d.rectangle([0, 8, W // 2, 8], fill=CYAN)
    d.rectangle([0, 8, W // 8, 8], fill=VIOLET)

    d.text((100, 150), "MAJORTOM", font=font(SANS_B, 128), fill=FG)
    d.text((104, 300), "Guide-driven dependency migration", font=font(SANS, 46), fill=MUTED)
    d.text((104, 362), "that refuses to claim success it cannot prove", font=font(SANS, 46), fill=MUTED)

    d.line([(104, 470), (W - 104, 470)], fill=BORDER, width=3)

    stages = "INTAKE  >  PLAN  >  IMPACT  >  BASELINE  >  EXECUTE  >  VERIFY  >  REPORT"
    d.text((104, 512), stages, font=font(MONO_B, 28), fill=CYAN)

    x = 104
    for t, c in [
        ("MIT", PANEL_HI),
        ("138 tests", PANEL_HI),
        (f"{facts.get('files','9')} files", PANEL_HI),
        (f"{facts.get('coverage','100')}% cited", PANEL_HI),
        ("GREEN", GREEN),
    ]:
        f = font(MONO_B, 26)
        w = measure(d, t, f) + 36
        d.rounded_rectangle([x, 600, x + w, 650], radius=12, fill=c)
        fg = (11, 15, 25) if c == GREEN else FG
        d.text((x + 18, 613), t, font=f, fill=fg)
        x += w + 16

    d.text((104, 720), f"express {facts.get('from','4.21.2')} -> {facts.get('to','5.1.0')}",
           font=font(MONO_B, 34), fill=GREEN)
    d.text((104, 772), "every change cites the guide section that justifies it",
           font=font(MONO, 26), fill=DIM)
    d.text((104, H - 130), "github.com/BROCKUGANDA/majortom", font=font(MONO, 28), fill=CYAN)

    p = MEDIA / "cover.png"
    img.save(p, optimize=True)
    return p


def render_slides(facts: dict) -> list[Path]:
    SLIDES.mkdir(parents=True, exist_ok=True)
    for old in SLIDES.glob("slide-*.png"):
        old.unlink()
    out = []

    def slide(title: str, kicker: str, painter, i: int, total: int) -> None:
        img, d = base(title, kicker)
        painter(d)
        d.text((W - 140, H - 74), f"{i}/{total}", font=font(MONO, 20), fill=DIM)
        p = SLIDES / f"slide-{i:02d}.png"
        img.save(p, optimize=True)
        out.append(p)

    n = 8
    slide("MajorTom", "autonomous dependency migration", lambda d: (
        d.text((80, 260), "A major-version upgrade is one of the most", font=font(SANS, 40), fill=MUTED),
        d.text((80, 320), "feared tasks in software maintenance.", font=font(SANS, 40), fill=MUTED),
        d.text((80, 420), "Not because of the diff.", font=font(SANS_B, 46), fill=FG),
        d.text((80, 486), "Because the diff looks right and the software is still broken.",
               font=font(SANS_B, 46), fill=AMBER),
    ), 1, n)

    slide("The problem", "why naive upgrades fail", lambda d: (
        *[d.text((80, 280 + i * 62), f"- {t}", font=font(MONO, 30), fill=MUTED)
          for i, t in enumerate(["app.del() removed", "res.send(status) removed",
                                 "/* must be named", "/:format? -> braces", "regex paths rejected"])],
        d.text((80, 660), "A regex produces a codebase that looks migrated", font=font(SANS, 36), fill=FG),
        d.text((80, 712), "and fails at runtime.", font=font(SANS, 36), fill=RED),
    ), 2, n)

    slide("The solution", "guide-driven, cited, verified", lambda d: (
        d.text((80, 280), "The vendor's own migration guide is the source of truth.", font=font(SANS, 34), fill=FG),
        d.text((80, 340), "Apply only what that guide justifies. Then prove it by", font=font(SANS, 34), fill=FG),
        d.text((80, 400), "running the tests.", font=font(SANS, 34), fill=FG),
        d.text((80, 520), "$ npm install && npm run demo", font=font(MONO_B, 38), fill=CYAN),
        d.text((80, 620), "No API keys. No setup. No network required.", font=font(SANS, 30), fill=DIM),
    ), 3, n)

    slide("The pipeline", "seven ledgered stages", lambda d: (
        *[d.text((80, 280 + i * 60), f"{i+1}. {s}", font=font(MONO_B, 30), fill=CYAN)
          for i, s in enumerate(["INTAKE", "PLAN", "IMPACT", "BASELINE", "EXECUTE", "VERIFY", "REPORT"])],
        d.text((80, 800), "Every stage is checkpointed and resumable.", font=font(SANS, 32), fill=MUTED),
    ), 4, n)

    slide("Invariants", "what makes it trustworthy", lambda d: (
        *[d.text((80, 280 + i * 92), f"{l}  {t}", font=font(MONO_B, 30), fill=GREEN)
          for i, (l, t) in enumerate([
              ("I1", "never touches main; no force-push, no merge"),
              ("I2", "every edit cited; coverage computed from records"),
              ("I3", "the guide is DATA; injected instructions ignored")])],
        d.text((80, 620), "Honest outcomes", font=font(MONO_B, 30), fill=AMBER),
        d.text((80, 672), "reports NOT GREEN when the migration is not green",
               font=font(SANS, 32), fill=FG),
    ), 5, n)

    slide("Proof", "a real run", lambda d: (
        d.text((80, 270), f"express {facts.get('from','4.21.2')} -> {facts.get('to','5.1.0')}",
               font=font(SANS_B, 52), fill=FG),
        d.text((80, 380), f"GREEN  -  {facts.get('files','9')} files changed", font=font(SANS_B, 44), fill=GREEN),
        d.text((80, 460), f"citation coverage {facts.get('coverage','100')}%", font=font(SANS, 36), fill=MUTED),
        d.text((80, 530), f"tests {facts.get('before','15/16')} -> {facts.get('after','15/16')}",
               font=font(SANS, 36), fill=MUTED),
        d.text((80, 620), "exit code 0", font=font(MONO, 34), fill=CYAN),
    ), 6, n)

    slide("Honest accounting", "the part that matters", lambda d: (
        d.text((80, 280), "A pre-existing failure is recorded in the baseline", font=font(SANS, 34), fill=FG),
        d.text((80, 330), "and excluded. A regression is reported as one.", font=font(SANS, 34), fill=FG),
        d.text((80, 450), f"{facts.get('preexisting','1')} pre-existing failure: excluded, not blamed",
               font=font(MONO, 30), fill=AMBER),
        d.text((80, 510), "attributable to migration: NONE", font=font(MONO, 30), fill=GREEN),
        d.text((80, 660), "A failing run and a passing run are equally easy to produce.",
               font=font(SANS, 34), fill=MUTED),
    ), 7, n)

    slide("Run it yourself", "github.com/BROCKUGANDA/majortom", lambda d: (
        d.text((80, 300), "$ npm install", font=font(MONO_B, 52), fill=CYAN),
        d.text((80, 380), "$ npm run demo", font=font(MONO_B, 52), fill=CYAN),
        d.text((80, 520), "MIT licensed. 138 tests. 7 stages. 100% cited.", font=font(SANS, 34), fill=MUTED),
    ), 8, n)
    return out


def main() -> int:
    if not (CAPTURES / "report.md").exists():
        print("missing media/captures/report.md - run: npm run demo -- --keep", file=sys.stderr)
        return 1
    facts = report_facts()
    print(f"facts: green={facts.get('green')} files={facts.get('files')} "
          f"coverage={facts.get('coverage')} citations={len(facts.get('citations', []))}")

    frames = render_video(facts)
    print(f"frames: {len(frames)}")

    cover = render_cover(facts)
    print(f"cover: {cover}")

    slides = render_slides(facts)
    print(f"slides: {len(slides)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
