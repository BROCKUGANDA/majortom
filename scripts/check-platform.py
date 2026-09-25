"""Structural sanity check for the generated demo dashboard.

Verifies the HTML is well-formed enough to render and that no template
artifacts leaked through. Not a full parser - it checks the things that
actually broke during development.
"""

import sys
from pathlib import Path

p = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/index.html")
s = p.read_text(encoding="utf-8")

print(f"file: {p}  ({len(s)} bytes)")
print("starts with doctype:", s.startswith("<!doctype html>"))
print("ends with </html>:  ", s.rstrip().endswith("</html>"))

for tag in ("div", "table", "tr", "td", "th", "tbody", "span", "p"):
    o, c = s.count(f"<{tag}"), s.count(f"</{tag}>")
    flag = "  OK" if o == c else "  <-- MISMATCH"
    print(f"  <{tag}>: {o} open / {c} close{flag}")

print("citation rows:      ", s.count('class="id"'))
print("stage rows:         ", s.count('class="bar-track"'))
print("metric cards:       ", s.count('class="card"'))
print("'not recorded':     ", s.count("not recorded"))

bad = False
for token in ("${", "undefined", "[object Object]", "NaN", "null</"):
    n = s.count(token)
    if n:
        print(f"  LEFTOVER {token!r}: {n}")
        bad = True
if not bad:
    print("no template artifacts")

sys.exit(1 if bad else 0)
