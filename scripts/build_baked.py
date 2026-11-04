#!/usr/bin/env python3
"""Режим «Структуры» для снимков, где подписи запечены в растр.

На части слайдов подписи нарисованы прямо на картинке: векторного текста
нет, поэтому build_structures.py такие страницы пропускает. Здесь мы
разбираем сам растр:

1. находим плашки подписей — белые прямоугольники с тёмным текстом;
2. готовим два кадра: вопрос (текст в плашках залит, на его месте номер)
   и ответ (подписи как есть);
3. названия структур берём из scripts/baked_labels.json.

Почему названия из файла, а не с картинки: в песочнице нет OCR для
кириллицы (ни tesseract, ни модели для onnxruntime скачать нельзя).
Названия вписываются руками по кропам, порядок — сверху вниз, слева
направо. Страницы без записи в этом файле пропускаются: покрытие можно
наращивать постепенно.

Кончики стрелок НЕ вычисляются. На растре «самая дальняя точка белой
компоненты» попадает то на хвост выноски, то на соседнюю стрелку, а
проверить глазами каждую плашку на 400+ страницах невозможно. Номер
ставится на саму плашку, стрелка остаётся видимой — так снимок не врёт.

Запуск:
    python3 scripts/build_baked.py --pdf-dir /tmp/arena-coding-uploads
    python3 scripts/build_baked.py --pdf-dir /tmp/arena-coding-uploads --only 0113-010
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
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_assets import GROUPS, PDF_FILES, TAGS  # noqa: E402
import build_structures as bs  # noqa: E402

CURATION = ROOT / "scripts" / "baked_labels.json"
OUT_JS = ROOT / "js" / "data" / "baked.js"
IMG_DIR = ROOT / "assets" / "baked"
SCALE = 1.7          # во сколько раз увеличиваем кадр для показа
MIN_SIDE = 200       # картинки меньше этого — не препарат
MARK = (30, 90, 200)  # цвет номера структуры на кадре-вопросе


# ---------------------------------------------------------------- растр

def _fill(m: np.ndarray) -> np.ndarray:
    """Залить дыры (буквы) внутри бинарной маски."""
    h, w = m.shape
    ff = m.copy()
    mask = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(ff, mask, (0, 0), 1)
    return (m | (1 - ff)).astype(np.uint8)


def _ring_light(a: np.ndarray, box, pad: int) -> float:
    """Доля светлого в кайме вокруг прямоугольника."""
    h, w = a.shape[:2]
    x0, y0, x1, y1 = [int(v) for v in box]
    X0, Y0 = max(0, x0 - pad), max(0, y0 - pad)
    X1, Y1 = min(w, x1 + pad), min(h, y1 + pad)
    sub = a[Y0:Y1, X0:X1]
    m = np.ones(sub.shape[:2], bool)
    m[(y0 - Y0):(y1 - Y0), (x0 - X0):(x1 - X0)] = False
    if not m.any():
        return 1.0
    mx, mn = sub.max(2), sub.min(2)
    return float(((mx > 195) & ((mx - mn) < 70))[m].mean())


def header_plate(img: Image.Image):
    """Кремовая плашка шапки «Препарат №… / Окраска: …».

    Векторного текста в таких слайдах нет — шапка тоже запечена в растр.
    Ищем крупный светлый прямоугольник в верхней трети картинки, внутри
    которого есть тёмные буквы.

    Важно: сюда попадают далеко не все шапки (бывают серые, бывают
    сросшиеся с рамкой снимка). Если шапка не найдена, снимок в каталог не
    идёт — см. require_head в main.
    """
    a = np.asarray(img.convert("RGB")).astype(np.int16)
    h, w = a.shape[:2]
    light = ((a[:, :, 0] > 225) & (a[:, :, 1] > 215) & (a[:, :, 2] > 195)
             & (a[:, :, 0] >= a[:, :, 2])).astype(np.uint8)
    n, _lab, stats, _ = cv2.connectedComponentsWithStats(light, 8)
    best = None
    for i in range(1, n):
        x, y, cw, ch, area = [int(v) for v in stats[i]]
        if cw < 0.45 * w or ch < 0.03 * h or y > 0.35 * h:
            continue
        if area < 0.6 * cw * ch:
            continue
        sub = a[y:y + ch, x:x + cw]
        dark = ((sub.max(2) < 130)).sum()
        if dark < 0.004 * cw * ch:
            continue                       # пустое поле, а не шапка с текстом
        if best is None or area > best[4]:
            best = (x, y, cw, ch, area)
    if best is None:
        return None
    x, y, cw, ch, _ = best
    return (x, y, x + cw, y + ch)


def _boxes_from_core(core: np.ndarray, kx: int, ky: int):
    """Прямоугольные куски, «прошедшие» ядром kx×ky."""
    n, _lab, st, _ = cv2.connectedComponentsWithStats(core, 8)
    out = []
    for i in range(1, n):
        x, y, w, h = [int(v) for v in st[i][:4]]
        out.append((x, y, x + w, y + h))
    return out


def plates_and_tips(img: Image.Image) -> list[dict]:
    """Плашки подписей на картинке-растре.

    Признак плашки: белая заливка с ровными краями и тёмный текст внутри.
    Прямоугольность проверяем эрозией ядром: от прямоугольника остаётся
    прямоугольник, от хвоста-выноски — ничего. Поле страницы отсекаем по
    тому, что его ядро совпадает с целой компонентой.
    """
    a = np.asarray(img.convert("RGB")).astype(np.int16)
    h, w = a.shape[:2]
    S = max(1.0, max(h, w) / 700.0)

    mx, mn = a.max(2), a.min(2)
    white = ((mx > 205) & ((mx - mn) < 60)).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(white, 8)

    kx = max(5, int(round(S * 14)))
    ky = max(4, int(round(S * 9)))

    cands = []
    for i in range(1, n):
        x, y, cw, ch, area = [int(v) for v in stats[i]]
        if cw < S * 30 or ch < S * 12:
            continue
        pad = max(kx, ky) + 2
        X0, Y0 = max(0, x - pad), max(0, y - pad)
        X1, Y1 = min(w, x + cw + pad), min(h, y + ch + pad)
        m = (lab[Y0:Y1, X0:X1] == i).astype(np.uint8)
        m = _fill(m)
        core = cv2.erode(m, cv2.getStructuringElement(cv2.MORPH_RECT, (kx, ky)))
        if not core.any():
            continue
        cores = _boxes_from_core(core, kx, ky)
        # поле страницы: ядро того же размера, что и вся компонента
        if any((r[2] - r[0]) >= 0.92 * cw and (r[3] - r[1]) >= 0.92 * ch
               for r in cores):
            continue

        cores.sort(key=lambda r: (r[1], r[0]))
        boxes = []
        for r in cores:
            for B in boxes:
                same_x = abs(r[0] - B[0]) < S * 12 and abs(r[2] - B[2]) < S * 12
                gap = max(0, max(B[1], r[1]) - min(B[3], r[3]))
                if same_x and gap < S * 6:
                    B[0] = min(B[0], r[0]); B[1] = min(B[1], r[1])
                    B[2] = max(B[2], r[2]); B[3] = max(B[3], r[3])
                    break
            else:
                boxes.append(list(r))

        for bx0, by0, bx1, by1 in boxes:
            pad_x = kx // 2 + int(S * 2)
            pad_y = ky // 2 + int(S * 2)
            x0 = max(X0, bx0 + X0 - pad_x); x1 = min(X1, bx1 + X0 + pad_x)
            y0 = max(Y0, by0 + Y0 - pad_y); y1 = min(Y1, by1 + Y0 + pad_y)
            x0 = max(0, x0); y0 = max(0, y0); x1 = min(w, x1); y1 = min(h, y1)
            if x1 - x0 < S * 30 or y1 - y0 < S * 12:
                continue
            sub = a[y0:y1, x0:x1]
            if sub.size == 0:
                continue
            mx2, mn2 = sub.max(2), sub.min(2)
            light_in = float(((mx2 > 185) & ((mx2 - mn2) < 80)).mean())
            framed = _framed(a, (x0, y0, x1, y1), S)
            # Внутри плашки всегда светлая заливка (текст занимает 13–25 %).
            # Замкнутая «рамка» без светлого внутри — это белая стрелка,
            # упёршаяся кончиком в тёмный край: не подпись.
            if light_in < 0.52:
                continue
            # Белый овал в препарате (пузырёк, просвет сосуда) тоже светлый
            # внутри, но он закруглённый: ядро эрозии оставляет от него
            # пятно, которое не доходит до краёв рамки. Требуем, чтобы
            # ядро занимало заметную долю найденной рамки.
            if (bx1 - bx0) * (by1 - by0) < 0.30 * (x1 - x0) * (y1 - y0):
                continue
            dark = float((mx2 < 150).mean())
            # текст в плашке занимает 13–25 % площади; меньше 6 % — кусок линии
            if dark < 0.06:
                continue
            # Вокруг плашки почти всегда белое поле страницы. Если его нет и
            # рамка не замкнута — это, скорее всего, кусок снимка. Плашки на
            # светлой ткани (лёгкое, гипофиз) иногда теряются: тогда в
            # карточке будет пометка «покрытие неполное», а не ложная подпись.
            if not framed and \
               _ring_light(a, (x0, y0, x1, y1), int(max(3, S * 4))) < 0.30:
                continue
            # Две подписи подряд — это строки, разнесённые на целую строку
            # (≈18S). Внутри одной плашки строки идут плотно, поэтому
            # маленький зазор их не разделяет.
            for part in _split_stacked(a, (x0, y0, x1, y1), S, min_gap=S * 14):
                cands.append(list(part))

    # слить пересекающиеся рамки: оставляем самую крупную
    cands.sort(key=lambda r: (-(r[2] - r[0]) * (r[3] - r[1])))
    out = []
    for r in cands:
        for B in out:
            ix = min(r[2], B[2]) - max(r[0], B[0])
            iy = min(r[3], B[3]) - max(r[1], B[1])
            if ix > 0.6 * min(r[2] - r[0], B[2] - B[0]) and \
               iy > 0.6 * min(r[3] - r[1], B[3] - B[1]):
                break
        else:
            out.append(r)

    # Плашка не бывает у самого края кадра: у края — хвост выноски, которую
    # кадр обрезал, и его «рамка» замкнута краем изображения.
    edge = 2
    out = [r for r in out
           if not (r[0] <= edge or r[1] <= edge
                   or r[2] >= w - edge or r[3] >= h - edge)]

    # шапка препарата — не структура: она только закрашивается в вопросе
    head = header_plate(img)
    if head:
        out = [r for r in out
               if not (r[0] >= head[0] - 4 and r[2] <= head[2] + 4
                       and r[1] >= head[1] - 4 and r[3] <= head[3] + 4)]

    out = _merge_boxes(a, out, S)
    out.sort(key=lambda r: (r[1] // max(1, int(S * 20)), r[0]))
    return [{"plate": list(r)} for r in out]


# ---------------------------------------------------------------- страницы

def head_visible(img: Image.Image) -> bool:
    """Похоже ли, что в кадре видна шапка «Препарат №…»?

    Если шапка есть, а find не смог её выделить, мы не имеем права отдавать
    такой снимок в режим «Структуры»: в вопросе останется название
    препарата. Это проверка «есть ли в верхней полосе плотная строка
    текста, не похожая на плашку подписи».
    """
    a = np.asarray(img.convert("RGB")).astype(np.int16)
    h, w = a.shape[:2]
    band = a[:int(0.12 * h), :]
    if band.size == 0:
        return False
    dark = band.min(2) < 130
    if dark.sum() < 0.004 * band[:, :, 0].size:
        return False
    # строка должна быть длинной и идти по горизонтали
    cols = np.where(dark.sum(0) > 0)[0]
    return bool(len(cols)) and (cols.max() - cols.min()) > 0.35 * w


def page_images(doc: pymupdf.Document, page: pymupdf.Page):
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

def _merge_boxes(a: np.ndarray, boxes, S: float):
    """Склеить рамки, если между ними нет тёмной линии-разделителя.

    Одна плашка с двумя строками может распасться на два ядра. Это не две
    подписи: между ними нет рамки, только белая заливка. Если же у каждой
    плашки есть своя рамка, между ними будет тёмная линия — тогда не склеиваем.
    """
    out = []
    for b in sorted(boxes, key=lambda r: (r[1], r[0])):
        if out:
            prev = out[-1]
            same_col = not (b[2] <= prev[0] or b[0] >= prev[2])
            # рамки могут перекрываться: верх второй плашки внутри первой
            gap = b[1] - prev[3] if b[1] > prev[3] else 0
            if same_col and gap <= max(3, S * 10):
                x0 = min(prev[0], b[0]); x1 = max(prev[2], b[2])
                ym = (prev[3] + b[1]) // 2
                strip = a[max(0, ym - 2):ym + 3, x0:x1]
                dark_strip = float((strip.max(2) < 150).mean()) if strip.size else 1.0
                # Верхний прямоугольник без текста — это пустая часть той же
                # плашки (высокая плашка распалась на два ядра). Настоящая
                # подпись без текста не бывает.
                upper = a[prev[1]:prev[3], prev[0]:prev[2]]
                upper_txt = float((upper.max(2) < 150).mean()) if upper.size else 0.0
                if dark_strip < 0.25 and (upper_txt < 0.02 or not upper.size):
                    out[-1] = (x0, prev[1], x1, b[3])   # рамки между ними нет
                    continue
        out.append(tuple(b))
    return out


def _has_outline(a: np.ndarray, box, S: float) -> bool:
    """Есть ли у прямоугольника тёмный контур хотя бы с двух сторон.

    Плашки подписей обведены чёрным. Белые просветы в препарате — нет: там
    край неровный и тёмного по всей стороне не наберётся. Двух сторон
    достаточно, потому что найденная граница заливки бывает шире плашки
    и нижняя/боковая рамка остаётся за пределами проверки.
    """
    h, w = a.shape[:2]
    x0, y0, x1, y1 = [int(v) for v in box]
    dark = a.max(2) < 195

    def frac(pts):
        vals = [dark[y, x] for y, x in pts if 0 <= y < h and 0 <= x < w]
        return float(np.mean(vals)) if vals else 0.0

    # рамка может лежать в 1–6 px от найденной границы заливки
    def band(xs, ys):
        best = 0.0
        for o in range(-2, 7):
            if xs is not None:
                best = max(best, frac([(y0 + o, x) for x in xs]) if o < 0 else
                           frac([(y1 + o, x) for x in xs]))
            else:
                best = max(best, frac([(y, x0 + o) for y in ys]) if o < 0 else
                           frac([(y, x1 + o) for y in ys]))
        return best

    xs = range(x0 + 3, x1 - 2)
    ys = range(y0 + 3, y1 - 2)
    sides = [band(xs, None), band(None, ys)]
    top = max(frac([(y0 - o, x) for x in xs]) for o in range(1, 7))
    bot = max(frac([(y1 + o, x) for x in xs]) for o in range(1, 7))
    lef = max(frac([(y, x0 - o) for y in ys]) for o in range(1, 7))
    rig = max(frac([(y, x1 + o) for y in ys]) for o in range(1, 7))
    return sum(1 for v in (top, bot, lef, rig) if v > 0.45) >= 2


def _framed(a: np.ndarray, box, S: float) -> bool:
    """Замкнута ли плашка тёмной рамкой.

    Плашки в слайдах обведены чёрным контуром. Если снимок светлый (ткань
    почти белая), «светлое внутри» перестаёт отличать плашку от фона —
    тогда решает рамка. Проверяем, что вдоль каждой из четырёх сторон
    есть линия тёмного.
    """
    h, w = a.shape[:2]
    x0, y0, x1, y1 = [int(v) for v in box]
    dark = a.max(2) < 190

    def frac(pts):
        vals = [dark[y, x] for y, x in pts if 0 <= y < h and 0 <= x < w]
        return float(np.mean(vals)) if vals else 0.0

    for off in (1, 2, 3):
        top = frac([(y0 - off, x) for x in range(x0 + 3, x1 - 2)])
        bot = frac([(y1 + off, x) for x in range(x0 + 3, x1 - 2)])
        lef = frac([(y, x0 - off) for y in range(y0 + 3, y1 - 2)])
        rig = frac([(y, x1 + off) for y in range(y0 + 3, y1 - 2)])
        if min(top, bot, lef, rig) > 0.55:
            return True
    return False


def _split_stacked(a: np.ndarray, box, S: float, min_gap: float = 0):
    """Разделить слипшиеся плашки, стоящие одна под другой.

    На части слайдов облачка соседних подписей касаются рамками, и
    компонента белой заливки получается общая. Внутри такой компоненты
    строки текста всё равно разделены — по ним и режем.
    """
    x0, y0, x1, y1 = box
    sub = a[y0:y1, x0:x1]
    if sub.size == 0:
        return [box]
    dark = (sub.max(2) < 150)
    rows = dark.mean(1) > 0.05
    groups, start, gap = [], None, 0
    for k, v in enumerate(rows):
        if v:
            if start is None:
                start = k
            gap = 0
        elif start is not None:
            gap += 1
            if gap > max(3, S * 4, min_gap):
                groups.append((start, k - gap))
                start = None
    if start is not None:
        groups.append((start, len(rows) - 1))
    groups = [g for g in groups if (g[1] - g[0]) >= S * 5]
    if len(groups) < 2:
        return [box]
    out = []
    for k, (g0, g1) in enumerate(groups):
        top = y0 + max(0, g0 - int(S * 5))
        bot = y0 + min(y1 - y0, g1 + int(S * 5))
        if k > 0:
            top = max(top, out[-1][3])
        out.append((x0, top, x1, bot))
    out = [b for b in out if (b[3] - b[1]) >= S * 8]
    return out or [box]


def _mark_font(size: int):
    for name in ("DejaVuSans-Bold.ttf", "DejaVuSans.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def erasable_plates(img: Image.Image, plates: list[dict]):
    """Прямоугольники плашек для заливки белым.

    Найденная рамка плашки часто чуть меньше самой плашки (эрозия ядром
    съедает край), поэтому заливка «по рамке» оставляет обрезки букв и
    кусок стрелки. Расширяем прямоугольник до тёмного контура: идём наружу
    по каждой стороне, пока не упрёмся в тёмную линию.
    """
    a = np.asarray(img.convert("L")).astype(int)
    h, w = a.shape
    out = []
    for p in plates:
        x0, y0, x1, y1 = p["plate"]

        def scan(x, y, dx, dy, limit):
            """Дойти до тёмной рамки по направлению (dx, dy).

            Если рамки нет (вышли за кадр или упёрлись в светлое), возвращаем
            небольшой запас, а не весь предел: иначе заливка уезжает в препарат.
            """
            run = 0
            for k in range(1, limit):
                xx, yy = x + dx * k, y + dy * k
                if not (0 <= xx < w and 0 <= yy < h):
                    break
                if a[yy, xx] < 150:
                    return k + 2
                if a[yy, xx] > 200:
                    run = 0
                else:
                    run += 1
                    if run > 4:      # началась ткань — рамки нет
                        break
            return 3

        cx = (x0 + x1) // 2
        cy = (y0 + y1) // 2
        lim_x = max(6, (x1 - x0) // 2)
        lim_y = max(6, (y1 - y0) // 2)
        left = scan(x0, cy, -1, 0, lim_x)
        right = scan(x1, cy, 1, 0, lim_x)
        up = scan(cx, y0, 0, -1, lim_y)
        down = scan(cx, y1, 0, 1, lim_y)
        out.append((max(0, x0 - left), max(0, y0 - up),
                    min(w, x1 + right), min(h, y1 + down)))
    return out


def make_pair(img: Image.Image, plates: list[dict]):
    """Кадр-вопрос (номера вместо подписей) и кадр-ответ (подписи на месте).

    В вопросе текст подписи залит, на его место встаёт номер, а стрелка от
    плашки к структуре остаётся видимой: именно она показывает, о чём вопрос.
    Шапка «Препарат №…» в вопросе тоже закрашена — это готовая подсказка.
    """
    clean = img.copy()
    head = header_plate(img)
    if head:
        hx0, hy0, hx1, hy1 = head
        ImageDraw.Draw(clean).rectangle(
            (max(0, hx0 - 4), max(0, hy0 - 4),
             min(img.width, hx1 + 4), min(img.height, hy1 + 4)),
            fill=(255, 255, 255))

    question = clean.copy()
    d = ImageDraw.Draw(question)
    for x0, y0, x1, y1 in erasable_plates(clean, plates):
        d.rectangle([x0, y0, x1, y1], fill=(255, 255, 255))

    scale = SCALE * min(2.5, 900.0 / max(img.width, img.height))
    w, h = int(img.width * scale), int(img.height * scale)
    question = question.resize((w, h), Image.LANCZOS)
    answer = clean.resize((w, h), Image.LANCZOS)

    qd = ImageDraw.Draw(question)
    font = _mark_font(max(13, int(round(max(question.size) / 55))))
    for n, p in enumerate(plates, 1):
        x0, y0, x1, y1 = [v * scale for v in p["plate"]]
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        t = str(n)
        tw = qd.textlength(t, font=font)
        th = getattr(font, "size", 16)
        if (x1 - x0) < tw + 6 or (y1 - y0) < th + 4:
            cx, cy = x1 + tw / 2 + 3, max(th, y0 - th / 2 - 3)
        qd.text((cx - tw / 2, cy - th * 0.62), t, font=font, fill=MARK)
    return question, answer, scale


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf-dir", required=True)
    ap.add_argument("--only", default="",
                    help="страницы через запятую: 0113-010,0221-016")
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
    docs = {}
    for tag, name in zip(TAGS, PDF_FILES):
        path = pdf_dir / name
        if path.exists():
            docs[tag] = pymupdf.open(path)

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
            stats["без снимка"] += 1
            continue
        # страницы с векторными подписями уже разбирает build_structures.py
        if [l for l in bs.group_lines(bs.raw_lines(page)) if bs.usable_label(l["t"])]:
            continue

        items = page_images(doc, page)
        if not items:
            stats["без картинок"] += 1
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

        # Без найденной шапки в кадре-вопросе останется «Препарат №107
        # «Стенка сердца»» — готовая подсказка. Такие снимки в каталог не
        # берём: лучше меньше карточек, но без выданных ответов.
        if header_plate(img) is None:
            stats["шапка не найдена"] += 1
            print(f"  ? {cid}: шапка препарата не найдена — пропуск")
            continue

        question, answer, scale = make_pair(img, plates)
        question.save(IMG_DIR / f"{cid}-q.jpg", "JPEG", quality=85, optimize=True)
        answer.save(IMG_DIR / f"{cid}-a.jpg", "JPEG", quality=85, optimize=True)

        if len(plates) < 3:
            # Одна-две плашки на слайде — почти наверняка не всё: часть
            # подписей лежит на светлой ткани и сливается с ней. Честнее
            # сказать об этом, чем показывать неполный набор как полный.
            stats["мало плашек"] += 1
            print(f"  ~ {cid}: найдено всего {len(plates)} плашек — покрытие неполное")

        labels = []
        for name, p in zip(names, plates):
            x0, y0, x1, y1 = p["plate"]
            labels.append({
                "text": name,
                "box": [round(x0 * scale), round(y0 * scale),
                        round(x1 * scale), round(y1 * scale)],
                # кончик не выдумываем: номер стоит на самой плашке
                "tips": [],
            })
        cards.append({
            "id": cid, "groupId": gid, "title": title, "number": number,
            "stain": stain, "slide": pn,
            "w": answer.width, "h": answer.height, "labels": labels,
        })
        stats["карточек"] += 1

    data = {"version": 1, "baked": True, "cards": cards}
    OUT_JS.write_text(
        "/* Сгенерировано scripts/build_baked.py. Не редактировать вручную. */\n"
        "window.HISTO_BAKED = " + json.dumps(data, ensure_ascii=False) + ";\n",
        encoding="utf-8")
    print(json.dumps(dict(stats), ensure_ascii=False, indent=2))
    print("карточек:", len(cards), "| подписей:",
          sum(len(c["labels"]) for c in cards))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
