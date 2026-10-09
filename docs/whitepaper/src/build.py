#!/usr/bin/env python3
"""Build the Mad3oom White Paper PDFs (English + Arabic) from one bilingual source.

    python3 src/build.py            # builds both editions into docs/whitepaper/
    python3 src/build.py en         # only English
    python3 src/build.py ar         # only Arabic

Requires: python3, playwright (Chromium), pikepdf, pypdf, Pillow.  Fonts are vendored in src/fonts.
"""
from __future__ import annotations
import glob
import importlib
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.dirname(HERE)
BUILD = os.path.join(HERE, "_build")
sys.path.insert(0, HERE)

import lib  # noqa: E402
from lib import Chapter, Renderer, plain, inline_plain  # noqa: E402
import styles  # noqa: E402
import diagrams  # noqa: E402,F401  (registers the figures)
import pdffix  # noqa: E402

VERSION = "1.0"
DATE_EN, DATE_AR = "October 2026", "أكتوبر 2026"
FILES = {"en": "Mad3oom_White_Paper_EN.pdf", "ar": "Mad3oom_White_Paper_AR.pdf"}

DOC_TITLE = {"en": "The Mad3oom White Paper — Intelligent Customer Support & Unified Customer Operations",
             "ar": "الورقة البيضاء الأساسية لمنصة مدعوم — الدعم الذكي للعملاء وتوحيد عمليات خدمة العملاء"}
FOOT_LEFT = {"en": f"Version {VERSION}  ·  {DATE_EN}", "ar": f"الإصدار {VERSION}  ·  {DATE_AR}"}


def load_content():
    """Chapters 1..12 and appendices A..C, in order."""
    mods = [f"ch{n:02d}" for n in range(1, 13)] + ["appA", "appB", "appC"]
    out = []
    for m in mods:
        mod = importlib.import_module(f"content.{m}")
        importlib.reload(mod)
        out.append(mod.CHAPTER)
    front = importlib.import_module("content.front")
    importlib.reload(front)
    return front, out


def chrome_path():
    for p in sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"), reverse=True):
        return p
    return None


def build_html(lang: str, front, chapters, toc_pages: dict) -> tuple[str, list]:
    r = Renderer(lang, {})
    r.toc_pages = toc_pages
    idx = 0 if lang == "en" else 1
    rtl = lang == "ar"

    # --- front matter ---------------------------------------------------------------
    info_html = r.render_chapter(front.INFO)
    # contents: gather entries first by rendering chapters (headings list is filled as we render)
    chap_html = [r.render_chapter(c) for c in chapters]
    entries = [h for h in r.headings if h[0] in (1, 2)]
    # drop the front-info heading from the TOC listing but keep it in DOM order list
    toc_entries = [h for h in entries if not h[1].startswith("front")]
    toc_title = ("Contents", "المحتويات")
    toc_html = (f'<section class="chap chap-front" style="page:fronttoc"><h1 id="front-toc">{toc_title[idx]}</h1>'
                f'<div class="toc">{r.render_toc(toc_entries)}</div></section>')
    # DOM order of headings: info, toc, then chapters.  Rebuild list in that order.
    info_heads = [h for h in r.headings if h[1].startswith("front")]
    other_heads = [h for h in r.headings if not h[1].startswith("front")]
    dom_heads = info_heads + [(1, "front-toc", toc_title[idx], "")] + other_heads

    pages = [("frontinfo", plain(front.INFO.title, lang)), ("fronttoc", toc_title[idx])]
    short = {"appC": ("Basis of Preparation", "أساس الإعداد والحدود")}
    for c in chapters:
        t = short[c.slug][idx] if c.slug in short else plain(c.title, lang)
        if c.kind == "chapter":
            pre = f"Chapter {c.num}" if lang == "en" else f"الفصل {lib.CHAPTER_WORD_AR[c.num]}"
            pages.append((c.slug, f"{pre}  ·  {t}"))
        else:
            letter = c.letter if lang == "en" else {"A": "أ", "B": "ب", "C": "ج"}[c.letter]
            pre = f"Appendix {letter}" if lang == "en" else f"الملحق {letter}"
            pages.append((c.slug, f"{pre}  ·  {t}"))
    css = (styles.FONT_FACES + styles.READEX_FACES + styles.base_css(lang) + diagrams.DIAGRAM_CSS
           + styles.page_rules(lang, pages, FOOT_LEFT[lang]))
    cover = '<div class="cover"><img src="cover.png" alt="Mad3oom White Paper cover"></div>'
    title = DOC_TITLE[lang]
    doc = (f'<!doctype html><html lang="{lang}" dir="{"rtl" if rtl else "ltr"}"><head><meta charset="utf-8">'
           f'<title>{title}</title><style>{css}</style></head><body>{cover}{info_html}{toc_html}'
           f'{"".join(chap_html)}</body></html>')
    return doc, dom_heads


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


def finalize(lang: str, raw_pdf: str, dom_heads: list, pages_of: list[int], out_pdf: str):
    import pikepdf
    n_fix = pdffix.fix(raw_pdf, out_pdf + ".tmp")
    pdf = pikepdf.open(out_pdf + ".tmp")
    # bookmarks with logical-order titles (Chromium stores RTL titles in visual order)
    with pdf.open_outline() as ol:
        ol.root.clear()
        ol.root.append(pikepdf.OutlineItem("Cover" if lang == "en" else "الغلاف", 0))
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
    meta = {"/Title": DOC_TITLE[lang], "/Author": "Mad3oom",
            "/Subject": ("Product vision, platform architecture and roadmap"
                         if lang == "en" else "الرؤية المنتجية والمعمارية التقنية وخارطة الطريق"),
            "/Keywords": ("Mad3oom, customer support, ticketing, Workspace, Relay, SIE, white paper"
                          if lang == "en" else "مدعوم, دعم العملاء, التذاكر, Workspace, Relay, SIE, ورقة بيضاء"),
            "/Creator": "Mad3oom white paper build (Chromium + pikepdf)"}
    for k, v in meta.items():
        pdf.docinfo[k] = v
    pdf.Root.Lang = pikepdf.String(lang)
    vp = pikepdf.Dictionary(Direction=pikepdf.Name("/R2L" if lang == "ar" else "/L2R"), DisplayDocTitle=True)
    pdf.Root.ViewerPreferences = vp
    with pdf.open_metadata() as m:
        m["dc:title"] = DOC_TITLE[lang]
        m["dc:creator"] = ["Mad3oom"]
        m["dc:language"] = [lang]
    pdf.save(out_pdf, linearize=False)
    pdf.close()
    os.remove(out_pdf + ".tmp")
    return n_fix


def build(lang: str):
    from PIL import Image
    os.makedirs(BUILD, exist_ok=True)
    Image.open(os.path.join(HERE, "assets", "cover.webp")).convert("RGB").save(os.path.join(BUILD, "cover.png"), optimize=True)
    front, chapters = load_content()
    toc_pages: dict = {}
    for attempt in range(1, 5):
        html_doc, dom_heads = build_html(lang, front, chapters, toc_pages)
        html_path = os.path.join(BUILD, f"{lang}.html")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html_doc)
        raw = os.path.join(BUILD, f"{lang}.raw.pdf")
        render_pdf(html_path, raw)
        pages = outline_pages(raw)
        if len(pages) != len(dom_heads):
            raise SystemExit(f"outline/heading mismatch: {len(pages)} outline entries vs {len(dom_heads)} headings")
        new = {a: pg + 1 for (lvl, a, t, lab), pg in zip(dom_heads, pages)}
        if new == toc_pages:
            break
        toc_pages = new
    out = os.path.join(OUT_DIR, FILES[lang])
    n = finalize(lang, raw, dom_heads, pages, out)
    from pypdf import PdfReader
    print(f"[{lang}] {FILES[lang]}: {len(PdfReader(out).pages)} pages, {os.path.getsize(out)//1024} KB, "
          f"{n} ligature maps patched, TOC passes: {attempt}")


if __name__ == "__main__":
    which = sys.argv[1:] or ["en", "ar"]
    t0 = time.time()
    for lg in which:
        build(lg)
    print(f"done in {time.time()-t0:.1f}s")
