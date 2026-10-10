#!/usr/bin/env python3
"""Build the Mad3oom White Paper PDFs from one bilingual source.

Two editions are kept apart on purpose:

  public    (default)  content_public/ + diagrams_public.py  ->  docs/whitepaper/public/
                         Mad3oom_White_Paper_EN_Public.pdf
                         Mad3oom_White_Paper_AR_Public.pdf
                         Mad3oom_White_Paper_EG.pdf   (Egyptian Arabic, built from the public content)
  internal  (--internal) content/ + diagrams.py          ->  docs/whitepaper/
                         Mad3oom_White_Paper_EN.pdf, Mad3oom_White_Paper_AR.pdf
                         The internal editions are NOT rebuilt unless --internal is given, so a routine build can
                         never overwrite them.

    python3 src/build.py                    # the three public editions
    python3 src/build.py en ar              # only some of them
    python3 src/build.py --extract          # list every Arabic string of the public edition (for translation)
    python3 src/build.py --internal en ar   # rebuild the internal editions (restricted use)
    python3 src/build.py --out /tmp/x en    # build into another directory (test builds)

Requires: python3, playwright (Chromium), pikepdf, pypdf, Pillow.  Fonts are vendored in src/fonts.
"""
from __future__ import annotations
import glob
import importlib
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WP_DIR = os.path.dirname(HERE)
BUILD = os.path.join(HERE, "_build")
sys.path.insert(0, HERE)

import lib  # noqa: E402
from lib import Chapter, Renderer, plain, inline_plain, A  # noqa: E402
import styles  # noqa: E402
import pdffix  # noqa: E402

VERSION = "1.0"
DATE_EN, DATE_AR = "October 2026", "أكتوبر 2026"

EDITIONS = {
    "public": dict(
        content="content_public", diagrams="diagrams_public", out_dir=os.path.join(WP_DIR, "public"),
        files={"en": "Mad3oom_White_Paper_EN_Public.pdf", "ar": "Mad3oom_White_Paper_AR_Public.pdf",
               "eg": "Mad3oom_White_Paper_EG.pdf"},
        langs=("en", "ar", "eg"),
        foot={"en": f"Public edition  ·  Version {VERSION}  ·  {DATE_EN}",
              "ar": f"النسخة العامة  ·  الإصدار {VERSION}  ·  {DATE_AR}"}),
    "internal": dict(
        content="content", diagrams="diagrams", out_dir=WP_DIR,
        files={"en": "Mad3oom_White_Paper_EN.pdf", "ar": "Mad3oom_White_Paper_AR.pdf"},
        langs=("en", "ar"),
        foot={"en": f"Version {VERSION}  ·  {DATE_EN}", "ar": f"الإصدار {VERSION}  ·  {DATE_AR}"}),
}

DOC_TITLE = {"en": "The Mad3oom White Paper — Intelligent Customer Support & Unified Customer Operations",
             "ar": "الورقة البيضاء الأساسية لمنصة مدعوم — الدعم الذكي للعملاء وتوحيد عمليات خدمة العملاء"}
SUBJECT = {"en": "Product vision, platform architecture and roadmap",
           "ar": "الرؤية المنتجية والمعمارية التقنية وخارطة الطريق"}
KEYWORDS = {"en": "Mad3oom, customer support, ticketing, Workspace, Relay, SIE, white paper",
            "ar": "مدعوم, دعم العملاء, التذاكر, Workspace, Relay, SIE, ورقة بيضاء"}
COVER = {  # live text of the Arabic cover (the English cover is the supplied image, untouched)
    "t1": "الورقة البيضاء", "t2": "الأساسية لمنصة مدعوم",
    "sub": "الدعم الذكي للعملاء وتوحيد عمليات خدمة العملاء",
    "tag": "رؤية المنتج  •  معمارية المنصة  •  خارطة الطريق",
    "date": "أكتوبر 2026  |  الإصدار 1.0",
    "edition_eg": "النسخة المصرية  ·  بالعامية المصرية",
}


def load_content(pkg: str):
    """Chapters 1..12 and appendices A..C, in order."""
    mods = [f"ch{n:02d}" for n in range(1, 13)] + ["appA", "appB", "appC"]
    out = []
    for m in mods:
        mod = importlib.import_module(f"{pkg}.{m}")
        importlib.reload(mod)
        out.append(mod.CHAPTER)
    front = importlib.import_module(f"{pkg}.front")
    importlib.reload(front)
    return front, out


def chrome_path():
    for p in sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"), reverse=True):
        return p
    return None


def cover_html(lang: str) -> str:
    """English: the supplied cover image, as is.  Arabic / Egyptian: the text-free artwork with live Arabic text."""
    if lang == "en":
        return '<div class="cover"><img src="cover.png" alt="Mad3oom White Paper cover"></div>'
    c = {k: A(v) for k, v in COVER.items()}
    edition = f'<p class="cv cv-edition">{c["edition_eg"]}</p>' if lang == "eg" else ""
    return ('<div class="cover cover-ar"><img src="cover_textfree.png" alt="" role="presentation">'
            f'<p class="cv cv-t1">{lib.inline_plain(c["t1"], "ar")}</p>'
            f'<p class="cv cv-t2">{lib.inline_plain(c["t2"], "ar")}</p><div class="cv-rule"></div>'
            f'<p class="cv cv-sub">{lib.inline_plain(c["sub"], "ar")}</p>{edition}'
            f'<p class="cv cv-tag">{lib.inline_plain(c["tag"], "ar")}</p>'
            f'<p class="cv cv-date">{lib.inline_plain(c["date"], "ar")}</p></div>')


def build_html(ed: dict, lang: str, front, chapters, toc_pages: dict) -> tuple[str, list]:
    rl = "en" if lang == "en" else "ar"            # rendering language (EG renders as Arabic, text via overlay)
    r = Renderer(rl, {})
    r.toc_pages = toc_pages
    idx = 0 if rl == "en" else 1
    rtl = rl == "ar"

    info_html = r.render_chapter(front.INFO)
    chap_html = [r.render_chapter(c) for c in chapters]
    entries = [h for h in r.headings if h[0] in (1, 2)]
    toc_entries = [h for h in entries if not h[1].startswith("front")]
    toc_title = ("Contents", A("المحتويات"))
    toc_html = (f'<section class="chap chap-front" style="page:fronttoc"><h1 id="front-toc">{toc_title[idx]}</h1>'
                f'<div class="toc">{r.render_toc(toc_entries)}</div></section>')
    info_heads = [h for h in r.headings if h[1].startswith("front")]
    other_heads = [h for h in r.headings if not h[1].startswith("front")]
    dom_heads = info_heads + [(1, "front-toc", toc_title[idx], "")] + other_heads

    pages = [("frontinfo", plain(front.INFO.title, rl)), ("fronttoc", toc_title[idx])]
    short = {"appC": ("Basis of Preparation", A("أساس الإعداد والحدود"))}
    for c in chapters:
        t = short[c.slug][idx] if c.slug in short else plain(c.title, rl)
        if c.kind == "chapter":
            pre = f"Chapter {c.num}" if rl == "en" else f"{A('الفصل')} {A(lib.CHAPTER_WORD_AR[c.num])}"
            pages.append((c.slug, f"{pre}  ·  {t}"))
        else:
            letter = c.letter if rl == "en" else {"A": "أ", "B": "ب", "C": "ج"}[c.letter]
            pre = f"Appendix {letter}" if rl == "en" else f"{A('الملحق')} {letter}"
            pages.append((c.slug, f"{pre}  ·  {t}"))
    foot = ed["foot"]["en"] if rl == "en" else A(ed["foot"]["ar"])
    doc_name = "MAD3OOM WHITE PAPER" if rl == "en" else A("وثيقة مدعوم الأساسية")
    css = (styles.FONT_FACES + styles.READEX_FACES + styles.base_css(rl) + DIAGRAM_CSS()
           + styles.page_rules(rl, pages, foot, doc_name))
    title = DOC_TITLE["en"] if rl == "en" else A(DOC_TITLE["ar"])
    htmllang = {"en": "en", "ar": "ar", "eg": "ar-EG"}[lang]
    doc = (f'<!doctype html><html lang="{htmllang}" dir="{"rtl" if rtl else "ltr"}"><head><meta charset="utf-8">'
           f'<title>{title}</title><style>{css}</style></head><body>{cover_html(lang)}{info_html}{toc_html}'
           f'{"".join(chap_html)}</body></html>')
    return doc, dom_heads


_DIAGRAMS_MOD = None


def DIAGRAM_CSS() -> str:
    return _DIAGRAMS_MOD.DIAGRAM_CSS


def render_pdf(html_path: str, pdf_path: str):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        exe = chrome_path()
        b = p.chromium.launch(executable_path=exe, args=["--no-sandbox"]) if exe else p.chromium.launch(args=["--no-sandbox"])
        pg = b.new_page()
        pg.goto("file://" + html_path)
        pg.evaluate("document.fonts.ready")
        pg.wait_for_timeout(300)
        pg.pdf(path=pdf_path, prefer_css_page_size=True, print_background=True, outline=True, tagged=True)
        b.close()


def outline_pages(pdf_path: str) -> list[int]:
    """Page index of every heading in the Chromium-made outline, flattened in document order."""
    from pypdf import PdfReader
    r = PdfReader(pdf_path)
    flat = []

    def walk(items):
        for it in items:
            if isinstance(it, list):
                walk(it)
            else:
                flat.append(r.get_destination_page_number(it))
    walk(r.outline)
    return flat


def finalize(lang: str, raw_pdf: str, dom_heads: list, pages_of: list[int], out_pdf: str, has_cover_heading: bool):
    import pikepdf
    n_fix = pdffix.fix(raw_pdf, out_pdf + ".tmp")
    pdf = pikepdf.open(out_pdf + ".tmp")
    rl = "en" if lang == "en" else "ar"
    # bookmarks with logical-order titles (Chromium stores RTL titles in visual order)
    with pdf.open_outline() as ol:
        ol.root.clear()
        ol.root.append(pikepdf.OutlineItem("Cover" if rl == "en" else A("الغلاف"), 0))
        parent = None
        for (level, anchor, title, label), pg in zip(dom_heads, pages_of):
            if level == 3:
                continue
            text = f"{label}  {title}".strip() if label else title
            item = pikepdf.OutlineItem(text, pg)
            if level == 1:
                ol.root.append(item)
                parent = item
            elif parent is not None:
                parent.children.append(item)
            else:
                ol.root.append(item)
    title = DOC_TITLE["en"] if rl == "en" else A(DOC_TITLE["ar"])
    meta = {"/Title": title, "/Author": "Mad3oom",
            "/Subject": SUBJECT["en"] if rl == "en" else A(SUBJECT["ar"]),
            "/Keywords": KEYWORDS["en"] if rl == "en" else A(KEYWORDS["ar"]),
            "/Creator": "Mad3oom", "/Producer": "Mad3oom"}
    pdf.Root.Lang = pikepdf.String({"en": "en", "ar": "ar", "eg": "ar-EG"}[lang])
    vp = pikepdf.Dictionary(Direction=pikepdf.Name("/R2L" if rl == "ar" else "/L2R"), DisplayDocTitle=True)
    pdf.Root.ViewerPreferences = vp
    with pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=False) as m:
        for k in list(m.keys()):
            del m[k]
        m["dc:title"] = title
        m["dc:creator"] = ["Mad3oom"]
        m["dc:description"] = meta["/Subject"]
        m["dc:language"] = [{"en": "en", "ar": "ar", "eg": "ar-EG"}[lang]]
        m["pdf:Keywords"] = meta["/Keywords"]
        m["pdf:Producer"] = "Mad3oom"
        m["xmp:CreatorTool"] = "Mad3oom"
    # replace the whole document-information dictionary so no build-tool strings survive
    for k in list(pdf.docinfo.keys()):
        del pdf.docinfo[k]
    for k, v in meta.items():
        pdf.docinfo[k] = v
    pdf.save(out_pdf, linearize=False)
    pdf.close()
    os.remove(out_pdf + ".tmp")
    return n_fix


def build(edition: str, lang: str):
    from PIL import Image
    global _DIAGRAMS_MOD
    ed = EDITIONS[edition]
    lib.DIAGRAMS.clear()
    _DIAGRAMS_MOD = importlib.import_module(ed["diagrams"])
    importlib.reload(_DIAGRAMS_MOD)
    os.makedirs(BUILD, exist_ok=True)
    Image.open(os.path.join(HERE, "assets", "cover.webp")).convert("RGB").save(os.path.join(BUILD, "cover.png"), optimize=True)
    tf = os.path.join(HERE, "assets", "cover_textfree.png")
    if os.path.exists(tf):
        Image.open(tf).convert("RGB").save(os.path.join(BUILD, "cover_textfree.png"), optimize=True)

    lib.OVERLAY, lib.COLLECT = None, None
    lib.MISSING.clear()
    if lang == "eg":
        with open(os.path.join(HERE, "translations", "eg.json"), encoding="utf-8") as f:
            lib.OVERLAY = json.load(f)
    front, chapters = load_content(ed["content"])
    toc_pages: dict = {}
    tag = f"{edition}-{lang}"
    for attempt in range(1, 5):
        html_doc, dom_heads = build_html(ed, lang, front, chapters, toc_pages)
        if lib.MISSING:
            sample = "\n  ".join(sorted(lib.MISSING)[:12])
            raise SystemExit(f"{len(lib.MISSING)} Arabic strings have no Egyptian translation, e.g.:\n  {sample}")
        html_path = os.path.join(BUILD, f"{tag}.html")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html_doc)
        raw = os.path.join(BUILD, f"{tag}.raw.pdf")
        render_pdf(html_path, raw)
        pages = outline_pages(raw)
        if len(pages) != len(dom_heads):
            raise SystemExit(f"outline/heading mismatch: {len(pages)} outline entries vs {len(dom_heads)} headings")
        new = {a: pg + 1 for (lvl, a, t, lab), pg in zip(dom_heads, pages)}
        if new == toc_pages:
            break
        toc_pages = new
    os.makedirs(ed["out_dir"], exist_ok=True)
    out = os.path.join(ed["out_dir"], ed["files"][lang])
    n = finalize(lang, raw, dom_heads, pages, out, lang != "en")
    from pypdf import PdfReader
    print(f"[{edition}/{lang}] {ed['files'][lang]}: {len(PdfReader(out).pages)} pages, {os.path.getsize(out)//1024} KB, "
          f"{n} ligature maps patched, TOC passes: {attempt}")
    lib.OVERLAY = None


def extract(edition: str):
    """Render the Arabic edition once without a PDF and record every Arabic string the renderer asked for."""
    global _DIAGRAMS_MOD
    ed = EDITIONS[edition]
    lib.DIAGRAMS.clear()
    _DIAGRAMS_MOD = importlib.import_module(ed["diagrams"])
    importlib.reload(_DIAGRAMS_MOD)
    lib.OVERLAY, lib.COLLECT = None, {}
    lib.CTX[0] = "shell"
    front, chapters = load_content(ed["content"])
    build_html(ed, "ar", front, chapters, {})
    lib.CTX[0] = "shell"
    for extra in (DOC_TITLE["ar"], SUBJECT["ar"], KEYWORDS["ar"], "الغلاف"):   # strings used only when the PDF is finalized
        A(extra)
    coll = lib.COLLECT
    lib.COLLECT = None
    strings = sorted(coll, key=lambda s: (len(s), s))
    os.makedirs(BUILD, exist_ok=True)
    path = os.path.join(BUILD, "ar_strings.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump([{"ar": s, "ctx": coll[s]} for s in strings], f, ensure_ascii=False, indent=0)
    print(f"{len(strings)} distinct Arabic strings -> {path}")
    return strings


if __name__ == "__main__":
    args = sys.argv[1:]
    edition = "internal" if "--internal" in args else "public"
    do_extract = "--extract" in args
    if "--out" in args:                      # build into another directory (used for test builds)
        i = args.index("--out")
        EDITIONS[edition]["out_dir"] = os.path.abspath(args[i + 1])
        del args[i:i + 2]
    langs = [a for a in args if not a.startswith("--")] or list(EDITIONS[edition]["langs"])
    t0 = time.time()
    if do_extract:
        extract(edition)
    else:
        for lg in langs:
            if lg not in EDITIONS[edition]["langs"]:
                raise SystemExit(f"language {lg!r} is not available for the {edition} edition")
            build(edition, lg)
    print(f"done in {time.time()-t0:.1f}s")
