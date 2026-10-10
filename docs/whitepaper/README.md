# Mad3oom White Paper

Version 1.0 · October 2026 · information as of 9 October 2026

There are two kinds of edition, kept in separate source trees and separate output folders on purpose.

## Public editions (for distribution): `public/`

| File | Language | Notes |
|---|---|---|
| `public/Mad3oom_White_Paper_EN_Public.pdf` | English | Page 1 is the supplied cover image, untouched |
| `public/Mad3oom_White_Paper_AR_Public.pdf` | Modern Standard Arabic, fully right-to-left | Genuine Arabic cover in the same identity |
| `public/Mad3oom_White_Paper_EG.pdf` | Egyptian colloquial Arabic (العامية المصرية), fully right-to-left | A complete, standalone edition built from the public content, not a summary |

The public editions describe product capabilities, architecture at a conceptual level, security principles and verified
claims, and do not publish operational or implementation detail. Security descriptions are design objectives and safeguards that can be traced to the
project; they are not guarantees and are not independently verified. The paper claims no certification, no compliance with
any standard and no independent penetration test.

## Internal editions (restricted): the PDFs in this folder

`Mad3oom_White_Paper_EN.pdf` and `Mad3oom_White_Paper_AR.pdf` are the **internal** editions: restricted engineering records,
**not for distribution**, kept unchanged. The default build never rewrites them (see below).

> The internal editions and their sources (`src/content/`, `src/diagrams.py`) sit in the same repository as everything else.
> If the repository is public, treat them as already disclosed and move them to a restricted location. The public editions
> are the only documents meant to be shared.

## Single source, three languages

- Each public chapter is written once as English and Modern Standard Arabic pairs in `src/content_public/`, so the two
  cannot drift apart structurally.
- The Egyptian edition renders the same blocks through a translation overlay, `src/translations/eg.json`
  (Modern Standard Arabic string → Egyptian string). A string with no translation fails the build, so the Egyptian text can
  never silently fall behind the source.
- The Arabic and Egyptian covers use the supplied cover artwork with its English text removed
  (`src/tools/make_arabic_cover_base.py`) and live Arabic typography set over it.

## Rebuilding

Requirements: Python 3.11+, `playwright` (with a Chromium build), `pikepdf`, `pypdf`, `Pillow`, `opencv-python-headless`
(only to regenerate the cover base).

```bash
pip install playwright pikepdf pypdf pillow
python3 docs/whitepaper/src/build.py               # the three public editions -> docs/whitepaper/public/
python3 docs/whitepaper/src/build.py ar eg         # some of them
python3 docs/whitepaper/src/build.py --extract     # list every Arabic string (input for the Egyptian translation)
python3 docs/whitepaper/src/tools/validate_eg.py   # check the Egyptian overlay (coverage, markup, numbers, names)
python3 docs/whitepaper/src/build.py --internal en ar   # restricted: rebuilds the internal editions
```

Fonts are vendored in `src/fonts/` (SIL Open Font License; licence texts included): Inter (English), Readex Pro (Arabic
and Latin text inside Arabic), JetBrains Mono (reserved for code).

## Evidence rules

Every capability carries one stage label: **Existing**, **In development**, **Planned**, **Future** or **Recommendation**.
The paper makes no claims about customer counts, revenue, market share, partnerships, certifications or real-world
accuracy, because none are documented. Appendix C states the basis of preparation and what was not verified. When the
product changes, update the content files and the stage labels together, and keep Appendix A (the capability register)
consistent with the chapters.

## Keeping the public edition public-safe

Changes to `src/content_public/` and `src/diagrams_public.py` are published. Keep them at the conceptual level: no
operational or deployment detail, no identifiers or mechanisms, and no control described as complete, guaranteed or
independently verified without evidence. `tests/whitepaper-public.test.mjs` guards the generic markers of internal-state wording.

## Arabic typography and text layer

- Shaping and bidirectional layout are done by Chromium (HarfBuzz). Latin terms inside Arabic text are wrapped in LTR
  isolates so product names such as `Mad3oom Workspace` keep their order. Western digits are used throughout.
- Readex Pro was chosen after testing candidate Arabic fonts for PDF text extraction: fonts that decompose letters into dot
  and skeleton glyphs produce unusable extracted text in several viewers.
- Chromium writes right-to-left runs in visual order and relies on viewers to reverse each line. It stores ligature glyphs
  (such as lam-alef) with their two characters in logical order, which makes viewers produce `العمالء` instead of `العملاء`.
  `pdffix.py` stores those mappings pre-reversed.
- Bookmarks are rebuilt with logical-order Arabic titles, and the Arabic and Egyptian files set
  `/ViewerPreferences /Direction /R2L`.
- PDF metadata is replaced wholesale (title, author, subject, keywords, neutral producer); the files carry no attachments,
  no layers and no scripts.

## Layout of `src/`

| Path | Purpose |
|---|---|
| `build.py` | Renders HTML to PDF with Chromium, runs a two-pass table of contents, post-processes and writes metadata |
| `lib.py` | Content model (`chapter`, `TABLE`, `FIG`, …) and the renderer, including Arabic bidi handling and the Egyptian overlay hook |
| `styles.py`, `diagrams_public.py` | Print stylesheet; figures (HTML/CSS and SVG, mirrored for Arabic) |
| `content_public/` | Public front matter, chapters 1–12 and appendices A–C |
| `translations/eg.json` | The Egyptian-Arabic overlay |
| `tools/` | Cover base generator, Egyptian overlay validator |
| `pdffix.py` | PDF post-processing for the Arabic text layer |
| `content/`, `diagrams.py` | The internal edition's sources (restricted, unchanged) |

## Known limits

- The supplied cover is 1055 × 1491 px (about 128 ppi at A4). It is fine on screen; professional print would need a
  higher-resolution master.
- A few chapters end on short pages, because every chapter starts on a new page.
