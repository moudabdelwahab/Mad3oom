# Mad3oom White Paper — Arabic and English editions

Version 1.0 · October 2026 · information as of 9 October 2026

| File | Language | Pages |
|---|---|---|
| `Mad3oom_White_Paper_EN.pdf` | English | 47 |
| `Mad3oom_White_Paper_AR.pdf` | Modern Standard Arabic, fully right-to-left | 48 |

Both editions are generated from **one bilingual source** (`src/content/`), so their structure, tables, figures
and facts cannot drift apart. The Arabic edition is equivalent in meaning, not a word-for-word translation.
Page 1 of each edition is the supplied cover image (`src/assets/cover.webp`), embedded losslessly at its
native 1055 × 1491 px; it is not redrawn, cropped or distorted.

## Evidence rules

Every capability carries one stage label: **Existing**, **In development**, **Planned**, **Future** or
**Recommendation**. The paper makes no claims about customer counts, revenue, market share, partnerships,
certifications or real-world accuracy, because none are documented. See Appendix C of the paper for the
basis of preparation and what was not verified.

When the product changes, update the content files and the stage labels together, and keep Appendix A
(the capability register) consistent with the chapters.

## Rebuilding

Requirements: Python 3.11+, `playwright` (with a Chromium build), `pikepdf`, `pypdf`, `Pillow`.

```bash
pip install playwright pikepdf pypdf pillow
python3 docs/whitepaper/src/build.py        # both editions
python3 docs/whitepaper/src/build.py ar     # Arabic only
```

Chromium is located under `/opt/pw-browsers/chromium-*/` when present, otherwise Playwright's default
browser is used. Fonts are vendored in `src/fonts/` (all SIL Open Font License; licence texts included):
Inter (English), Readex Pro (Arabic, and Latin text inside Arabic), JetBrains Mono (reserved for code).

## Layout of `src/`

| Path | Purpose |
|---|---|
| `build.py` | Renders HTML to PDF with Chromium, runs a two-pass table of contents, post-processes and writes metadata |
| `lib.py` | Content model (`chapter`, `TABLE`, `FIG`, …) and the renderer, including Arabic bidi handling |
| `styles.py`, `diagrams.py` | Print stylesheet; figures (HTML/CSS and SVG, mirrored for Arabic) |
| `content/` | Front matter, chapters 1–12 and appendices A–C, each block carrying both languages |
| `pdffix.py` | PDF post-processing for the Arabic text layer (see below) |

## Arabic typography and text layer

- Shaping and bidirectional layout are done by Chromium (HarfBuzz). Latin terms inside Arabic text are wrapped in
  LTR isolates so product names such as `Mad3oom Workspace` keep their order. Western digits are used throughout.
- Readex Pro was chosen after testing candidate Arabic fonts for PDF text extraction: fonts that decompose letters
  into dot and skeleton glyphs produce unusable extracted text in several viewers.
- Chromium writes right-to-left runs in visual order and relies on viewers to reverse each line. It stores ligature
  glyphs (such as lam-alef) with their two characters in logical order, which makes viewers produce `العمالء`
  instead of `العملاء`. `pdffix.py` stores those mappings pre-reversed. Verified on the final files: all 22 test
  words were found by Chrome/Edge's engine (pdfium), poppler and pdf.js. `pypdf` is not spec-compliant here and
  mis-orders words containing lam-alef; it is a library, not a viewer.
- Bookmarks are rebuilt with logical-order Arabic titles, and the Arabic file sets `/ViewerPreferences /Direction /R2L`.

## Known limits

- The supplied cover is 1055 × 1491 px (about 128 ppi at A4). It is fine on screen; professional print would need
  a higher-resolution master.
- A few chapters end on short pages, because every chapter starts on a new page.
