"""Verify the submission-form answers fit the form limits.

Counts the LONG DESC and BOB USAGE word blocks by taking everything between
their section marker and the next heading, dropping the bullet list (which is
narrative detail, not prose) is NOT done here - bullets count as words in a
judge's eye, so they are included.
"""

import re
import sys
from pathlib import Path

s = Path("docs/submission-form-answers.md").read_text(encoding="utf-8")

short_block = s.split("## 1. Short Description")[1].split("## 2.")[0]
q = [l for l in short_block.splitlines() if l.strip().startswith(">")][0]
q = q.lstrip("> ").strip()
n = len(q)
print(f"SHORT DESC : {n:4d} chars   (min 50, max 255)  -> {'OK' if 50 <= n <= 255 else 'FAIL'}")

for label, marker, stop in [
    ("LONG DESC ", "## 2. Long Description", "## 3."),
    ("BOB USAGE ", "## 3. IBM Bob", "## Note"),
]:
    body = s.split(marker)[1].split(stop)[0]
    # drop the bold "N words (limit ...)" line only
    body = re.sub(r"^\*\*\d+ words\*\*.*$", "", body, flags=re.M)
    lines = [l for l in body.splitlines() if l.strip()]
    words = sum(len(l.split()) for l in lines)
    verdict = "OK" if words <= 500 else f"OVER by {words - 500}"
    print(f"{label}: {words:4d} words   (max 500)  -> {verdict}")

# guard: no stale test counts anywhere in the answers
for bad in ("153", "154 total"):
    if bad in s:
        print(f"  STALE NUMBER present: {bad!r}")
