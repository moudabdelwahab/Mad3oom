#!/usr/bin/env python3
"""Validate the Egyptian-Arabic translation overlay against the Modern Standard Arabic source strings.

    python3 src/tools/validate_eg.py [translations/eg.json]  (needs _build/ar_strings.json from `build.py --extract`)

Hard checks (exit code 1): every source string translated; inline markup tokens identical; every Latin word / number of the
source present in the translation and nothing Latin or numeric added; no empty output.
Soft checks (reported): MSA negation or auxiliary forms that should be Egyptian, strings with no colloquial marker, odd length ratios.
"""
import json
import os
import re
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)

TOKEN = re.compile(r"\{\{[^}]+\}\}")
LATIN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_\-./+:%&#@'’]*(?:[ ,][A-Za-z0-9][A-Za-z0-9_\-./+:%&#@'’]*)*")
ARABIC = re.compile("[؀-ۿ]")
MSA_NEG = re.compile(r"(?<!\S)(لا يوجد|لا توجد|ليس|ليست|لم |لن |لا يمكن|يقوم بـ?|تقوم بـ?|سوف |حيث إن|لذا|بينما)(?!\S)|\bلم\b|\bلن\b")
COLLOQ = re.compile(r"(?<!\S)(ب[يتنأ]\w+|ه[يتنأ]\w+|مش|ده|دي|دول|كده|إيه|ايه|إزاي|ازاي|عشان|علشان|لسه|لسة|مفيش|فيه|اللي|دلوقتي|برضه|كمان|بس|عايز\w*|محتاج\w*|ما\w+ش|ليه|فين|إمتى|امتى|هنا|يعني)(?!\S)")


def latin_tokens(s):
    s = TOKEN.sub(" ", s)
    return Counter(t.strip(" ,") for t in LATIN.findall(s))


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(SRC, "translations", "eg.json")
    src = json.load(open(os.path.join(SRC, "_build", "ar_strings.json"), encoding="utf-8"))
    eg = json.load(open(path, encoding="utf-8"))
    hard, soft = [], []
    for item in src:
        a = item["ar"]
        e = eg.get(a)
        if e is None or not e.strip():
            hard.append(("missing", a[:70], "")); continue
        if Counter(TOKEN.findall(a)) != Counter(TOKEN.findall(e)):
            hard.append(("tokens", a[:70], e[:70]))
        if a.count("**") != e.count("**") or a.count("`") != e.count("`"):
            hard.append(("markup", a[:70], e[:70]))
        la, le = latin_tokens(a), latin_tokens(e)
        if la - le:
            hard.append(("latin-dropped " + ",".join(sorted((la - le).keys()))[:60], a[:70], e[:70]))
        if le - la:
            hard.append(("latin-added " + ",".join(sorted((le - la).keys()))[:60], a[:70], e[:70]))
        words = len(a.split())
        if words >= 7:
            if MSA_NEG.search(e):
                soft.append(("msa-form " + MSA_NEG.search(e).group(0).strip(), a[:60], e[:90]))
            if not COLLOQ.search(e):
                soft.append(("no-colloquial-marker", a[:60], e[:90]))
            r = len(e) / max(1, len(a))
            if r < 0.6 or r > 1.7:
                soft.append((f"length-ratio {r:.2f}", a[:60], e[:90]))
    extra = [k for k in eg if k not in {i["ar"] for i in src}]
    print(f"source strings: {len(src)}   translated: {sum(1 for i in src if i['ar'] in eg)}   unused keys: {len(extra)}")
    print(f"HARD problems: {len(hard)}   soft warnings: {len(soft)}")
    for kind, a, e in hard[:80]:
        print(f"  HARD {kind}\n     src: {a}\n     eg : {e}")
    for kind, a, e in soft[:60]:
        print(f"  soft {kind}\n     src: {a}\n     eg : {e}")
    sys.exit(1 if hard else 0)


if __name__ == "__main__":
    main()
