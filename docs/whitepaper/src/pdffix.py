"""Post-process Chromium PDFs: make the Arabic text layer extract correctly.

Chromium (Skia) writes RTL glyph runs in *visual* order wrapped in /ReversedChars and
maps ligature glyphs (e.g. lam-alef) to a two-character string in logical order. Viewers
undo the visual order by reversing the whole extracted string, which also reverses the
two characters of the ligature ("لا" -> "ال"). Storing multi-character Arabic mappings
pre-reversed makes every viewer's reversal land on the correct logical text.
"""
import re, sys, pikepdf

ARABIC = re.compile(r'^[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]+$')

def _patch_cmap(data: bytes):
    txt = data.decode('latin1')
    changed = 0
    def fix_hex(h):
        nonlocal changed
        try:
            s = bytes.fromhex(h).decode('utf-16-be')
        except Exception:
            return h
        if len(s) > 1 and ARABIC.match(s):
            changed += 1
            return s[::-1].encode('utf-16-be').hex().upper()
        return h
    # bfchar blocks: <src> <dst>
    def bfchar_block(m):
        body = re.sub(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>',
                      lambda mm: f'<{mm.group(1)}> <{fix_hex(mm.group(2))}>', m.group(2))
        return m.group(1) + body + m.group(3)
    txt = re.sub(r'(beginbfchar)(.*?)(endbfchar)', bfchar_block, txt, flags=re.S)
    return txt.encode('latin1'), changed

def fix(src, dst):
    pdf = pikepdf.open(src)
    seen, total = set(), 0
    for obj in pdf.objects:
        if isinstance(obj, pikepdf.Dictionary) and obj.get('/Type') == '/Font' and '/ToUnicode' in obj:
            tu = obj['/ToUnicode']
            key = tu.objgen
            if key in seen: continue
            seen.add(key)
            new, n = _patch_cmap(tu.read_bytes())
            if n:
                tu.write(new)
                total += n
    pdf.save(dst)
    return total

if __name__ == '__main__':
    print('patched ligature mappings:', fix(sys.argv[1], sys.argv[2]))
