"""Prepare description images for text extraction: decode any QR codes and cut tall images into tiles.

    python prep_images.py <dir>

Reads every image in <dir>, writes tiles to <dir>/tiles, prints JSON:
    {"qr": [{"image": name, "text": ...}], "tiles": [{"image": name, "path": ...}]}

Detail pages stack everything into images several thousand pixels tall; the Windows OCR engine wants pieces
of a sane size, and upscaling small print makes it readable.
"""
import json
import os
import sys

import cv2
import numpy as np

TILE_H, OVERLAP, MIN_W = 1400, 120, 1000


def main() -> int:
    root = sys.argv[1]
    out = os.path.join(root, "tiles")
    os.makedirs(out, exist_ok=True)
    detector = cv2.QRCodeDetector()
    qr, tiles = [], []
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if not os.path.isfile(path):
            continue
        img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)  # fromfile: non-ASCII paths
        if img is None or img.shape[0] < 40 or img.shape[1] < 200:
            continue
        try:
            ok, texts, _, _ = detector.detectAndDecodeMulti(img)
            qr += [{"image": name, "text": t} for t in (texts if ok else []) if t]
        except cv2.error:
            pass
        if img.shape[1] < MIN_W:
            scale = MIN_W / img.shape[1]
            img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        h, y, i = img.shape[0], 0, 0
        while y < h:
            tile = img[y:min(h, y + TILE_H)]
            if tile.shape[0] >= 40:
                dest = os.path.join(out, f"{os.path.splitext(name)[0]}_{i:02d}.png")
                cv2.imencode(".png", tile)[1].tofile(dest)
                tiles.append({"image": name, "path": dest})
            y += TILE_H - OVERLAP
            i += 1
    json.dump({"qr": qr, "tiles": tiles}, sys.stdout, ensure_ascii=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
