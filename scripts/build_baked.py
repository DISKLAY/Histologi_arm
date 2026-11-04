#!/usr/bin/env python3
"""Режим «Структуры» для снимков, где подписи запечены в растр.

На части слайдов подписи нарисованы прямо на картинке: векторного текста
нет, поэтому build_structures.py такие страницы пропускает. Здесь мы
разбираем сам растр:

1. находим плашки подписей — белые прямоугольники с тёмной рамкой;
2. находим кончик стрелки — самую дальнюю от центра плашки точку её
   тёмного контура-выноски;
3. готовим два кадра: вопрос (текст в плашках залит белым) и ответ
   (подписи как есть).

Названия структур машина прочитать не может (в песочнице нет OCR для
кириллицы), поэтому они лежат в scripts/baked_labels.json:

    {"0113-010": ["Мягкая мозговая оболочка", "Молекулярный слой", ...]}

Порядок названий — порядок плашек сверху вниз, слева направо. Страницы без
записи в этом файле пропускаются: так покрытие можно наращивать постепенно.

Запуск:
    python3 scripts/build_baked.py --pdf-dir /tmp/arena-coding-uploads
"""
from __future__ import annotations

import argparse
import io
import json
import sys
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
import pymupdf
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_assets import GROUPS, PDF_FILES  # noqa: E402
import build_structures as bs  # noqa: E402

CURATION = ROOT / "scripts" / "baked_labels.json"
OUT_JS = ROOT / "js" / "data" / "baked.js"
IMG_DIR = ROOT / "assets" / "baked"
SCALE = 1.7          # во сколько раз увеличиваем кадр для показа
MIN_SIDE = 200       # картинки меньше этого — не препарат


# ---------------------------------------------------------------- растр

def plates_and_tips(img: Image.Image) -> list[dict]:
    """Плашки подписей и кончики их стрелок на картинке-растре."""
    a = np.asarray(img.convert("RGB"))
    ref = max(a.shape[:2])
    S = max(1.0, ref / 700.0)          # все пороги — в «условных» пикселях

    white = ((a[:, :, 0] > 235) & (a[:, :, 1] > 235) & (a[:, :, 2] > 235)).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(white, 8)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT,
                                       (max(3, int(S * 20)), max(3, int(S * 12))))

    out = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if not (S * 40 < w < S * 420 and S * 11 < h < S * 160):
            continue
        if area <= 0.25 * w * h or area < S * 180:
            continue
        comp = (lab[y:y + h, x:x + w] == i).astype(np.uint8)
        opened = cv2.morphologyEx(comp, cv2.MORPH_OPEN, kernel)
        if opened.sum() < S * 150:
            continue                     # не прямоугольная плашка
        sub = a[y:y + h, x:x + w]
        dark = ((sub[:, :, 0] < 120) & (sub[:, :, 1] < 120) & (sub[:, :, 2] < 120)).sum()
        if dark < 0.005 * w * h:
            continue                     # внутри нет текста

        ys, xs = np.where(opened > 0)
        cx, cy = xs.mean(), ys.mean()
        ys2, xs2 = np.where(comp > 0)
        keep = (np.abs(xs2 - cx) <= 2.4 * w + 30) & (np.abs(ys2 - cy) <= 2.4 * h + 30)
        xs2, ys2 = xs2[keep], ys2[keep]
        if not len(xs2):
            continue
        j = int(np.argmax((xs2 - cx) ** 2 + (ys2 - cy) ** 2))
        out.append({
            "plate": [int(x), int(y), int(x + w), int(y + h)],
            "tip": [int(x + xs2[j]), int(y + ys2[j])],
        })

    # порядок: сверху вниз, при близкой высоте — слева направо
    out.sort(key=lambda z: (z["plate"][1] // max(1, int(S * 20)), z["plate"][0]))
    return out


def page_images(doc: pymupdf.Document, page: pymupdf.Page) -> list[tuple[int, Image.Image, pymupdf.Rect]]:
    """Встроенные картинки страницы: (xref, картинка, место на странице)."""
    res = []
    for im in page.get_images(full=True):
        try:
            info = doc.extract_image(im[0])
            img = Image.open(io.BytesIO(info["image"])).convert("RGB")
        except Exception:
            continue
        if img.width < MIN_SIDE or img.height < MIN_SIDE:
            continue
        rects = page.get_image_rects(im[0])
        if not rects:
            continue
        res.append((im[0], img, rects[0]))
    return res


def pick_labelled(items):
    """Кадр с наибольшим числом плашек — это снимок с подписями."""
    best = None
    for xref, img, rect in items:
        pl = plates_and_tips(img)
        if best is None or len(pl) > best[3]:
            best = (xref, img, rect, len(pl))
    return best


# ---------------------------------------------------------------- сборка

def erasable_plates(img: Image.Image, plates: list[dict]) -> list[tuple[int, int, int, int]]:
    """Прямоугольники плашек для заливки белым (с узким запасом внутрь)."""
    out = []
    for p in plates:
        x0, y0, x1, y1 = p["plate"]
        m = 2
        if x1 - x0 > 2 * m and y1 - y0 > 2 * m:
            out.append((x0 + m, y0 + m, x1 - m, y1 - m))
    return out


def make_pair(img: Image.Image, plates: list[dict]):
    """Кадр-вопрос (текст залит) и кадр-ответ (подписи на месте)."""
    scale = SCALE * min(2.5, 900.0 / max(img.width, img.height))
    w, h = int(img.width * scale), int(img.height * scale)

    answer = img.resize((w, h), Image.LANCZOS)
    question = img.copy()
    d = ImageDraw.Draw(question)
    for x0, y0, x1, y1 in erasable_plates(img, plates):
        d.rectangle([x0, y0, x1, y1], fill=(255, 255, 255))
    question = question.resize((w, h), Image.LANCZOS)
    return question, answer, scale


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf-dir", required=True)
    ap.add_argument("--only", default="", help="страницы через запятую: 0113-010,0221-016")
    args = ap.parse_args()

    curated = {}
    if CURATION.exists():
        curated = json.loads(CURATION.read_text(encoding="utf-8"))

    ranges = {}
    for g in GROUPS:
        gid, title, number, stain = g[0], g[1], g[2], g[3]
        for tag, a, b in g[5]:
            for pn in range(a, b + 1):
                ranges[(tag, pn)] = (gid, title, number, stain)

    pdf_dir = Path(args.pdf_dir)
    docs = {tag: pymupdf.open(pdf_dir / name) for tag, name in PDF_FILES.items()}

    only = {s.strip() for s in args.only.split(",") if s.strip()}
    IMG_DIR.mkdir(parents=True, exist_ok=True)

    cards, stats = [], defaultdict(int)
    for (tag, pn), (gid, title, number, stain) in sorted(ranges.items()):
        cid = f"{tag}-{pn:03d}"
        if only and cid not in only:
            continue
        doc = docs.get(tag)
        if doc is None or pn > len(doc):
            continue
        page = doc[pn - 1]
        if bs.content_bbox(page) is None:
            continue
        # страницы с векторными подписями уже разбирает build_structures.py
        if [l for l in bs.group_lines(bs.raw_lines(page)) if bs.usable_label(l["t"])]:
            continue

        items = page_images(doc, page)
        if not items:
            continue
        best = pick_labelled(items)
        if best is None or best[3] < 2:
            stats["без плашек"] += 1
            continue
        _xref, img, _rect, _n = best
        plates = plates_and_tips(img)
        names = curated.get(cid)
        if not names:
            stats["нет названий"] += 1
            continue
        if len(names) != len(plates):
            stats["число названий не совпало"] += 1
            print(f"  ! {cid}: плашек {len(plates)}, названий {len(names)}")
            continue

        question, answer, scale = make_pair(img, plates)
        question.save(IMG_DIR / f"{cid}-q.jpg", "JPEG", quality=85, optimize=True)
        answer.save(IMG_DIR / f"{cid}-a.jpg", "JPEG", quality=85, optimize=True)

        labels = []
        for name, p in zip(names, plates):
            x0, y0, x1, y1 = p["plate"]
            tx, ty = p["tip"]
            labels.append({
                "text": name,
                "box": [round(x0 * scale), round(y0 * scale), round(x1 * scale), round(y1 * scale)],
                "tips": [[round(tx * scale, 1), round(ty * scale, 1)]],
            })
        cards.append({
            "id": cid, "groupId": gid, "title": title, "number": number,
            "stain": stain, "slide": gid and number and pn,
            "w": answer.width, "h": answer.height, "labels": labels,
        })
        stats["карточек"] += 1

    data = {"version": 1, "baked": True, "cards": cards}
    OUT_JS.write_text(
        "/* Сгенерировано scripts/build_baked.py. Не редактировать вручную. */\n"
        "window.HISTO_BAKED = " + json.dumps(data, ensure_ascii=False) + ";\n",
        encoding="utf-8")
    print(json.dumps(dict(stats), ensure_ascii=False, indent=2))
    print("карточек:", len(cards), "| подписей:", sum(len(c["labels"]) for c in cards))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
