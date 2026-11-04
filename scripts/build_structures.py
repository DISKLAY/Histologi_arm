#!/usr/bin/env python3
"""Собирает данные режима «Структуры»: названия подписей, облачка и кончики стрелок.

Режим показывает снимок без названий и спрашивает: «что за структура в плашке 1?».
Чтобы вопрос был понятным, у каждой подписи нужно знать:

* саму подпись (текст из векторного слоя PDF);
* рамку её облачка на странице;
* точку, на которую указывает стрелка.

Запуск:
    python3 scripts/build_structures.py --pdf-dir /path/to/pdfs

Результат: js/data/structures.js (вместе с картинками он не нужен — картинки
рендерятся тем же прогоном в assets/structures/).

Как ищется стрелка. Облачко в этих слайдах — белая заливка с тонкой тёмной
рамкой, а стрелка-указатель — либо продолжение той же фигуры, либо отдельный
белый треугольник, примыкающий к рамке. Поэтому:

1. Облачко — белая заливка, которая на 60 % и более заполнена текстом подписи.
2. Кончик — самая дальняя от подписи вершина любой белой фигуры, примыкающей
   к рамке облачка, при условии, что точка лежит на самом препарате (внутри
   рамки фотографии), а не на пустом поле страницы.

Векторные подписи есть не на всех слайдах: там, где подписи запечены в растр,
разметку надо делать вручную — такие страницы скрипт просто пропускает.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pymupdf
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_assets import GROUPS, PDF_FILES, TAGS, SLIDE_OFFSET  # noqa: E402

HEADER = re.compile(r"^(Препарат|Окраска|https?://|Раздел)", re.I)
DIGITS = re.compile(r"^\d{1,2}$")
JUNK = re.compile(r"^[•\-–—\s]+$")
BAD_HEAD = re.compile(r"^(\d{1,2}\.\s|Препарат|Окраска|•|https?://|-cortex)", re.I)
SCALE = 1.7           # масштаб рендера «ответного» снимка
PAD = 8               # поля вокруг области интереса, пункты


# ---------------------------------------------------------------- геометрия

def _white(c) -> bool:
    return c is not None and all(v > 0.97 for v in c)


def _path_points(d) -> list[tuple[float, float]]:
    """Вершины пути: линии, кривые и прямоугольники."""
    out: list[tuple[float, float]] = []
    for it in d["items"]:
        if it[0] == "l":
            out += [(it[1].x, it[1].y), (it[2].x, it[2].y)]
        elif it[0] == "c":
            out += [(it[1].x, it[1].y), (it[4].x, it[4].y)]
        elif it[0] == "re":
            q = it[1]
            out += [(q.x0, q.y0), (q.x1, q.y0), (q.x1, q.y1), (q.x0, q.y1)]
    return out


def _dist(p, r: pymupdf.Rect) -> float:
    return math.hypot(max(r.x0 - p[0], 0, p[0] - r.x1), max(r.y0 - p[1], 0, p[1] - r.y1))


# ---------------------------------------------------------------- подписи

def raw_lines(page: pymupdf.Page) -> list[dict]:
    out = []
    for bl in page.get_text("dict")["blocks"]:
        if bl["type"] != 0:
            continue
        for line in bl["lines"]:
            text = "".join(s["text"] for s in line["spans"]).strip()
            if text:
                out.append({"t": text, "r": pymupdf.Rect(line["bbox"])})
    return out


def group_lines(lines: list[dict]) -> list[dict]:
    """Склеивает строки одной подписи.

    Строки одной подписи стоят друг под другом и по центру совпадают. Просто
    склеивать всё, что близко по вертикали, нельзя: на слайде рядом стоят
    подписи на одной строке («Мягкая мозговая» и «Клетки-зёрна»), и раньше они
    сливались в одну.
    """
    body = [l for l in lines
            if not HEADER.match(l["t"]) and not DIGITS.match(l["t"]) and not JUNK.match(l["t"])]
    body.sort(key=lambda l: (round(l["r"].y0 / 3), l["r"].x0))
    used = [False] * len(body)
    out = []
    for i, line in enumerate(body):
        if used[i]:
            continue
        cur = [line]
        used[i] = True
        changed = True
        while changed:
            changed = False
            for j, m in enumerate(body):
                if used[j]:
                    continue
                for c in cur:
                    ccx = (c["r"].x0 + c["r"].x1) / 2
                    mcx = (m["r"].x0 + m["r"].x1) / 2
                    if (abs(ccx - mcx) < max(30, c["r"].width * 0.6)
                            and -2 <= m["r"].y0 - c["r"].y1 <= c["r"].height * 0.9):
                        cur.append(m)
                        used[j] = True
                        changed = True
                        break
        cur.sort(key=lambda z: z["r"].y0)
        # Слово, разорванное переносом на две строки («Дистальны» + «й»),
        # склеиваем без пробела, иначе в подписи появляется «Дистальны й».
        text = ""
        for c in cur:
            piece = c["t"].strip()
            if not text:
                text = piece
            elif piece and len(piece) <= 2 and text[-1].isalpha():
                text += piece
            else:
                text += " " + piece
        out.append({
            "t": text,
            "r": pymupdf.Rect(
                min(c["r"].x0 for c in cur), min(c["r"].y0 for c in cur),
                max(c["r"].x1 for c in cur), max(c["r"].y1 for c in cur),
            ),
        })
    return out


def usable_label(text: str) -> bool:
    """Отсев прозы и мусора: подпись — это короткое название структуры."""
    t = text.strip()
    if not (4 <= len(t) <= 55):
        return False
    if BAD_HEAD.match(t) or t.count("•") or "  " in t:
        return False
    if re.search(r"[.:;]$", t) and len(t) > 25:
        return False
    if len(t.split()) > 6:
        return False
    return bool(re.search(r"[А-Яа-яЁё]", t))


# ---------------------------------------------------------------- стрелки

def content_bbox(page: pymupdf.Page) -> pymupdf.Rect:
    """Рамка, в которой лежат фотографии препарата (кончик не должен вылезать за неё)."""
    rects = []
    for im in page.get_images(full=True):
        for r in page.get_image_rects(im[0]):
            if r.width > 25 and r.height > 25:
                rects.append(r)
    if not rects:
        return page.rect
    return pymupdf.Rect(min(r.x0 for r in rects), min(r.y0 for r in rects),
                        max(r.x1 for r in rects), max(r.y1 for r in rects))


def detect(page: pymupdf.Page) -> tuple[list[dict], pymupdf.Rect]:
    """Возвращает подписи с облачками и кончиками стрелок."""
    all_labels = [l for l in group_lines(raw_lines(page)) if usable_label(l["t"])]
    page_area = page.rect.get_area()
    cb = content_bbox(page)

    whites = []
    for d in page.get_drawings():
        if not _white(d.get("fill")):
            continue
        r = d["rect"]
        if r.get_area() > 0.45 * page_area or max(r.width, r.height) < 6:
            continue
        whites.append({"rect": r, "pts": _path_points(d)})

    def near_edge(p, bubble) -> bool:
        return _dist(p, bubble) < 3.5

    items = []
    for lab in all_labels:
        best = None
        for w in whites:
            inter = w["rect"] & lab["r"]
            if inter.is_empty:
                continue
            if inter.get_area() / max(1.0, lab["r"].get_area()) < 0.6:
                continue
            compact = lab["r"].get_area() / w["rect"].get_area()
            if best is None or compact > best[0]:
                best = (compact, w)
        if best:
            items.append({"label": lab, "bubble": best[1]["rect"], "tips": []})

    # Кончик ищем как самую дальнюю от центра подписи точку белых фигур,
    # которые примыкают к облачку. Именно от центра текста, а не от рамки:
    # у части выносок хвост нарисован одной фигурой с облачком, и тогда
    # прямоугольник заливки уже включает сам хвост.
    tissue = cb + (-24, -24, 24, 24)

    def valid(p, label_rect) -> bool:
        if not tissue.contains(pymupdf.Point(p)):
            return False
        if label_rect.contains(pymupdf.Point(p)):
            return False
        return True

    for it in items:
        lr, br = it["label"]["r"], it["bubble"]
        cx, cy = (lr.x0 + lr.x1) / 2, (lr.y0 + lr.y1) / 2
        cand = []
        for w in whites:
            if not w["pts"]:
                continue
            # фигура должна примыкать к облачку или к подписи
            if min(min(_dist(p, br), _dist(p, lr)) for p in w["pts"]) > 6:
                continue
            # точка должна быть заметно дальше самого облачка, иначе метка
            # садится на его край и «указывает» в пустоту
            reach = min(br.width, br.height) * 0.6 + 14
            ok = [(_dist(q, lr), q) for q in w["pts"]
                  if valid(q, lr) and math.hypot(q[0] - cx, q[1] - cy) >= reach]
            if not ok:
                continue
            dmax, apex = max(ok, key=lambda z: z[0])
            if dmax <= 20:
                continue
            cand.append((dmax, apex))
        if not cand:
            continue
        top = max(c[0] for c in cand)
        merged = []
        for dmax, p in sorted((c for c in cand if c[0] >= 0.6 * top), key=lambda z: -z[0]):
            if any(math.dist(p, m[1]) < 25 for m in merged):
                continue
            merged.append((dmax, p))
        it["tips"] = merged[:2]
    return all_labels, items, cb


# ---------------------------------------------------------------- рендер

def render_page(page: pymupdf.Page, clip: pymupdf.Rect, erase: list[pymupdf.Rect]) -> Image.Image:
    """Снимок страницы: названия подписей залиты белым, облачка и стрелки целы."""
    scale = SCALE
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=clip)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    d = ImageDraw.Draw(img)
    for r in erase:
        d.rectangle([(r.x0 - clip.x0) * scale - 1, (r.y0 - clip.y0) * scale - 1,
                     (r.x1 - clip.x0) * scale + 1, (r.y1 - clip.y0) * scale + 1], fill=(255, 255, 255))
    return img


def region_of_interest(page: pymupdf.Page, items: list[dict], cb: pymupdf.Rect) -> pymupdf.Rect:
    """Область снимка: препарат вместе со всеми облачками и подписями."""
    xs0, ys0, xs1, ys1 = [cb.x0], [cb.y0], [cb.x1], [cb.y1]
    for it in items:
        for r in (it.get("bubble"), it["label"]["r"] if "label" in it else it["r"]):
            if r is None:
                continue
            xs0.append(r.x0); ys0.append(r.y0); xs1.append(r.x1); ys1.append(r.y1)
    clip = pymupdf.Rect(min(xs0) - PAD, min(ys0) - PAD, max(xs1) + PAD, max(ys1) + PAD)
    # служебная кнопка «домой» в правом нижнем углу в кадр не нужна
    if clip.x1 > 856 and clip.y1 > 456:
        clip.x1 = min(clip.x1, 856)
        clip.y1 = min(clip.y1, 456)
    return clip & page.rect


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf-dir", default="/tmp/arena-coding-uploads")
    ap.add_argument("--out", default=str(ROOT))
    args = ap.parse_args()

    pdf_dir = Path(args.pdf_dir)
    out = Path(args.out)
    for name in PDF_FILES:
        if not (pdf_dir / name).exists():
            print(f"Не найден PDF: {pdf_dir / name}", file=sys.stderr)
            return 1
    docs = {tag: pymupdf.open(pdf_dir / name) for tag, name in zip(TAGS, PDF_FILES)}

    group_by_page: dict[tuple[str, int], str] = {}
    for gid, _title, _number, _stain, _system, ranges in GROUPS:
        for tag, a, b in ranges:
            for pn in range(a, b + 1):
                group_by_page[(tag, pn)] = gid
    meta = {g[0]: {"title": g[1], "number": g[2], "stain": g[3], "system": g[4]} for g in GROUPS}

    img_dir = out / "assets" / "structures"
    img_dir.mkdir(parents=True, exist_ok=True)
    for f in img_dir.glob("*.jpg"):
        f.unlink()

    cards = []
    stats = defaultdict(int)
    for (tag, pn), gid in sorted(group_by_page.items()):
        doc = docs[tag]
        if pn > len(doc):
            continue
        page = doc[pn - 1]
        all_labels, items, cb = detect(page)
        if not items:
            stats["без векторных подписей"] += 1
            continue
        if not any(it["tips"] for it in items):
            stats["без стрелок"] += 1
            continue
        clip = region_of_interest(page, all_labels + items, cb)
        if clip.width < 120 or clip.height < 90:
            stats["слишком маленький кадр"] += 1
            continue

        cid = f"{tag}-{pn:03d}"
        answered = render_page(page, clip, [])
        asked = render_page(page, clip, [l["r"] for l in all_labels])
        answered.save(img_dir / f"{cid}-a.jpg", "JPEG", quality=84, optimize=True)
        asked.save(img_dir / f"{cid}-q.jpg", "JPEG", quality=84, optimize=True)

        labels = []
        for it in items:
            r = it["label"]["r"]
            ok_tips = [[round(p[0], 1), round(p[1], 1)] for _, p in it["tips"]]
            if not ok_tips:
                stats["подпись без стрелки"] += 1
            labels.append({
                "text": it["label"]["t"],
                "box": [round((r.x0 - clip.x0) * SCALE), round((r.y0 - clip.y0) * SCALE),
                        round((r.x1 - clip.x0) * SCALE), round((r.y1 - clip.y0) * SCALE)],
                "bubble": [round((it["bubble"].x0 - clip.x0) * SCALE), round((it["bubble"].y0 - clip.y0) * SCALE),
                           round((it["bubble"].x1 - clip.x0) * SCALE), round((it["bubble"].y1 - clip.y0) * SCALE)],
                "tips": [[round((p[0] - clip.x0) * SCALE, 1), round((p[1] - clip.y0) * SCALE, 1)]
                         for p in (t for _, t in it["tips"])],
            })
        cards.append({
            "id": cid,
            "groupId": gid,
            "title": meta[gid]["title"],
            "number": meta[gid]["number"],
            "stain": meta[gid]["stain"],
            "slide": SLIDE_OFFSET[tag] + pn,
            "w": asked.width,
            "h": asked.height,
            "labels": labels,
        })
        stats["страниц"] += 1

    data = {
        "version": 1,
        "scale": SCALE,
        "cards": cards,
    }
    dest = out / "js" / "data" / "structures.js"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        "/* Сгенерировано scripts/build_structures.py. Не редактировать вручную. */\n"
        "window.HISTO_STRUCTURES = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "снимков": len(cards),
        "препаратов": len({c["groupId"] for c in cards}),
        "подписей": sum(len(c["labels"]) for c in cards),
        "со стрелками": sum(1 for c in cards for l in c["labels"] if l["tips"]),
        "стрелок": sum(len(l["tips"]) for c in cards for l in c["labels"]),
        **dict(stats),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
