"""Content model and HTML renderer for the Mad3oom White Paper (EN + AR + EG from one source).

Every content block carries English and Modern Standard Arabic, so the two editions cannot drift
apart structurally: the renderer walks the same block list once per language.

The Egyptian-Arabic edition (EG) is rendered exactly like the Arabic one (same blocks, same
right-to-left layout); every Arabic string is passed through ``A()``, which swaps it for its
Egyptian-Arabic counterpart from a translation overlay.  The overlay is keyed by the Modern
Standard Arabic string, so it cannot silently drift from the source: a string with no
translation is reported and fails the build.
"""
from __future__ import annotations
import html
import re
from dataclasses import dataclass, field

LANGS = ("en", "ar")

_AR = re.compile("[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFC]")
OVERLAY = None      # dict {MSA string: Egyptian string}; set by build.py for the Egyptian edition only
COLLECT = None      # dict {string: first context}; when not None every Arabic string the renderer asks for is recorded
CTX = ["shell"]     # what is being rendered right now (chapter slug, figure name ...), recorded with collected strings
MISSING = set()     # Arabic strings that were requested while OVERLAY was active but have no translation


def A(s):
    """Arabic-slot text, translated through the Egyptian overlay when that edition is being built."""
    if not s or not _AR.search(s):
        return s
    if COLLECT is not None:
        COLLECT.setdefault(s, CTX[0])
    if OVERLAY is not None:
        eg = OVERLAY.get(s)
        if eg is None:
            MISSING.add(s)
            return s
        return eg
    return s

# --- status vocabulary (used for chips, legends and the roadmap) ------------------------------
STATUS = {
    "E": ("Existing", "قائم"),
    "D": ("In development", "قيد التطوير"),
    "P": ("Planned", "مخطَّط"),
    "F": ("Future", "مستقبلي"),
    "R": ("Recommendation", "توصية"),
}

CHAPTER_WORD_AR = ["", "الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع",
                   "الثامن", "التاسع", "العاشر", "الحادي عشر", "الثاني عشر"]


# --- content DSL --------------------------------------------------------------------------------
def _pair(en, ar=None):
    if isinstance(en, tuple):
        return en
    return (en, ar if ar is not None else en)


@dataclass
class Block:
    kind: str
    data: dict = field(default_factory=dict)


def P(en, ar, cls=""):
    return Block("p", dict(t=(en, ar), cls=cls))


def LEAD(en, ar):
    return Block("lead", dict(t=(en, ar)))


def H2(en, ar):
    return Block("h2", dict(t=(en, ar)))


def H3(en, ar):
    return Block("h3", dict(t=(en, ar)))


def UL(*items, cls=""):
    return Block("ul", dict(items=[_pair(*i) if not isinstance(i, tuple) else i for i in items], cls=cls))


def OL(*items):
    return Block("ol", dict(items=list(items)))


def NOTE(en, ar, kind="note", title=None):
    """kind: note | limit | defn"""
    return Block("note", dict(t=(en, ar), kind=kind, title=title))


def TABLE(head, rows, widths=None, cls="", caption=None):
    """head: [(en, ar)], rows: [[(en, ar) | str]], widths: list of percentages"""
    return Block("table", dict(head=head, rows=rows, widths=widths, cls=cls, caption=caption))


def FIG(name, caption):
    return Block("fig", dict(name=name, caption=caption))


def KEY(title, *items):
    """A compact 'at a glance' list: title=(en, ar), items=[(en, ar)]"""
    return Block("key", dict(title=title, items=list(items)))


def LEGEND(rows=None):
    """Status legend. ``rows`` optionally overrides the default definitions: [(key, (en, ar)), ...]."""
    return Block("legend", dict(rows=rows))


@dataclass
class Chapter:
    num: int | None            # 1..12, None for front/back matter
    kind: str                  # chapter | appendix | front
    letter: str | None
    title: tuple
    lead: tuple | None
    blocks: list
    slug: str = ""


def chapter(num, title, lead, blocks):
    return Chapter(num=num, kind="chapter", letter=None, title=title, lead=lead, blocks=blocks, slug=f"ch{num}")


def appendix(letter, title, lead, blocks):
    return Chapter(num=None, kind="appendix", letter=letter, title=title, lead=lead, blocks=blocks, slug=f"app{letter}")


# --- inline markup ----------------------------------------------------------------------------------
_LATIN_RUN = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9_\-./+:%&#@'’]*(?:[  ][A-Za-z0-9][A-Za-z0-9_\-./+:%&#@'’]*)*")
_TRAIL = ".:-/+&#@'’"


def _bidi_wrap(fragment: str) -> str:
    """Wrap Latin/number runs in LTR isolates so they keep their order inside RTL text."""
    def repl(m):
        s = m.group(0)
        tail = ""
        while s and s[-1] in _TRAIL:
            tail = s[-1] + tail
            s = s[:-1]
        if not s:
            return m.group(0)
        return f'<bdi class="ltr" dir="ltr">{s}</bdi>{tail}'
    return _LATIN_RUN.sub(repl, fragment)


def inline(text: str, lang: str) -> str:
    """Escape, then expand our tiny inline markup: **bold**, `code`, {{E}} chips, {{ch5}} refs."""
    s = html.escape(text, quote=False)
    idx = 0 if lang == "en" else 1

    def chip(m):
        k = m.group(1)
        return f'<span class="chip chip-{k}">{STATUS[k][0] if idx == 0 else A(STATUS[k][1])}</span>'
    s = re.sub(r"\{\{([EDPFR])\}\}", chip, s)

    def ref(m):
        n = int(m.group(1))
        label = f"Chapter {n}" if lang == "en" else f"{A('الفصل')} {A(CHAPTER_WORD_AR[n])}"
        return f'<a class="xref" href="#ch{n}">{label}</a>'
    s = re.sub(r"\{\{ch(\d+)\}\}", ref, s)

    def appref(m):
        L = m.group(1)
        label = f"Appendix {L}" if lang == "en" else f"{A('الملحق')} {({'A':'أ','B':'ب','C':'ج'})[L]}"
        return f'<a class="xref" href="#app{L}">{label}</a>'
    s = re.sub(r"\{\{app([A-C])\}\}", appref, s)

    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`([^`]+)`", r'<code class="ltr" dir="ltr">\1</code>', s)
    if lang == "ar":
        parts = re.split(r"(<[^>]+>)", s)
        out, in_code = [], False
        for part in parts:
            if part.startswith("<"):
                if part.startswith("<code"):
                    in_code = True
                elif part.startswith("</code"):
                    in_code = False
                out.append(part)
            else:
                out.append(part if in_code else _bidi_wrap(part))
        s = "".join(out)
    return s


def pick(pair, lang):
    return pair[0] if lang == "en" else A(pair[1])


def T(pair, lang):
    return inline(pick(pair, lang), lang)


def plain(pair, lang):
    """Plain (unmarked) text for PDF outline / TOC strings."""
    s = pick(pair, lang)
    s = re.sub(r"\{\{[^}]+\}\}", "", s)
    s = s.replace("**", "").replace("`", "")
    return s.strip()


# --- diagram registry (filled by diagrams.py) ----------------------------------------------------
DIAGRAMS = {}


def diagram(name):
    def deco(fn):
        DIAGRAMS[name] = fn
        return fn
    return deco


# --- rendering ----------------------------------------------------------------------------------
class Renderer:
    def __init__(self, lang, doc_meta):
        self.lang = lang
        self.meta = doc_meta
        self.fig_no = 0
        self.tab_no = 0
        self.headings = []     # (level, anchor, title_plain, label) in DOM order, for TOC/outline
        self.toc_pages = {}

    # block renderers ---------------------------------------------------------------
    def render_block(self, b: Block, ch: Chapter, sec_counter: list) -> str:
        L = self.lang
        k, d = b.kind, b.data
        if k == "p":
            cls = f' class="{d["cls"]}"' if d["cls"] else ""
            return f"<p{cls}>{T(d['t'], L)}</p>"
        if k == "lead":
            return f'<p class="lead">{T(d["t"], L)}</p>'
        if k == "h2":
            sec_counter[0] += 1
            if ch.kind == "chapter":
                label = f"{ch.num}.{sec_counter[0]}"
            elif ch.kind == "appendix":
                label = f"{ch.letter if L == 'en' else {'A':'أ','B':'ب','C':'ج'}[ch.letter]}.{sec_counter[0]}"
            else:
                label = ""
            anchor = f"{ch.slug}-s{sec_counter[0]}"
            self.headings.append((2, anchor, plain(d["t"], L), label))
            num = f'<span class="sec-no">{label}</span>' if label else ""
            return f'<h2 id="{anchor}">{num}<span class="sec-t">{T(d["t"], L)}</span></h2>'
        if k == "h3":
            sec_counter.append(1)
            anchor = f"{ch.slug}-h3-{len(sec_counter)}"
            self.headings.append((3, anchor, plain(d["t"], L), ""))
            return f'<h3 id="{anchor}">{T(d["t"], L)}</h3>'
        if k == "ul":
            cls = f' class="{d["cls"]}"' if d["cls"] else ""
            items = "".join(f"<li>{T(i, L)}</li>" for i in d["items"])
            return f"<ul{cls}>{items}</ul>"
        if k == "ol":
            items = "".join(f"<li>{T(i, L)}</li>" for i in d["items"])
            return f"<ol>{items}</ol>"
        if k == "note":
            title = d["title"]
            defaults = {"note": ("Note", "ملاحظة"), "limit": ("Limitations", "حدود وتحفظات"),
                        "defn": ("Definition", "تعريف")}
            tt = title or defaults[d["kind"]]
            return (f'<aside class="note note-{d["kind"]}"><div class="note-h">{T(tt, L)}</div>'
                    f'<div class="note-b">{T(d["t"], L)}</div></aside>')
        if k == "table":
            return self.render_table(d)
        if k == "fig":
            self.fig_no += 1
            CTX[0] = "figure:" + d["name"]
            svg = DIAGRAMS[d["name"]](L)
            CTX[0] = ch.slug
            cap = T(d["caption"], L)
            word = "Figure" if L == "en" else A("الشكل")
            return (f'<figure><div class="fig-svg">{svg}</div>'
                    f'<figcaption><span class="cap-no">{word} {self.fig_no}.</span> {cap}</figcaption></figure>')
        if k == "key":
            items = "".join(f"<li>{T(i, L)}</li>" for i in d["items"])
            return f'<aside class="key"><div class="key-h">{T(d["title"], L)}</div><ul>{items}</ul></aside>'
        if k == "legend":
            return self.render_legend(d.get("rows"))
        raise ValueError(k)

    def render_table(self, d):
        L = self.lang
        i = 0 if L == "en" else 1
        cols = len(d["head"])
        widths = d["widths"] or [100 / cols] * cols
        colgroup = "".join(f'<col style="width:{w}%">' for w in widths)
        head = "".join(f"<th>{T(h, L)}</th>" for h in d["head"])
        body = []
        for row in d["rows"]:
            cells = []
            for c in row:
                cells.append(f"<td>{T(c if isinstance(c, tuple) else (c, c), L)}</td>")
            body.append("<tr>" + "".join(cells) + "</tr>")
        cap = ""
        if d["caption"]:
            self.tab_no += 1
            word = "Table" if L == "en" else A("الجدول")
            cap = f'<p class="tcap"><span class="cap-no">{word} {self.tab_no}.</span> {T(d["caption"], L)}</p>'
        cls = f' class="{d["cls"]}"' if d["cls"] else ""
        keep = len(d["rows"]) <= 9 and "long" not in d["cls"]
        tbl = (f'{cap}<table{cls}><colgroup>{colgroup}</colgroup>'
               f'<thead><tr>{head}</tr></thead><tbody>{"".join(body)}</tbody></table>')
        return f'<div class="keep">{tbl}</div>' if keep else tbl

    def render_legend(self, custom=None):
        L = self.lang
        rows = custom or [
            ("E", ("Implemented in the project repositories, with automated tests where noted. It does not imply "
                   "production maturity, wide use or independent validation.",
                   "منفَّذ في مستودعات المشروع، مع اختبارات آلية حيث يُذكر ذلك. ولا يعني نضجًا إنتاجيًا "
                   "ولا استخدامًا واسعًا ولا تحققًا مستقلًا.")),
            ("D", ("Active engineering work: code written or partly delivered, not yet complete or enabled for users.",
                   "عمل هندسي جارٍ: شيفرة مكتوبة أو مُسلَّمة جزئيًا، لم تكتمل أو لم تُفعَّل للمستخدمين بعد.")),
            ("P", ("Designed and intended, with no delivered implementation yet. Subject to validation and priorities.",
                   "مصمَّم ومقصود، دون تنفيذ مُسلَّم حتى الآن، ويخضع للتحقق من الجدوى ولترتيب الأولويات.")),
            ("F", ("A long-term opportunity or exploratory direction. No commitment is made.",
                   "فرصة بعيدة المدى أو اتجاه استكشافي، ولا يُقدَّم بشأنه أي التزام.")),
            ("R", ("Architectural or security guidance proposed by this paper or by internal reviews. "
                   "It is advice, not a statement about the current system.",
                   "إرشاد معماري أو أمني مقترح في هذه الورقة أو في المراجعات الداخلية. وهو توجيه، وليس وصفًا للنظام الحالي.")),
        ]
        out = ['<table class="legend"><tbody>']
        for k, desc in rows:
            out.append(f'<tr><td class="lg-chip"><span class="chip chip-{k}">{STATUS[k][0] if L == "en" else A(STATUS[k][1])}</span></td>'
                       f'<td>{T(desc, L)}</td></tr>')
        out.append("</tbody></table>")
        return "".join(out)

    # chapter ------------------------------------------------------------------------
    def render_chapter(self, ch: Chapter) -> str:
        L = self.lang
        CTX[0] = ch.slug
        sec = [0]
        title = plain(ch.title, L)
        if ch.kind == "chapter":
            label_en, label_ar = f"CHAPTER {ch.num}", f"{A('الفصل')} {A(CHAPTER_WORD_AR[ch.num])}"
            big = f"{ch.num:02d}"
        elif ch.kind == "appendix":
            label_en, label_ar = f"APPENDIX {ch.letter}", f"{A('الملحق')} {({'A':'أ','B':'ب','C':'ج'})[ch.letter]}"
            big = ch.letter if L == 'en' else {'A': 'أ', 'B': 'ب', 'C': 'ج'}[ch.letter]
        else:
            label_en = label_ar = ""
            big = ""
        label = label_en if L == "en" else label_ar
        if ch.kind != "front":
            self.headings.append((1, ch.slug, title, label.title() if L == "en" else label))
        else:
            self.headings.append((1, ch.slug, title, ""))
        opener = ""
        if ch.kind != "front":
            opener = (f'<header class="opener"><div class="op-num">{big}</div>'
                      f'<div class="op-label">{label}</div></header>')
        h1 = f'<h1 id="{ch.slug}">{T(ch.title, L)}</h1>'
        lead = f'<p class="lead">{T(ch.lead, L)}</p>' if ch.lead else ""
        body = "".join(self.render_block(b, ch, sec) for b in ch.blocks)
        page = ch.slug.replace("-", "")
        return f'<section class="chap chap-{ch.kind}" style="page:{page}">{opener}{h1}{lead}{body}</section>'

    # TOC ------------------------------------------------------------------------------
    def render_toc(self, entries) -> str:
        L = self.lang
        rows = []
        for level, anchor, title, label in entries:
            pg = self.toc_pages.get(anchor, "")
            lab = f'<span class="toc-lab">{label}</span>' if label else ""
            rows.append(
                f'<a class="toc-row toc-l{level}" href="#{anchor}">{lab}'
                f'<span class="toc-t">{inline_plain(title, L)}</span>'
                f'<span class="toc-dots"></span><span class="toc-pg">{pg}</span></a>')
        return "".join(rows)


def inline_plain(text, lang):
    s = html.escape(text, quote=False)
    if lang == "ar":
        parts = re.split(r"(<[^>]+>)", s)
        s = "".join(p if p.startswith("<") else _bidi_wrap(p) for p in parts)
    return s
