#!/usr/bin/env python
"""Assemble the narrated MajorTom demo video.

Measures every narration beat, allocates screen time per scene so the real
terminal capture gets the largest share, renders frames at exactly those
durations, and muxes picture + voice with ffmpeg.

Refuses to build anything longer than the 3-minute submission limit.

  python media/build_video.py

Outputs:
  media/demo-narrated.mp4
  media/timeline.json
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render as R  # noqa: E402  (reuse the real-fact frame painters)

MEDIA = Path(__file__).resolve().parent
AUDIO = MEDIA / "audio"
OUT = MEDIA / "demo-narrated.mp4"
FPS = 30
LEAD = 1.2
TAIL = 1.6
LIMIT = 180.0

# Beat order follows the 5-minute demo script. "run" is the real captured
# terminal output; it is deliberately given the longest unbroken stretch.
SCENES = [
    ("beat1-problem.mp3", "problem"),
    ("beat2-launch.mp3", "pipeline"),
    ("beat3-plan.mp3", "run"),
    ("beat4-fixers.mp3", "run"),
    (None, "run"),  # silent: let the real run play out
    ("beat5-trust.mp3", "citation"),
    ("beat6-verify.mp3", "green"),
    ("beat7-pr.mp3", "honest"),
    ("beat8-close.mp3", "close"),
]
SILENT_RUN = 14.0


def sh(*args: str) -> None:
    subprocess.run(list(args), check=True)


def audio_dur(p: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(p)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def main() -> int:
    if not (MEDIA / "captures" / "report.md").exists():
        print("run: npm run demo -- --keep  (needed for real facts)")
        return 1

    facts = R.report_facts()
    durations = []
    for name, _ in SCENES:
        if name is None:
            durations.append(SILENT_RUN)
        else:
            f = AUDIO / name
            if not f.exists():
                print(f"missing narration: {f}")
                return 1
            durations.append(audio_dur(f))

    total = LEAD + sum(durations) + TAIL
    run_seconds = sum(d for (_n, s), d in zip(SCENES, durations) if s == "run")
    # the submission asks for >=90s of the solution operating: the live run plus
    # the report and verdict views are all the agent actually working
    action_seconds = run_seconds + durations[5] + durations[6]

    print(f"total {total:.1f}s   real-run footage {run_seconds:.1f}s   "
          f"solution-in-action {action_seconds:.1f}s")
    if total > LIMIT:
        print(f"REFUSING: {total:.1f}s exceeds {LIMIT}s")
        return 2

    # ── 1. narration bed: beats in order, with lead/tail silence ──────────────
    voiced = [(n, d) for (n, _s), d in zip(SCENES, durations) if n]
    listf = MEDIA / "audio.txt"
    listf.write_text(
        "".join(f"file 'audio/{n}'\n" for n, _ in voiced), encoding="utf-8"
    )
    sh("ffmpeg", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listf),
       "-c:a", "libmp3lame", "-q:a", "4", "-y", str(MEDIA / "voice.mp3"))
    sh("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
       "-t", f"{LEAD + TAIL}", "-y", str(MEDIA / ".sil.wav"))
    sh("ffmpeg", "-v", "error", "-i", str(MEDIA / "voice.mp3"),
       "-i", str(MEDIA / ".sil.wav"),
       "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1",
       "-c:a", "libmp3lame", "-q:a", "4", "-y", str(MEDIA / "narration.mp3"))

    # ── 2. render every frame at the exact duration of its scene ─────────────
    painters = {
        "problem": R.f_problem, "pipeline": R.f_pipeline,
        "citation": R.f_citation, "green": R.f_green,
        "honest": R.f_honest, "close": R.f_close,
    }
    R.FRAMES.mkdir(parents=True, exist_ok=True)
    for old in R.FRAMES.glob("frame-*.png"):
        old.unlink()

    lines = R.read_capture("demo-run.txt")

    # Rendering every frame as a PNG is far too slow for a ~3 min video. Instead
    # render a small number of DISTINCT images and let ffmpeg hold each for its
    # beat's duration. The terminal scene still scrolls: it gets one image per
    # scroll step, each held for the remainder of its slice.
    images: list[tuple[Path, float]] = []  # (path, hold_seconds)
    span = max(1, len(lines) - 40)
    SCROLL_STEPS = 16

    for i, (_n, scene) in enumerate(SCENES):
        hold = durations[i]
        if scene == "run":
            # split this scene's screen time across SCROLL_STEPS distinct views
            per = hold / SCROLL_STEPS
            for k in range(SCROLL_STEPS):
                img, d = R.base("", "")
                R.f_run_scroll(d, facts, lines, min(span, (span * k) // SCROLL_STEPS))
                R.footer(d, "")
                p = MEDIA / f".still-{i}-{k:02d}.png"
                img.save(p, optimize=True)
                images.append((p, per))
        else:
            img, d = R.base("", "")
            painters[scene](d, facts)
            R.footer(d, "")
            p = MEDIA / f".still-{i}-00.png"
            img.save(p, optimize=True)
            images.append((p, hold))

    (MEDIA / ".sil.wav").unlink(missing_ok=True)

    # ── 3. concat the stills into a timed video track, then mux the voice ─────
    conlist = MEDIA / "concat.txt"
    conlist.write_text(
        "".join(
            f"file '{p.name}'\nduration {h:.3f}\n" for p, h in images
        ) + f"file '{images[-1][0].name}'\nduration 2.0\n",
        encoding="utf-8",
    )
    sh("ffmpeg", "-v", "error", "-y",
       "-f", "concat", "-safe", "0", "-i", str(conlist),
       "-vf", f"fps={FPS},format=yuv420p",
       "-c:v", "libx264", "-crf", "20", "-preset", "medium",
       str(MEDIA / "picture.mp4"))
    sh("ffmpeg", "-v", "error", "-y", "-i", str(MEDIA / "picture.mp4"),
       "-i", str(MEDIA / "narration.mp3"),
       "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
       "-shortest", "-movflags", "+faststart", str(OUT))

    for p, _h in images:
        p.unlink(missing_ok=True)
    conlist.unlink(missing_ok=True)
    (MEDIA / "picture.mp4").unlink(missing_ok=True)
    listf.unlink(missing_ok=True)
    (MEDIA / "voice.mp3").unlink(missing_ok=True)

    (MEDIA / "timeline.json").write_text(json.dumps({
        "total_seconds": round(total, 2),
        "real_run_seconds": round(run_seconds, 2),
        "solution_in_action_seconds": round(action_seconds, 2),
        "scenes": [{"narration": n, "scene": s, "seconds": round(d, 2)}
                   for (n, s), d in zip(SCENES, durations)],
    }, indent=2), encoding="utf-8")

    print(f"wrote {OUT}  ({len(images)} stills)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
