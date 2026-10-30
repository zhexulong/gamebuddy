"""Summarise what the acceptance gate actually asserts, by category.

Answers "what did we verify" from the shipping script rather than from memory: the gate records one line per
check through `call :record "<category>" "<description>" "<value>"`, so the categories and descriptions are
read straight out of it.
"""

import collections
import pathlib
import re

GATE = pathlib.Path("tools/sandbox/sandbox-verify.cmd")
pattern = re.compile(r'call :record "([^"]+)" "([^"]+)"')

text = GATE.read_text(encoding="utf-8")
matches = pattern.findall(text)

by_category = collections.OrderedDict()
for category, description in matches:
    by_category.setdefault(category, []).append(description)

total = 0
for category, descriptions in by_category.items():
    print("{} ({} checks)".format(category, len(descriptions)))
    for description in descriptions:
        print("   -", description)
        total += 1
print()
print("total assertions:", total)
