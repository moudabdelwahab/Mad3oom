"""Print stylesheet for both editions (paged media, Chromium)."""

NAVY = "#002560"
NAVY_DEEP = "#00143F"
BLUE = "#2074D0"
BLUE_BRIGHT = "#2498DC"
SKY = "#DCEBFB"
TINT = "#EEF4FC"
TINT2 = "#F6F9FE"
INK = "#14233B"
MUTED = "#55657F"
RULE = "#D3DFEE"

FONT_FACES = """
@font-face{font-family:"Inter";font-weight:400;font-style:normal;src:url("../fonts/inter-latin-400-normal.woff2") format("woff2")}
@font-face{font-family:"Inter";font-weight:400;font-style:italic;src:url("../fonts/inter-latin-400-italic.woff2") format("woff2")}
@font-face{font-family:"Inter";font-weight:500;font-style:normal;src:url("../fonts/inter-latin-500-normal.woff2") format("woff2")}
@font-face{font-family:"Inter";font-weight:600;font-style:normal;src:url("../fonts/inter-latin-600-normal.woff2") format("woff2")}
@font-face{font-family:"Inter";font-weight:700;font-style:normal;src:url("../fonts/inter-latin-700-normal.woff2") format("woff2")}
@font-face{font-family:"JetBrains Mono";font-weight:400;src:url("../fonts/jetbrains-mono-latin-400-normal.woff2") format("woff2")}
@font-face{font-family:"JetBrains Mono";font-weight:500;src:url("../fonts/jetbrains-mono-latin-500-normal.woff2") format("woff2")}
"""

# Readex Pro: one family with two subset files (Arabic, Latin). The unicode-range split is
# the same one the font vendor publishes, so Arabic text and Latin/digits come from the right file.
_AR_RANGE = ("U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,"
             "U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC")
_LT_RANGE = ("U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,"
             "U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD")
READEX_FACES = "".join(
    f'@font-face{{font-family:"Readex Pro";font-weight:{w};src:url("../fonts/readex-pro-arabic-{w}-normal.woff2") format("woff2");unicode-range:{_AR_RANGE}}}'
    f'@font-face{{font-family:"Readex Pro";font-weight:{w};src:url("../fonts/readex-pro-latin-{w}-normal.woff2") format("woff2");unicode-range:{_LT_RANGE}}}'
    for w in (400, 500, 600, 700))


def _q(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def page_rules(lang: str, pages: list[tuple[str, str]], foot_left: str, doc_name: str | None = None) -> str:
    """Named @page rules: running header (document name | chapter), footer (edition | page no.)."""
    rtl = lang == "ar"
    fam = '"Readex Pro","Inter"' if rtl else '"Inter"'
    spacing = "0" if rtl else ".14em"
    doc_name = doc_name or ("وثيقة مدعوم الأساسية" if rtl else "MAD3OOM WHITE PAPER")
    out = []
    # physical positions: in RTL the document name sits at the right (start) edge
    name_pos, chap_pos = ("right", "left") if rtl else ("left", "right")
    for name, chap in pages:
        out.append(f"""
@page {name} {{
  size: A4; margin: 25mm 21mm 24mm 21mm;
  @top-{name_pos} {{ content: "{_q(doc_name)}"; font-family: {fam}; font-weight: 600; font-size: 7pt;
      letter-spacing: {spacing}; color: {NAVY}; text-align: {name_pos}; vertical-align: bottom;
      padding-bottom: 5pt; border-bottom: .6pt solid {RULE}; width: 42%; }}
  @top-center {{ content: ""; border-bottom: .6pt solid {RULE}; width: 16%; }}
  @top-{chap_pos} {{ content: "{_q(chap)}"; font-family: {fam}; font-weight: 500; font-size: 7pt;
      letter-spacing: {spacing}; color: {MUTED}; text-align: {chap_pos}; vertical-align: bottom;
      padding-bottom: 5pt; border-bottom: .6pt solid {RULE}; width: 42%; }}
  @bottom-{name_pos} {{ content: "{_q(foot_left)}"; font-family: {fam}; font-size: 7pt; color: {MUTED};
      text-align: {name_pos}; vertical-align: top; padding-top: 6pt; }}
  @bottom-{chap_pos} {{ content: counter(page); font-family: "Inter"; font-weight: 600; font-size: 8pt;
      color: {NAVY}; text-align: {chap_pos}; vertical-align: top; padding-top: 5pt; }}
}}""")
    return "\n".join(out)


# Arabic cover: the supplied artwork with its English text removed (src/tools/make_arabic_cover_base.py), with live
# Arabic typography set over it in the same navy and blue as the English cover.  Positions are in mm on the A4 page
# and follow the English cover's layout (title block, rule, subtitle, footer line).
COVER_AR_CSS = """
.cover.cover-ar { direction:rtl; font-family:"Readex Pro","Inter",sans-serif; color:#0A2A6B; }
.cover-ar .cv { position:absolute; left:0; right:0; text-align:center; margin:0; padding:0 14mm; }
.cover-ar .cv-t1 { top:151mm; font-weight:700; font-size:58pt; line-height:1.2; letter-spacing:0; color:#0A2A6B; white-space:nowrap; }
.cover-ar .cv-t2 { top:180mm; font-weight:700; font-size:27pt; line-height:1.3; color:#0A2A6B; white-space:nowrap; }
.cover-ar .cv-rule { position:absolute; top:203mm; left:50%; width:28mm; margin-left:-14mm; height:0; border-top:1.1pt solid #2074D0; }
.cover-ar .cv-sub { top:209mm; font-weight:500; font-size:15.5pt; line-height:1.55; color:#0A2A6B; padding:0 26mm; }
.cover-ar .cv-edition { top:240mm; font-weight:500; font-size:10.5pt; color:#2074D0; }
.cover-ar .cv-tag { top:271.5mm; font-weight:600; font-size:8.6pt; letter-spacing:0; color:#0A2A6B; }
.cover-ar .cv-date { top:279.5mm; font-weight:400; font-size:8.6pt; color:#55657F; }
"""


def base_css(lang: str) -> str:
    rtl = lang == "ar"
    body_font = '"Readex Pro","Inter",sans-serif' if rtl else '"Inter",sans-serif'
    fs = "9.6pt" if rtl else "9.7pt"
    lh = "1.95" if rtl else "1.62"
    track = "0" if rtl else ".06em"
    return f"""
@page cover {{ size: A4; margin: 0; }}
:root {{
  --navy:{NAVY}; --navy-deep:{NAVY_DEEP}; --blue:{BLUE}; --bright:{BLUE_BRIGHT}; --sky:{SKY};
  --tint:{TINT}; --tint2:{TINT2}; --ink:{INK}; --muted:{MUTED}; --rule:{RULE};
}}
* {{ box-sizing: border-box; }}
html {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
body {{ margin:0; font-family:{body_font}; font-size:{fs}; line-height:{lh}; color:var(--ink);
        font-kerning: normal; hyphens: manual; orphans:3; widows:3;
        font-feature-settings: "kern" 1, "liga" 1, "calt" 1; }}
.ltr {{ unicode-bidi: isolate; direction: ltr; }}
code {{ font-family:"JetBrains Mono","Inter",monospace; font-size:.84em; background:var(--tint);
        padding:.5pt 3pt; border-radius:2pt; color:var(--navy); white-space:nowrap; }}
strong {{ font-weight:600; color:var(--navy-deep); }}
a {{ color:inherit; text-decoration:none; }}
a.xref {{ color:var(--blue); font-weight:500; }}

/* cover */
.cover {{ page:cover; height:296.6mm; width:210mm; position:relative; overflow:hidden; break-after:page; }}
.cover img {{ position:absolute; inset:0; width:210mm; height:297mm; object-fit:cover; display:block; }}
{COVER_AR_CSS}

/* chapters */
.chap {{ break-before: page; }}
.opener {{ display:flex; align-items:flex-end; gap:12pt; margin: 6mm 0 3mm; }}
.op-num {{ font-family:"Inter","Readex Pro"; font-weight:700; font-size:58pt; line-height:{'1.3' if rtl else '.9'}; color:var(--sky);
           letter-spacing:-.02em; }}
.op-label {{ font-weight:600; font-size:8pt; letter-spacing:{ '0' if rtl else '.22em'}; color:var(--blue);
             padding-bottom:5pt; {'font-size:9.5pt;' if rtl else ''} }}
h1 {{ font-size:{'25pt' if rtl else '27pt'}; line-height:{'1.45' if rtl else '1.16'}; font-weight:700; color:var(--navy);
      margin:0 0 5mm; letter-spacing:{'0' if rtl else '-.015em'}; padding-bottom:4mm;
      border-bottom:1.4pt solid var(--blue); break-after:avoid; }}
.chap-front h1 {{ margin-top:6mm; }}
.lead {{ font-size:{'11pt' if rtl else '11.2pt'}; line-height:{'1.9' if rtl else '1.6'}; color:var(--navy);
         font-weight:400; margin: 0 0 6mm; }}
h2 {{ font-size:{'13pt' if rtl else '13.2pt'}; line-height:1.4; font-weight:600; color:var(--navy);
      margin: 8mm 0 2.4mm; break-after:avoid; display:flex; gap:7pt; align-items:baseline; }}
h2 .sec-no {{ color:var(--blue); font-weight:600; font-feature-settings:"tnum" 1; flex:none; font-family:"Inter","Readex Pro"; }}
h3 {{ font-size:10.4pt; font-weight:600; color:var(--navy); margin: 3.8mm 0 1.2mm; break-after:avoid; }}
p {{ margin: 0 0 2.9mm; text-align:{'start'}; }}
ul, ol {{ margin: 0 0 3.2mm; padding-inline-start: 5mm; }}
li {{ margin: 0 0 1.5mm; padding-inline-start: 1mm; }}
li::marker {{ color: var(--blue); }}
ul.tight li {{ margin-bottom:.6mm; }}

p:has(+ .keep), p:has(+ table), p:has(+ .tcap), p:has(+ figure), p:has(+ .note), li:has(+ .nothing) {{ break-after:avoid; }}

/* chips */
.chip {{ display:inline-block; font-family:{'"Readex Pro","Inter"' if rtl else '"Inter"'}; font-weight:600;
         font-size:{'6.6pt' if rtl else '6.2pt'}; line-height:1; letter-spacing:{'0' if rtl else '.07em'};
         text-transform:{'none' if rtl else 'uppercase'}; padding:{'2.2pt 5pt 2.4pt' if rtl else '2.4pt 5pt 2.2pt'}; border-radius:8pt;
         vertical-align:{'1pt' if rtl else '.5pt'}; white-space:nowrap; margin-inline:1pt; }}
.chip-E {{ background:var(--navy); color:#fff; }}
.chip-D {{ background:var(--blue); color:#fff; }}
.chip-P {{ background:var(--sky); color:var(--navy); box-shadow: inset 0 0 0 .7pt var(--blue); }}
.chip-F {{ background:#fff; color:var(--blue); box-shadow: inset 0 0 0 .7pt var(--blue); }}
.chip-R {{ background:#E6EBF3; color:#344864; }}
.chip-F {{ background-image: repeating-linear-gradient(135deg, #fff 0 2pt, #F1F6FD 2pt 4pt); }}

/* callouts */
.note {{ margin: 4mm 0 4.4mm; padding: 3mm 4mm 2.6mm; background:var(--tint); border-inline-start:2.6pt solid var(--blue);
         border-radius:0 3pt 3pt 0; break-inside:avoid; }}
html[dir=rtl] .note {{ border-radius:3pt 0 0 3pt; }}
.note-h {{ font-weight:600; font-size:{'8pt' if rtl else '7pt'}; letter-spacing:{'0' if rtl else '.14em'};
           text-transform:{'none' if rtl else 'uppercase'}; color:var(--blue); margin-bottom:1mm; }}
.note-b {{ font-size:{'9.2pt' if rtl else '9.2pt'}; line-height:{'1.85' if rtl else '1.55'}; }}
.note-limit {{ background:#fff; border:.8pt solid var(--navy); border-inline-start:3.4pt solid var(--navy); }}
.note-limit .note-h {{ color:var(--navy); }}
.note-defn {{ background:var(--tint2); border-inline-start-color:var(--bright); }}
.key {{ margin: 0 0 5mm; padding: 3.2mm 4.4mm 1.6mm; background:var(--navy); color:#fff; border-radius:3pt; break-inside:avoid; }}
.key-h {{ font-weight:600; font-size:{'8.4pt' if rtl else '7pt'}; letter-spacing:{'0' if rtl else '.16em'};
          text-transform:{'none' if rtl else 'uppercase'}; color:#9CC6F4; margin-bottom:1.4mm; }}
.key ul {{ margin:0; padding-inline-start:4.4mm; }} .key li {{ margin-bottom:1.2mm; color:#E8F1FD; }}
.key li::marker {{ color:#6FB0F2; }} .key strong {{ color:#fff; }}

/* tables */
table {{ width:100%; border-collapse:collapse; margin: 3.4mm 0 5mm; font-size:{'8.5pt' if rtl else '8.5pt'};
         line-height:{'1.7' if rtl else '1.45'}; }}
.tcap {{ font-size:8.2pt; color:var(--muted); margin:4.2mm 0 -2mm; break-after:avoid; line-height:1.5; }}
.tcap + table {{ margin-top:2mm; }}
.cap-no {{ font-weight:600; color:var(--navy); }}
th {{ background:var(--navy); color:#fff; text-align:start; font-weight:600; font-size:{'8pt' if rtl else '7.4pt'};
      letter-spacing:{'0' if rtl else '.05em'}; text-transform:{'none' if rtl else 'uppercase'}; padding:2.2mm 2.6mm; vertical-align:bottom; }}
td {{ padding:2.1mm 2.6mm; vertical-align:top; border-bottom:.6pt solid var(--rule); }}
tbody tr:nth-child(even) td {{ background:var(--tint2); }}
tr {{ break-inside:avoid; }}
thead {{ display:table-header-group; }}
td strong {{ color:var(--navy); }}
table.compact td {{ padding:1.5mm 2.4mm; font-size:8.2pt; }}
table.legend {{ margin-top:2mm; }} table.legend th {{ display:none; }}
table.legend td {{ background:#fff !important; padding:1.6mm 2.6mm; }} .lg-chip {{ width:21%; white-space:nowrap; }}

/* figures */
.keep {{ break-inside:avoid; }}
figure {{ margin: 5mm 0 6mm; break-inside:avoid; }}
.fig-svg svg {{ width:100%; height:auto; display:block; }}
figcaption {{ font-size:8.2pt; color:var(--muted); margin-top:2mm; line-height:{'1.7' if rtl else '1.45'}; }}
svg text {{ font-family:{body_font}; }}

/* contents */
.toc {{ margin-top:2mm; }}
.toc-row {{ display:flex; align-items:baseline; gap:6pt; }}
.toc-l1 {{ font-weight:600; color:var(--navy); font-size:{'10pt' if rtl else '10.2pt'}; margin-top:2.5mm; padding-top:1.1mm; border-top:.6pt solid var(--rule); }}
.toc-l1:first-child {{ border-top:0; margin-top:0; }}
.toc-l2 {{ font-size:{'8.6pt' if rtl else '8.8pt'}; color:var(--ink); padding-inline-start:12mm; line-height:{'1.5' if rtl else '1.5'}; }}
.toc-lab {{ flex:none; min-width:{'20mm' if rtl else '22mm'}; color:var(--blue); font-weight:600; font-size:{'8.4pt' if rtl else '8pt'}; }}
.toc-l2 .toc-lab {{ min-width:9mm; color:var(--muted); font-weight:500; }}
.toc-t {{ flex:none; }} .toc-dots {{ flex:1; border-bottom:.8pt dotted #9DB4D3; transform:translateY(-1.5pt); min-width:6mm; }}
.toc-pg {{ flex:none; min-width:7mm; text-align:end; font-family:"Inter","Readex Pro"; font-weight:600; color:var(--navy); font-feature-settings:"tnum" 1; }}
.toc-l2 .toc-pg {{ font-weight:500; color:var(--muted); }}

/* document information */
.docinfo td:first-child {{ width:30%; color:var(--muted); font-weight:500; }}
.docinfo td {{ background:#fff !important; padding:1.5mm 2.6mm; }}
.small {{ font-size:8.4pt; color:var(--muted); line-height:{'1.8' if rtl else '1.5'}; }}
"""
