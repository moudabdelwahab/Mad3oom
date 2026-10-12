#!/usr/bin/env python3
"""Make the text-free base of the Mad3oom cover, used by the Arabic and Egyptian-Arabic editions.

The supplied cover (assets/cover.webp) carries its English title block, subtitle and footer line baked into
the image.  For the Arabic editions those text areas are replaced by smooth background (a bilinear 'Coons
patch' interpolated from the pixels around each area), keeping the brand wordmark, the logo and all of the
artwork untouched.  Real Arabic typography is then set over it in HTML (see build.py), so the cover text is
live, searchable text rather than part of a picture.

    python3 src/tools/make_arabic_cover_base.py   ->  src/assets/cover_textfree.png
"""
import os
import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")

# (x0, y0, x1, y1) of the text areas to clear, in the cover's native 1055 x 1491 pixels.
AREAS = [(95, 772, 965, 1030), (235, 1030, 835, 1208), (130, 1348, 925, 1452)]


def coons(img, box, pad=7, smooth=10):
    x0, y0, x1, y1 = box
    h, w = y1 - y0, x1 - x0
    def edge(arr, axis):
        a = arr.mean(axis=axis)                       # average the strip across its thickness
        return cv2.GaussianBlur(a.reshape(-1, 1, 3) if a.ndim == 2 else a, (0, 0), smooth).reshape(-1, 3)
    top = edge(img[y0 - pad:y0 - 1, x0:x1], 0)         # (w,3)
    bot = edge(img[y1 + 1:y1 + pad, x0:x1], 0)
    lef = edge(img[y0:y1, x0 - pad:x0 - 1], 1)         # (h,3)
    rig = edge(img[y0:y1, x1 + 1:x1 + pad], 1)
    tx = np.linspace(0, 1, w)[None, :, None]
    ty = np.linspace(0, 1, h)[:, None, None]
    c00, c10, c01, c11 = top[0], top[-1], bot[0], bot[-1]
    patch = ((1 - ty) * top[None, :, :] + ty * bot[None, :, :]
             + (1 - tx) * lef[:, None, :] + tx * rig[:, None, :]
             - ((1 - tx) * (1 - ty) * c00 + tx * (1 - ty) * c10 + (1 - tx) * ty * c01 + tx * ty * c11))
    return patch


def main():
    rgb = np.array(Image.open(os.path.join(ASSETS, "cover.webp")).convert("RGB")).astype(np.float32)
    out = rgb.copy()
    for box in AREAS:
        x0, y0, x1, y1 = box
        patch = coons(out, box)
        # feather the patch edges so no seam is visible
        f = 10
        m = np.ones((y1 - y0, x1 - x0), np.float32)
        m[:f, :] *= np.linspace(0, 1, f)[:, None]; m[-f:, :] *= np.linspace(1, 0, f)[:, None]
        m[:, :f] *= np.linspace(0, 1, f)[None, :]; m[:, -f:] *= np.linspace(1, 0, f)[None, :]
        out[y0:y1, x0:x1] = out[y0:y1, x0:x1] * (1 - m[..., None]) + patch * m[..., None]
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(os.path.join(ASSETS, "cover_textfree.png"), optimize=True)
    print("wrote", os.path.join(ASSETS, "cover_textfree.png"))


if __name__ == "__main__":
    main()
