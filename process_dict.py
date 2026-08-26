# -*- coding: utf-8 -*-
"""ECDICT mini -> web dictionary JSON.

Output: data/dict.json
  { "w": [[word, phonetic, translation, tag, frq], ...],   // sorted by frequency
    "lemma": { "variant": "base", ... } }                  // morphological map
"""
import csv
import json
import re
import sys

SRC = "data/ecdict-full.csv"
OUT = "data/dict.json"

VALID_TAG = {"zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre"}
WORD_RE = re.compile(r"^[a-zA-Z][a-zA-Z'-]*$")

def to_int(v):
    try:
        return int((v or "").strip())
    except (ValueError, TypeError):
        return None

rows = []
skipped = 0
with open(SRC, newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    for r in reader:
        word = (r.get("word") or "").strip().lower()
        tr = (r.get("translation") or "").strip()
        if not word or not tr or not WORD_RE.match(word):
            skipped += 1
            continue
        # keep: high-frequency words OR words with exam tags
        frq = to_int(r.get("frq"))
        bnc = to_int(r.get("bnc"))
        if frq is None or bnc is None:  # column-shifted corrupted row
            skipped += 1
            continue
        tags = [t for t in (r.get("tag") or "").split() if t in VALID_TAG]
        keep = (0 < frq <= 30000) or (0 < bnc <= 30000) or tags
        if not keep:
            continue
        # translation: first 3 lines, each capped
        lines = [ln.strip() for ln in tr.split("\\n") if ln.strip()][:3]
        lines = [ln if len(ln) <= 70 else ln[:67] + "..." for ln in lines]
        ph = (r.get("phonetic") or "").strip()
        rows.append({
            "word": word,
            "ph": ph,
            "tr": "\n".join(lines),
            "tag": " ".join(tags),
            "frq": frq if frq else (bnc if bnc else 99999),
            "bnc": bnc,
            "exchange": r.get("exchange") or "",
        })

# dedupe by word, keep lowest frq
seen = {}
for r in rows:
    if r["word"] not in seen or r["frq"] < seen[r["word"]]["frq"]:
        seen[r["word"]] = r
rows = list(seen.values())
rows.sort(key=lambda r: (r["frq"], r["word"]))

# lemma map from exchange field: variant -> base word
lemma = {}
for r in rows:
    base = r["word"]
    for item in r["exchange"].split("/"):
        if ":" not in item:
            continue
        _typ, variant = item.split(":", 1)
        variant = variant.strip().lower()
        if variant and variant != base and WORD_RE.match(variant) and len(variant) >= 2:
            if variant not in lemma or variant not in seen:
                lemma.setdefault(variant, base)

out = {
    "w": [[r["word"], r["ph"], r["tr"], r["tag"], r["frq"]] for r in rows],
    "lemma": lemma,
}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

print(f"entries: {len(rows)}, lemma mappings: {len(lemma)}")
import os
print(f"output size: {os.path.getsize(OUT)/1024/1024:.2f} MB")
