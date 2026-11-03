#!/usr/bin/env python3
"""Собирает изображения и данные тренажёра из трёх PDF с гистологическими препаратами.

Запуск:
    python3 scripts/build_assets.py --pdf-dir /path/to/pdfs

Зависимости: pymupdf, pillow, numpy, opencv-python-headless.
Результат: assets/prep/*.jpg, assets/reveal/*.jpg, js/data/preparations.js.

Исходные PDF в репозиторий не кладём: готовые изображения уже включены,
а скрипт нужен только для пересборки датасета.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
import pymupdf
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PDF_FILES = [
    "Гистология_0113-0220-сжатый.pdf",
    "Гистология_0221-0330-сжатый.pdf",
    "Гистология_0331-0426-сжатый.pdf",
]
TAGS = ["0113", "0221", "0331"]
SLIDE_OFFSET = {"0113": 112, "0221": 220, "0331": 330}

SYSTEMS = [
    ("nervous", "Нервная система", "#7c6cf6"),
    ("sense", "Органы чувств", "#e0799c"),
    ("cardio", "Сердечно-сосудистая система", "#e05656"),
    ("endocrine", "Эндокринная система", "#d99327"),
    ("immune", "Кроветворение и иммунная система", "#3aa98a"),
    ("digestive", "Пищеварительная система", "#4a8fd8"),
    ("respiratory", "Дыхательная система", "#3f9ec4"),
    ("urinary", "Мочевыделительная система", "#8b6cd9"),
    ("reproductive", "Половая система", "#d368b0"),
    ("skin", "Кожа и её придатки", "#b98a55"),
    ("tooth", "Развитие зуба", "#5b8f6f"),
    ("embryo", "Плацента и эмбриональные ткани", "#a070c9"),
]

# id, название, номер, окраска, система, диапазоны (tag, первая страница, последняя страница)
GROUPS = [
    ("cerebellum_silver", "Мозжечок (импрегнация солями серебра)", "91", "Импрегнация солями серебра", "nervous", [("0113", 1, 4)]),
    ("cerebellum_he", "Мозжечок (гематоксилин-эозин)", "90", "Гематоксилин — эозин", "nervous", [("0113", 5, 8)]),
    ("neocortex", "Кора большого мозга (неокортекс)", "92", "Импрегнация солями серебра", "nervous", [("0113", 9, 12)]),
    ("cornea", "Роговица глаза", "93", "Гематоксилин — эозин", "sense", [("0113", 13, 15)]),
    ("retina", "Задняя стенка глаза (сетчатка)", "95", "Гематоксилин — эозин", "sense", [("0113", 16, 20)]),
    ("cochlea", "Улитка внутреннего уха (кортиев орган)", "96", "Гематоксилин — эозин", "sense", [("0113", 21, 26)]),
    ("microvessels", "Артериолы, венулы и капилляры мягкой мозговой оболочки", "", "Гематоксилин — эозин", "cardio", [("0113", 27, 32)]),
    ("neurovascular", "Сосудисто-нервный пучок", "102", "Гематоксилин — эозин", "cardio", [("0113", 33, 36)]),
    ("aorta", "Аорта", "", "Гематоксилин — эозин", "cardio", [("0113", 37, 39)]),
    ("heart", "Стенка сердца", "107", "Гематоксилин — эозин", "cardio", [("0113", 40, 48)]),
    ("purkinje", "Волокна Пуркинье (стенка сердца)", "107а", "Гематоксилин — эозин", "cardio", [("0113", 49, 50)]),
    ("pituitary", "Гипофиз", "109", "Гематоксилин — эозин", "endocrine", [("0113", 51, 59)]),
    ("thyroid", "Щитовидная железа", "110 / 110а", "Гематоксилин — эозин", "endocrine", [("0113", 60, 64)]),
    ("parathyroid", "Паращитовидная железа", "111", "Гематоксилин — эозин", "endocrine", [("0113", 65, 70)]),
    ("adrenal", "Надпочечник", "112", "Гематоксилин — эозин", "endocrine", [("0113", 71, 75)]),
    ("bone_marrow", "Красный костный мозг (мазок)", "115", "Гематоксилин — эозин", "immune", [("0113", 76, 79)]),
    ("thymus", "Тимус", "", "Гематоксилин — эозин", "immune", [("0113", 80, 89)]),
    ("lymph_node", "Лимфатический узел", "", "Гематоксилин — эозин", "immune", [("0113", 90, 100)]),
    ("spleen", "Селезёнка", "119", "Гематоксилин — эозин", "immune", [("0113", 101, 108), ("0221", 1, 4)]),
    ("tonsil", "Нёбная миндалина", "125", "Гематоксилин — эозин", "immune", [("0221", 5, 8)]),
    ("tongue_tip", "Срез кончика языка (кошки)", "", "Гематоксилин — эозин", "digestive", [("0221", 9, 11)]),
    ("tongue_foliate", "Язык: листовидные сосочки (кролика)", "", "Гематоксилин — эозин", "digestive", [("0221", 12, 13)]),
    ("esophagus", "Пищевод (поперечный срез верхней трети)", "124", "Гематоксилин — эозин", "digestive", [("0221", 14, 18)]),
    ("stomach_fundus", "Фундальный отдел желудка (дно)", "", "Конгорот — железный гематоксилин", "digestive", [("0221", 19, 22)]),
    ("stomach_pylorus", "Пилорическая часть желудка", "", "Гематоксилин — эозин", "digestive", [("0221", 23, 26)]),
    ("duodenum", "12-перстная кишка", "130", "Гематоксилин — эозин", "digestive", [("0221", 27, 31)]),
    ("jejunum", "Тощая кишка", "131", "Гематоксилин — эозин", "digestive", [("0221", 32, 35)]),
    ("colon", "Толстая кишка", "132", "Гематоксилин — эозин", "digestive", [("0221", 36, 41)]),
    ("appendix", "Червеобразный отросток (аппендикс)", "", "Гематоксилин — эозин", "digestive", [("0221", 42, 44)]),
    ("parotid", "Околоушная слюнная железа", "", "Гематоксилин — эозин", "digestive", [("0221", 45, 47)]),
    ("submandibular", "Подчелюстная слюнная железа", "", "Гематоксилин — эозин", "digestive", [("0221", 48, 50)]),
    ("sublingual", "Подъязычная слюнная железа", "", "Гематоксилин — эозин", "digestive", [("0221", 51, 53)]),
    ("pancreas", "Поджелудочная железа", "", "Гематоксилин — эозин", "digestive", [("0221", 54, 59)]),
    ("liver_pig", "Печень свиньи", "", "Гематоксилин — пикрофуксин", "digestive", [("0221", 60, 64)]),
    ("liver_human", "Печень человека", "136", "Гематоксилин — эозин", "digestive", [("0221", 65, 69)]),
    ("trachea", "Трахея", "64", "Гематоксилин — эозин", "respiratory", [("0221", 70, 74)]),
    ("lung", "Лёгкое", "", "Гематоксилин — эозин", "respiratory", [("0221", 75, 86)]),
    ("skin_finger", "Кожа пальца", "", "Гематоксилин — эозин", "skin", [("0221", 87, 90)]),
    ("skin_hair", "Кожа с волосом", "", "Гематоксилин — эозин", "skin", [("0221", 91, 94)]),
    ("kidney_rat", "Почка крысы", "146 / 146в", "Гематоксилин — эозин", "urinary", [("0221", 95, 110), ("0331", 1, 12)]),
    ("kidney_mallory", "Почка (окраска по Маллори)", "146", "По Маллори", "urinary", [("0331", 13, 25)]),
    ("bladder", "Мочевой пузырь", "147", "Гематоксилин — эозин", "urinary", [("0331", 26, 30)]),
    ("testis", "Семенник (яичко)", "149", "Гематоксилин — эозин", "reproductive", [("0331", 31, 36)]),
    ("epididymis", "Придаток семенника", "150", "Гематоксилин — эозин", "reproductive", [("0331", 37, 40)]),
    ("prostate", "Предстательная железа", "151", "Гематоксилин — эозин", "reproductive", [("0331", 41, 44)]),
    ("ovary", "Яичник (срез яичника кошки)", "152", "Гематоксилин — эозин", "reproductive", [("0331", 45, 48)]),
    ("corpus_luteum", "Жёлтое тело яичника", "153", "Гематоксилин — эозин", "reproductive", [("0331", 49, 52)]),
    ("uterus", "Матка (поперечный срез)", "154", "Гематоксилин — эозин", "reproductive", [("0331", 53, 57)]),
    ("mammary", "Лактирующая молочная железа", "157", "Гематоксилин — эозин", "reproductive", [("0331", 58, 61)]),
    ("placenta", "Плацента (плодная и материнская части)", "158 / 159", "Гематоксилин — эозин", "embryo", [("0331", 62, 68)]),
    ("pineal", "Эпифиз (шишковидное тело)", "", "Гематоксилин — эозин", "endocrine", [("0331", 69, 70)]),
    ("tooth_early", "Ранняя стадия развития зуба (эмалевый орган)", "", "Гематоксилин — эозин", "tooth", [("0331", 71, 72)]),
    ("tooth_late", "Поздняя стадия развития зуба (гистогенез)", "", "Гематоксилин — эозин", "tooth", [("0331", 73, 75)]),
    ("esoph_gastric", "Переход пищевода в желудок", "127", "Гематоксилин — эозин", "digestive", [("0331", 76, 80)]),
    ("gallbladder", "Желчный пузырь", "140", "Гематоксилин — эозин", "digestive", [("0331", 81, 84)]),
    ("ureter", "Мочеточник (поперечный срез)", "148", "Гематоксилин — эозин", "urinary", [("0331", 85, 88)]),
    ("oviduct", "Яйцевод (маточная труба)", "155", "Гематоксилин — эозин", "reproductive", [("0331", 89, 93)]),
    ("gastroduodenal", "Переход желудка в 12-перстную кишку", "129а", "Гематоксилин — эозин", "digestive", [("0331", 94, 96)]),
]

# Ручная классификация слайдов с одним растровым объектом и без векторного текста.
CLEAN_SINGLE = {
    ("0221", 18), ("0221", 63), ("0221", 78), ("0221", 80), ("0221", 82),
    ("0221", 98), ("0221", 100), ("0221", 102), ("0221", 104), ("0221", 106), ("0221", 110),
    ("0331", 2), ("0331", 4), ("0331", 6), ("0331", 8), ("0331", 10), ("0331", 12),
    ("0331", 14), ("0331", 16), ("0331", 18), ("0331", 22), ("0331", 25), ("0331", 29),
    ("0331", 77), ("0331", 79),
}
HEADER_SINGLE = {("0113", 20), ("0113", 23), ("0113", 64), ("0221", 37)}
SKIP_SINGLE = {
    ("0113", 15), ("0113", 31), ("0113", 32), ("0113", 53), ("0113", 54),
    ("0221", 8), ("0221", 77),
    ("0331", 86),
}
# Слайды-схемы с двумя объектами: в тренажёр не берём.
SKIP_PAIRS = {("0221", 10), ("0221", 52)}

GROUP_BY_PAGE: dict[tuple[str, int], str] = {}
for gid, *_rest, ranges in GROUPS:
    for tag, a, b in ranges:
        for pn in range(a, b + 1):
            GROUP_BY_PAGE[(tag, pn)] = gid


def pixmap_to_rgb(doc: pymupdf.Document, xref: int) -> np.ndarray:
    pix = pymupdf.Pixmap(doc, xref)
    if pix.n > 4 or (pix.colorspace and pix.colorspace.n != 3):
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    mode = "RGBA" if pix.alpha else "RGB"
    im = Image.frombytes(mode, (pix.width, pix.height), pix.samples).convert("RGB")
    return np.array(im)


def dhash(arr: np.ndarray, size: int = 16) -> int:
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    small = cv2.resize(gray, (size + 1, size), interpolation=cv2.INTER_AREA)
    bits = (small[:, 1:] > small[:, :-1]).flatten()
    return int("".join("1" if b else "0" for b in bits), 2)


def ham(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def caption_score(rgb: np.ndarray) -> float:
    """Эвристика: сколько «типографской» графики (рамок, текста, стрелок) в кадре."""
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    ch = rgb.astype(np.int16)
    spread = ch.max(2) - ch.min(2)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    ink = ((gray < 110) & (spread < 55)).astype(np.uint8) * 255
    cnts, _ = cv2.findContours(ink, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    rects = 0
    for c in cnts:
        area = cv2.contourArea(c)
        x, y, w, h = cv2.boundingRect(c)
        if area < 150 or w < 30 or h < 12 or not 0.9 < w / h < 10:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.08 * peri, True)
        if 4 <= len(approx) <= 8 and area / (w * h) > 0.25:
            rects += 1
    n, _, stats, _ = cv2.connectedComponentsWithStats((ink > 0).astype(np.uint8), 8)
    blobs = sum(1 for i in range(1, n) if 8 < stats[i, 4] < 2000)
    edges = cv2.Canny(ink, 50, 150)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=22, minLineLength=45, maxLineGap=5)
    axis = 0
    if lines is not None:
        for l in lines.reshape(-1, 4):
            x1, y1, x2, y2 = map(int, l)
            ang = abs(math.degrees(math.atan2(y2 - y1, x2 - x1)))
            if math.hypot(x2 - x1, y2 - y1) > 50 and (ang < 8 or ang > 172 or 82 < ang < 98):
                axis += 1
    return rects * 3 + blobs * 0.02 + axis * 0.4 + float((ink > 0).mean()) * 30


def detect_captions(rgb: np.ndarray):
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    ch = rgb.astype(np.int16)
    spread = ch.max(2) - ch.min(2)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    ink = ((gray < 130) & (spread < 70)).astype(np.uint8) * 255
    light = ((gray > 170) & (spread < 90)).astype(np.uint8) * 255
    H, W = gray.shape
    rects: list[tuple[int, int, int, int]] = []

    cnts, _ = cv2.findContours(ink, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for c in cnts:
        area = cv2.contourArea(c)
        x, y, w, h = cv2.boundingRect(c)
        if area < 180 or w < 30 or h < 12 or not 0.9 < w / h < 12:
            continue
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.10 * peri, True)
        if 4 <= len(approx) <= 8 and area / (w * h) > 0.18:
            rects.append((x, y, w, h))

    n, _, stats, _ = cv2.connectedComponentsWithStats(light, 8)
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < 220 or w < 35 or h < 12 or not 0.9 < w / h < 14:
            continue
        if area / (w * h) < 0.5 or area > 0.35 * W * H:
            continue
        pad = 5
        x0, y0 = max(0, x - pad), max(0, y - pad)
        x1, y1 = min(W, x + w + pad), min(H, y + h + pad)
        ring = ink[y0:y1, x0:x1].copy()
        ring[max(0, y - y0):min(ring.shape[0], y + h - y0),
             max(0, x - x0):min(ring.shape[1], x + w - x0)] = 0
        inside = (ink[y:y + h, x:x + w] > 0).mean()
        if ring.mean() > 2.0 or inside > 0.0015:
            rects.append((x, y, w, h))

    # Заголовок в верхней полосе: просто обрежем его целиком.
    top = ink[: int(H * 0.18), :]
    ys, xs = np.where(top > 0)
    header = 0
    if len(xs) > 20 and len(xs) / top.size > 0.0004:
        y2 = min(H, int(ys.max() + 10))
        if y2 < H * 0.25:
            header = y2

    rects = [q for q in rects if q[2] * q[3] <= 0.30 * W * H]
    merged: list[tuple[int, int, int, int]] = []
    for x, y, w, h in sorted(rects, key=lambda q: q[0] * q[1]):
        placed = False
        for j, (X, Y, W2, H2) in enumerate(merged):
            ix = max(0, min(x + w, X + W2) - max(x, X))
            iy = max(0, min(y + h, Y + H2) - max(y, Y))
            union = (min(x, X), min(y, Y),
                     max(x + w, X + W2) - min(x, X), max(y + h, Y + H2) - min(y, Y))
            if ix * iy > 0.55 * min(w * h, W2 * H2) and union[2] * union[3] <= 0.30 * W * H:
                merged[j] = union
                placed = True
                break
        if not placed:
            merged.append((x, y, w, h))

    line = ink.copy()
    edges = cv2.Canny(ink, 40, 120)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=18, minLineLength=35, maxLineGap=8)
    if lines is not None:
        for l in lines.reshape(-1, 4):
            x1, y1, x2, y2 = map(int, l)
            dx, dy = x2 - x1, y2 - y1
            ang = abs(math.degrees(math.atan2(dy, dx)))
            if math.hypot(dx, dy) > 40 and (ang < 15 or ang > 165 or 75 < ang < 105):
                cv2.line(line, (x1, y1), (x2, y2), 255, 4)
    return merged, header, cv2.dilate(line, np.ones((3, 3), np.uint8), iterations=1)


def tissue_score(patch: np.ndarray) -> float:
    hsv = cv2.cvtColor(patch, cv2.COLOR_RGB2HSV)
    sat, val = hsv[:, :, 1], hsv[:, :, 2]
    colored = ((sat > 28) & (val > 45) & (val < 248)).mean()
    white = ((val > 238) & (sat < 40)).mean()
    return float(colored - 1.5 * white)


def crop_header(rgb: np.ndarray) -> np.ndarray:
    """Убирает верхнюю полосу с названием препарата."""
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    sat, val = hsv[:, :, 1], hsv[:, :, 2]
    tissue = ((sat > 25) & (val > 40) & (val < 250)).mean(axis=1)
    limit = int(rgb.shape[0] * 0.22)
    for y in range(limit):
        if tissue[y] > 0.55:
            return rgb[max(0, y - 2):, :].copy()
    return rgb


def mask_captions(rgb: np.ndarray) -> np.ndarray:
    """Аккуратно и непрозрачно замазывает подписи тоном окружающей ткани.

    В маску попадают нейтрально-тёмный текст/рамки/стрелки и отдельные светлые элементы
    выносок. Заливка непрозрачная, поэтому подписи не проступают; большие светлые участки
    самой ткани не маскируются (ограничение по площади компоненты).
    """
    # Убираем белые поля слайда: к ним обычно приклеены выноски и «хвосты».
    hsv0 = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    tm = ((hsv0[:, :, 1] > 22) & (hsv0[:, :, 2] > 40) & (hsv0[:, :, 2] < 252)).astype(np.uint8)
    tm = cv2.morphologyEx(tm, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    ys, xs = np.where(tm > 0)
    if len(xs) > 500:
        x0, y0 = max(0, int(xs.min()) - 4), max(0, int(ys.min()) - 4)
        x1, y1 = min(rgb.shape[1], int(xs.max()) + 5), min(rgb.shape[0], int(ys.max()) + 5)
        if (x1 - x0) * (y1 - y0) < 0.93 * rgb.shape[0] * rgb.shape[1]:
            rgb = rgb[y0:y1, x0:x1].copy()

    H, W = rgb.shape[:2]
    rects, header, _line = detect_captions(rgb)
    if header > 0:
        rgb = rgb[header:, :].copy()
        H, W = rgb.shape[:2]
        rects = [(x, y - header, w, h) for x, y, w, h in rects]

    ch = rgb.astype(np.int16)
    spread = ch.max(2) - ch.min(2)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    ink = ((gray < 132) & (spread < 72)).astype(np.uint8) * 255
    light = ((gray > 168) & (spread < 92)).astype(np.uint8) * 255

    # Глобальный тон ткани для замазывания.
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    tp = rgb[(hsv[:, :, 1] > 25) & (hsv[:, :, 2] > 45) & (hsv[:, :, 2] < 250)]
    base = np.median(tp if len(tp) > 200 else rgb.reshape(-1, 3), axis=0).astype(np.float32)
    blurred = cv2.GaussianBlur(rgb, (0, 0), 12)
    fill = np.clip(blurred.astype(np.float32) * 0.5 + base * 0.5, 0, 255).astype(np.uint8)

    mask = ink.copy()
    n, labels, stats, _ = cv2.connectedComponentsWithStats(light, 8)
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if 140 <= area <= 18000 and 0.2 < w / h < 8 and w > 12 and h > 8:
            sub = mask[y:y + h, x:x + w]
            sub[labels[y:y + h, x:x + w] == i] = 255
    # Рамки, найденные детектором, добавляем целиком.
    for x, y, w, h in rects:
        cv2.rectangle(mask, (max(0, x - 4), max(0, y - 4)),
                      (min(W - 1, x + w + 4), min(H - 1, y + h + 4)), 255, -1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=1)

    out = rgb.copy()
    out[mask > 0] = fill[mask > 0]
    # Мягкий переход по краю замазанной области.
    edge = cv2.GaussianBlur(mask, (0, 0), 2).astype(np.float32) / 255.0
    soft = cv2.GaussianBlur(out, (0, 0), 2)
    a = np.clip(edge * 0.45, 0, 1)[..., None]
    return (out.astype(np.float32) * (1 - a) + soft.astype(np.float32) * a).astype(np.uint8)


def save_jpg(arr: np.ndarray, path: Path, max_side: int = 1100, quality: int = 83) -> None:
    im = Image.fromarray(arr)
    im.thumbnail((max_side, max_side), Image.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "JPEG", quality=quality, optimize=True, progressive=True)


def render_reveal(page: pymupdf.Page, path: Path) -> bool:
    pix = page.get_pixmap(matrix=pymupdf.Matrix(1.4, 1.4), alpha=False)
    arr = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3)
    rgb = cv2.cvtColor(arr, cv2.COLOR_BGR2RGB) if False else arr[:, :, ::-1].copy()
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    ys, xs = np.where(gray < 244)
    if len(xs) < 100:
        return False
    m = 14
    x0, y0 = max(0, int(xs.min()) - m), max(0, int(ys.min()) - m)
    x1, y1 = min(rgb.shape[1], int(xs.max()) + m), min(rgb.shape[0], int(ys.max()) + m)
    crop = rgb[y0:y1, x0:x1]
    save_jpg(crop, path, max_side=1250, quality=80)
    return True


def stitch_strips(doc: pymupdf.Document, entries) -> np.ndarray | None:
    """Склеивает нарезанные полосы фонового фото (подписи поверх них — векторные)."""
    usable = []
    for item in entries:
        xref, w, h, rects = item
        if w < 300 or h < 20 or not rects:
            continue
        usable.append((rects[0][1], xref, rects[0]))
    usable.sort(key=lambda t: t[0])
    if len(usable) < 3:
        return None
    imgs = [pixmap_to_rgb(doc, xref) for _, xref, _ in usable]
    widths = {im.shape[1] for im in imgs}
    if len(widths) != 1:
        return None
    return np.concatenate(imgs, axis=0)


def clean_text_snippet(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"^\d+\.\s*", "", text)
    text = re.sub(r"^Общая характеристика:\s*", "", text, flags=re.I)
    return text[:230].rstrip(" ,;:") + ("…" if len(text) > 230 else "")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf-dir", default="/tmp/arena-coding-uploads", help="Папка с тремя исходными PDF")
    ap.add_argument("--out", default=str(ROOT), help="Корень проекта")
    args = ap.parse_args()
    pdf_dir = Path(args.pdf_dir)
    out = Path(args.out)
    for name in PDF_FILES:
        if not (pdf_dir / name).exists():
            print(f"Не найден PDF: {pdf_dir / name}", file=sys.stderr)
            return 1

    docs = {tag: pymupdf.open(pdf_dir / name) for tag, name in zip(TAGS, PDF_FILES)}
    pages: dict[tuple[str, int], dict] = {}
    for tag, doc in docs.items():
        for i, page in enumerate(doc):
            pn = i + 1
            entries = []
            for im in page.get_images(full=True):
                xref, w, h = im[0], im[2], im[3]
                try:
                    rects = [(round(r.x0), round(r.y0), round(r.x1), round(r.y1))
                             for r in page.get_image_rects(xref)]
                except Exception:
                    rects = []
                entries.append((xref, w, h, rects))
            pages[(tag, pn)] = {
                "page": page,
                "text": " ".join(page.get_text().split()),
                "imgs": entries,
            }

    # Подсказки: первая осмысленная текстовая страница группы.
    hints: dict[str, str] = {}
    for gid, title, number, stain, system, ranges in GROUPS:
        best = ""
        for tag, a, b in ranges:
            for pn in range(a, b + 1):
                info = pages.get((tag, pn))
                if not info or info["imgs"]:
                    continue
                t = info["text"]
                if len(t) > 80 and not re.match(r"^\d+\.\s*Препарат", t):
                    best = clean_text_snippet(t)
                    break
                if len(t) > 20 and not best:
                    best = clean_text_snippet(t)
            if best:
                break
        hints[gid] = best or f"Раздел: {dict((s[0], s[1]) for s in SYSTEMS)[system]}. Окраска: {stain}."

    prep_dir = out / "assets" / "prep"
    reveal_dir = out / "assets" / "reveal"
    for d in (prep_dir, reveal_dir):
        if d.exists():
            for f in d.glob("*.jpg"):
                f.unlink()
        d.mkdir(parents=True, exist_ok=True)

    cards: list[dict] = []
    seen_xref: set[tuple[str, int]] = set()
    hashes: dict[str, list[int]] = defaultdict(list)
    stats = defaultdict(int)

    def mask_ok(arr: np.ndarray) -> bool:
        g = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
        core = g[int(g.shape[0] * 0.12):int(g.shape[0] * 0.88),
                 int(g.shape[1] * 0.12):int(g.shape[1] * 0.88)]
        return float((core > 246).mean()) < 0.16

    def add_card(tag, pn, idx, rgb, gid, *, masked=False, has_labels=False, suffix=""):
        if masked and not mask_ok(rgb):
            stats["rejected"] += 1
            return
        h = dhash(rgb)
        for old in hashes[gid]:
            if ham(h, old) <= 8:
                stats["duplicate"] += 1
                return
        hashes[gid].append(h)
        cid = f"{tag}-{pn:03d}-{idx}{suffix}"
        clean_rel = f"assets/prep/{cid}.jpg"
        save_jpg(rgb, out / clean_rel)
        reveal_rel = None
        if has_labels:
            rp = reveal_dir / f"{cid}.jpg"
            if render_reveal(pages[(tag, pn)]["page"], rp):
                reveal_rel = f"assets/reveal/{cid}.jpg"
        cards.append({
            "id": cid,
            "groupId": gid,
            "clean": clean_rel,
            "reveal": reveal_rel,
            "masked": bool(masked),
            "source": f"Слайд {SLIDE_OFFSET[tag] + pn}",
            "page": pn,
            "pdf": tag,
        })
        stats["masked" if masked else "clean"] += 1

    for (tag, pn), info in sorted(pages.items()):
        gid = GROUP_BY_PAGE.get((tag, pn))
        if not gid:
            continue
        imgs, text = info["imgs"], info["text"]
        key = (tag, pn)
        if key in SKIP_PAIRS or (len(imgs) == 1 and not text and key in SKIP_SINGLE):
            stats["skip"] += 1
            continue
        doc = docs[tag]

        # 1. Нарезанные полосы + векторные подписи.
        if len(imgs) >= 3 and text:
            stitched = stitch_strips(doc, imgs)
            if stitched is not None:
                add_card(tag, pn, 0, stitched, gid, has_labels=True, suffix="-strip")
                continue

        # 2. Четыре объекта: берём самый большой базовый снимок.
        if len(imgs) == 4:
            base = max(imgs, key=lambda i: i[1] * i[2])
            xref_key = (tag, base[0])
            if xref_key not in seen_xref:
                seen_xref.add(xref_key)
                add_card(tag, pn, 0, pixmap_to_rgb(doc, base[0]), gid,
                         has_labels=bool(text), suffix="-base")
            continue

        # 3. Два растровых объекта: чистое фото + подписанное, либо два подписанных.
        if len(imgs) == 2:
            rgb0 = pixmap_to_rgb(doc, imgs[0][0])
            rgb1 = pixmap_to_rgb(doc, imgs[1][0])
            s0, s1 = caption_score(rgb0), caption_score(rgb1)
            if min(s0, s1) > 5:
                # Оба кадра подписаны — аккуратно замазываем подписи.
                for idx, rgb in enumerate((rgb0, rgb1)):
                    add_card(tag, pn, idx, mask_captions(rgb), gid,
                             masked=True, has_labels=True, suffix="-mask")
            else:
                clean_idx = 0 if s0 <= s1 else 1
                rgb = (rgb0, rgb1)[clean_idx]
                xref_key = (tag, imgs[clean_idx][0])
                if xref_key not in seen_xref:
                    seen_xref.add(xref_key)
                    add_card(tag, pn, clean_idx, rgb, gid, has_labels=True)
            continue

        # 4. Один объект.
        if len(imgs) == 1:
            xref = imgs[0][0]
            rgb = pixmap_to_rgb(doc, xref)
            xref_key = (tag, xref)
            if text:
                # Подписи — векторные, сам растр чистый.
                if xref_key not in seen_xref:
                    seen_xref.add(xref_key)
                    add_card(tag, pn, 0, rgb, gid, has_labels=True)
                continue
            if key in HEADER_SINGLE:
                add_card(tag, pn, 0, crop_header(rgb), gid, has_labels=False, suffix="-crop")
                continue
            if key in CLEAN_SINGLE:
                if xref_key not in seen_xref:
                    seen_xref.add(xref_key)
                    add_card(tag, pn, 0, rgb, gid, has_labels=False)
                continue
            # Остальное — подписанный кадр без чистой версии.
            add_card(tag, pn, 0, mask_captions(rgb), gid, masked=True, has_labels=True, suffix="-mask")
            continue
        # Страницы без изображений (текст) пропускаем.
        stats["text"] += 1

    groups_out = []
    for gid, title, number, stain, system, ranges in GROUPS:
        groups_out.append({
            "id": gid, "title": title, "number": number, "stain": stain,
            "system": system, "hint": hints[gid],
            "slides": [f"{SLIDE_OFFSET[tag] + a}–{SLIDE_OFFSET[tag] + b}" for tag, a, b in ranges],
        })

    data = {
        "version": 1,
        "generatedFrom": [f"Гистология_{'0113-0220' if t == '0113' else '0221-0330' if t == '0221' else '0331-0426'}-сжатый.pdf" for t in TAGS],
        "systems": [{"id": s[0], "title": s[1], "color": s[2]} for s in SYSTEMS],
        "groups": groups_out,
        "cards": cards,
    }
    dest = out / "js" / "data" / "preparations.js"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        "/* Сгенерировано scripts/build_assets.py. Не редактировать вручную. */\n"
        "window.HISTO_DATA = " + json.dumps(data, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "cards": len(cards),
        "groups": len(groups_out),
        "clean": stats["clean"],
        "masked": stats["masked"],
        "duplicates": stats["duplicate"],
        "skipped": stats["skip"],
        "textPages": stats["text"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
