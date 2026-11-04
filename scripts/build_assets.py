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

_OCR = None

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

# Препараты, для которых в PDF нет описания — только снимки с подписями-стрелками.
# Текст написан под то, что реально видно на срезах этой серии.
HINTS_MANUAL = {
    "cerebellum_he": (
        "Серое и белое вещество образуют извилины и борозды, покрытые мягкой мозговой "
        "оболочкой с сосудами. Кора построена из трёх слоёв: светлого молекулярного с "
        "редкими мелкими клетками, ганглионарного — из одного ряда крупных грушевидных "
        "нейронов, и самого тёмного зернистого слоя из плотно лежащих клеток-зёрен. "
        "В центре извилины видно белое вещество."
    ),
    "cerebellum_silver": (
        "Импрегнация солями серебра окрашивает нейроны целиком: на светлом фоне видны "
        "чёрные тела клеток с отходящими дендритами. Кора построена из трёх слоёв: светлого "
        "молекулярного с тонкими дендритами, ряда крупных грушевидных нейронов в "
        "ганглионарном слое и тёмного зернистого из клеток-зёрен. В глубине извилины — "
        "белое вещество; рядом лежит мягкая мозговая оболочка."
    ),
    "placenta": (
        "На снимке — ветвящиеся ворсины в материнской крови. Каждая покрыта трофобластом: "
        "снаружи симпластотрофобласт, под ним цитотрофобласт. Соединительная ткань внутри "
        "ворсины содержит фибробласты и макрофаги, рядом видны сосуды с эритроцитами "
        "зародыша."
    ),
    "thyroid": (
        "Орган покрыт соединительнотканной капсулой, от которой внутрь отходят трабекулы, "
        "делящие паренхиму на дольки. Основная структура — фолликулы: пузырьки разной "
        "величины, стенка которых образована одним слоем тироцитов, а просвет заполнен "
        "розовым коллоидом. Между фолликулами лежит рыхлая соединительная ткань с "
        "капиллярами и межфолликулярными клетками."
    ),
    "spleen": (
        "Орган покрыт соединительнотканной капсулой из плотной волокнистой ткани с "
        "примесью гладкомышечных клеток; от неё внутрь отходят трабекулы, образующие "
        "каркас. Паренхима — пульпа — делится на белую (лимфоидные фолликулы вокруг "
        "артерий) и красную, пронизанную синусоидами и тяжами клеток."
    ),
    "lymph_node": (
        "Орган покрыт соединительнотканной капсулой, от которой внутрь отходят трабекулы. "
        "Паренхима разделена на корковое вещество с лимфоидными фолликулами по периферии и "
        "мозговое — с мозговыми тяжами в центре. Между ними лежат синусы: щелевидные "
        "пространства, выстланные эндотелием, по которым течёт лимфа."
    ),
    "esoph_gastric": (
        "На срезе видна резкая граница между двумя отделами пищеварительного тракта — "
        "зубчатая линия. Со стороны пищевода слизистую выстилает многослойный плоский "
        "неороговевающий эпителий, образующий глубокие продольные складки; он окрашен "
        "эозином в розовый цвет. Со стороны желудка эпителий однослойный призматический "
        "железистый, с желудочными ямками и железами в собственной пластинке."
    ),
    "kidney_rat": (
        "Орган покрыт капсулой; паренхима разделена на корковое и мозговое вещество. "
        "В корковом веществе разбросаны почечные тельца: клубочек капилляров внутри "
        "двухслойной капсулы, рядом — проксимальные и дистальные извитые канальцы с "
        "кубическим эпителием, у проксимальных видна щёточная каёмка. В мозговом веществе "
        "тянутся прямые канальцы и собирательные трубочки, визуально сходные с лучами."
    ),
    "purkinje": (
        "Под эндокардом, в толще миокарда, видны крупные проводящие кардиомиоциты: они "
        "заметно шире и длиннее обычных рабочих, собраны в пучки, окружённые "
        "соединительной тканью. Цитоплазма светлая, почти без поперечной исчерченности, "
        "ядра крупные, лежат в центре клетки. Рядом проходят обычные сократительные "
        "кардиомиоциты."
    ),
    "tongue_foliate": (
        "Слизистая оболочка образует параллельные складки высотой в несколько миллиметров, "
        "разделённые глубокими бороздами. Свободную поверхность покрывает многослойный "
        "плоский неороговевающий эпителий, местами с вкусовыми почками на боковых стенках "
        "борозд. В собственной пластинке лежат белковые железы, кровеносные сосуды и "
        "нервные волокна, глубже — пучки скелетной мышечной ткани."
    ),
    "microvessels": (
        "На срезе видны многочисленные сосуды разного калибра, лежащие в рыхлой "
        "соединительной ткани. Артериальные ветви узнаются по более толстой стенке с "
        "заметным слоем гладких миоцитов и узкому просвету, венозные — по широкому "
        "просвету и тонкой стенке, капилляры — по одному слою эндотелиальных клеток. "
        "Кровяное содержимое местами сохранилось в просветах."
    ),
    "bladder": (
        "Стенка полого органа состоит из слизистой, подслизистой, мышечной и серозной "
        "оболочек. Слизистая выстлана переходным эпителием: поверхностные клетки крупные, "
        "куполообразные, нередко двуядерные. Собственная пластинка рыхлая, с сосудами; "
        "подслизистая основа выражена слабо. Мышечная оболочка из трёх нечётко "
        "разграниченных слоёв — косо продольных и циркулярного между ними."
    ),
    "parathyroid": (
        "Паренхима образована тяжами и скоплениями мелких эндокринных клеток, разделёнными "
        "тонкими прослойками соединительной ткани с капиллярами. Клетки светлые, с округлыми "
        "ядрами; среди них встречаются более крупные оксифильные. Долек и фолликулов, как в "
        "щитовидной железе, здесь нет — орган выглядит однородным."
    ),
    "skin_hair": (
        "В эпидермисе видны слои: базальный, шиповатый, зернистый и тонкий роговой. В дерме "
        "проходят корни волос: продольные срезы показывают волосяной фолликул с корнем и "
        "мозговым веществом, поперечные — округлые кольца фолликула. Рядом лежат сальные "
        "железы, а в глубоких слоях — жировая ткань. Волос пересекает всю толщу кожи под углом."
    ),
    "oviduct": (
        "Стенка трубки состоит из трёх оболочек: слизистой, мышечной и серозной. Слизистая "
        "образует разветвлённые продольные складки, из-за чего просвет выглядит звёздчатым; она "
        "выстлана однослойным призматическим эпителием с ресничными клетками. Мышечная оболочка "
        "толстая, с двумя слоями гладких миоцитов. Снаружи — серозная оболочка."
    ),
}

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
    """Убирает верхнюю полосу с названием препарата, сохраняя сам снимок.

    Заголовок — тёмная строка на светлой бумаге; тёмный фон вокруг окуляра
    (у него мало светлых пикселей) заголовком не считается.
    """
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    sat, val = hsv[:, :, 1], hsv[:, :, 2]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    paper = (gray > 200).mean(axis=1)
    tissue = ((sat > 25) & (val > 40) & (val < 250)).mean(axis=1)
    limit = int(rgb.shape[0] * 0.22)
    for y in range(limit):
        # Ткань пошла, а над ней не бумага, а сразу снимок — обрезать нечего.
        if tissue[y] > 0.55:
            return rgb[max(0, y - 2):, :].copy() if paper[max(0, y - 12):y].mean() > 0.4 else rgb
    return rgb


def crop_slide(rgb: np.ndarray) -> np.ndarray:
    """Убирает белые поля слайда и верхнюю строку с названием препарата."""
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    sat, val = hsv[:, :, 1], hsv[:, :, 2]
    body = ((sat > 22) & (val > 40) & (val < 252)).astype(np.uint8)
    body = cv2.morphologyEx(body, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    ys, xs = np.where(body > 0)
    if len(xs) > 500:
        x0, y0 = max(0, int(xs.min()) - 4), max(0, int(ys.min()) - 4)
        x1 = min(rgb.shape[1], int(xs.max()) + 5)
        y1 = min(rgb.shape[0], int(ys.max()) + 5)
        if (x1 - x0) * (y1 - y0) < 0.93 * rgb.shape[0] * rgb.shape[1]:
            rgb = rgb[y0:y1, x0:x1].copy()

    # Название препарата сверху: чёрная строка над тканью.
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    H = gray.shape[0]
    # Кадр, снятый в окуляр, — светлый кружок в тёмной виньетке. Её верхние
    # строки тоже сплошь «чернила», и раньше они принимались за заголовок:
    # у роговицы из-за этого срезалась верхняя треть кадра с передним
    # эпителием. Виньетку за строку заголовка не считаем.
    vignette = False
    edge = gray[: max(4, int(H * 0.10))]
    if float((edge < 90).mean()) > 0.15 and float((edge > 150).mean()) > 0.15:
        vignette = True
    top = gray[: int(H * 0.22), :]
    ink = ((top < 120) & (top > 0)).astype(np.uint8)
    if not vignette and ink.size and ink.mean() > 0.0005:
        rows = np.where(ink.mean(axis=1) > 0.002)[0]
        if len(rows):
            bottom = int(rows.max()) + 5
            if bottom < H * 0.25 and body[bottom:min(H, bottom + max(6, int(H * 0.06))), :].mean() > 0.10:
                rgb = rgb[bottom:, :].copy()
    return rgb


def _get_ocr():
    """Ленивая инициализация RapidOCR. None — если пакет недоступен."""
    global _OCR
    if _OCR is False:
        return None
    if _OCR is None:
        try:
            from rapidocr_onnxruntime import RapidOCR
            _OCR = RapidOCR()
        except Exception as exc:                          # pragma: no cover
            print(f"RapidOCR недоступен ({exc}); подписи не маскируются", file=sys.stderr)
            _OCR = False
            return None
    return _OCR


def _ocr_lines(rgb: np.ndarray, scales=(1.0, 1.4, 1.9, 2.6)) -> list[tuple[int, int, int, int]]:
    """Строки подписей по данным OCR."""
    ocr = _get_ocr()
    if ocr is None:
        return []
    h, w = rgb.shape[:2]
    found: list[tuple[int, int, int, int]] = []
    for scale in scales:
        im = rgb if abs(scale - 1) < 1e-3 else cv2.resize(
            rgb, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)
        try:
            res, _ = ocr(im)
        except Exception:
            continue
        for item in (res or []):
            xs = [pt[0] / scale for pt in item[0]]
            ys = [pt[1] / scale for pt in item[0]]
            x0, y0, x1, y1 = (int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys)))
            if x1 - x0 >= 6 and y1 - y0 >= 5:
                found.append((x0, y0, x1, y1))
    uniq: list[tuple[int, int, int, int]] = []
    for box in found:
        for u in uniq:
            inter = max(0, min(box[2], u[2]) - max(box[0], u[0])) * \
                    max(0, min(box[3], u[3]) - max(box[1], u[1]))
            area = (box[2] - box[0]) * (box[3] - box[1])
            area_u = (u[2] - u[0]) * (u[3] - u[1])
            if area and area_u and inter / min(area, area_u) > 0.45:
                break
        else:
            uniq.append(box)
    return uniq


def _group_lines(lines, vgap: float = 0.8, hgap: float = 2.0):
    """Склеивает строки одной подписи в блок. Возвращает [(блок, [строки])]."""
    boxes = [[b[0], b[1], b[2], b[3], [tuple(b)]] for b in lines]
    changed = True
    while changed:
        changed = False
        out = []
        for b in boxes:
            for o in out:
                bh = max(b[3] - b[1], o[3] - o[1])
                vin = min(b[3], o[3]) - max(b[1], o[1])
                hin = min(b[2], o[2]) - max(b[0], o[0])
                if vin > -vgap * bh and hin > -hgap * bh:
                    o[0], o[1] = min(o[0], b[0]), min(o[1], b[1])
                    o[2], o[3] = max(o[2], b[2]), max(o[3], b[3])
                    o[4].extend(b[4])
                    changed = True
                    break
            else:
                out.append(b)
        boxes = out
    return [((b[0], b[1], b[2], b[3]), b[4]) for b in boxes]


def _protect_lines(gray: np.ndarray, minlen: int = 26) -> np.ndarray:
    """Маска длинных тонких линий: стрелки, выноски, обводки."""
    edges = cv2.Canny(gray, 60, 170)
    edges = cv2.morphologyEx(edges, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    segs = cv2.HoughLinesP(edges, 1, np.pi / 360, threshold=14,
                           minLineLength=minlen, maxLineGap=4)
    prot = np.zeros_like(gray)
    if segs is None:
        return prot
    for seg in segs.reshape(-1, 4):
        x1, y1, x2, y2 = (int(v) for v in seg)
        if math.hypot(x2 - x1, y2 - y1) < minlen:
            continue
        cv2.line(prot, (x1, y1), (x2, y2), 255, 2)
    return cv2.dilate(prot, np.ones((3, 3), np.uint8), 1)


def _grow_line(box, gray: np.ndarray, level: float):
    """Расширяет бокс OCR до реальных границ строки.

    OCR обрезает буквы по краям, поэтому подпись нельзя заливать по его
    прямоугольнику. Идём влево/вправо, пока в полосе строки есть тёмные
    пиксели; разрыв ограничен, чтобы не зацепить соседнюю подпись.
    """
    x0, y0, x1, y1 = box
    H, W = gray.shape
    h = max(6, y1 - y0)
    sy0 = max(0, y0 - int(0.15 * h))
    sy1 = min(H, y1 + int(0.15 * h) + 1)
    band = gray[sy0:sy1].astype(np.float32)
    dark = band < level
    cols = dark.any(axis=0)
    gap_max = max(5, int(1.0 * h))
    room = int(3.0 * h)

    def walk(pos, step):
        gap = 0
        for _ in range(room):
            pos += step
            if not (0 <= pos < W):
                return min(max(pos, 0), W - 1)
            if cols[pos]:
                gap = 0
            else:
                gap += 1
                if gap > gap_max:
                    return pos - step * gap
        return pos

    gx0, gx1 = walk(x0, -1), walk(x1, 1)
    # вертикальные границы — по тёмным пикселям расширенной полосы
    win = gray[:, max(0, gx0):min(W, gx1)].astype(np.float32)
    rows = np.where((win < level).any(axis=1))[0]
    rows = rows[(rows >= max(0, y0 - h)) & (rows <= min(H - 1, y1 + h))]
    if len(rows):
        y0 = min(y0, int(rows.min()))
        y1 = max(y1, int(rows.max()) + 1)
    return int(max(0, gx0)), int(max(0, y0)), int(min(W, gx1)), int(min(H, y1))


def _light_regions(rgb: np.ndarray) -> np.ndarray:
    """Маска ровных светлых областей: белые выноски, плашки, поля слайда.

    Отбираются только однородные компоненты (низкий разброс яркости) с высокой
    медианой: бледная ткань и светло-голубой фон под слайдом сюда не попадают,
    поэтому заливка по плашке не может испортить препарат.
    """
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    ch = rgb.astype(np.int16)
    spread = ch.max(2) - ch.min(2)
    light = ((gray >= 208) & (spread <= 60)).astype(np.uint8) * 255
    light = cv2.morphologyEx(light, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    filled = cv2.morphologyEx(
        light, cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (19, 19)))
    filled = cv2.morphologyEx(
        filled, cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(filled, 8)
    H, W = gray.shape
    keep = np.zeros_like(filled)
    fallback = np.zeros_like(filled)
    for i in range(1, n):
        area = int(stats[i, 4])
        if area < 0.0006 * H * W:
            continue
        if int(stats[i, 2]) < 10 or int(stats[i, 3]) < 7:
            continue
        comp = lab == i
        if float(np.median(gray[comp])) < 218:
            continue
        keep[comp] = 255
    if not keep.any():
        keep = light.copy()
    return keep


def _column_bg(roi: np.ndarray, ink: np.ndarray) -> np.ndarray:
    """Фон подписи, оценённый по столбцам вокруг букв."""
    bh, bw = ink.shape
    bg = np.zeros((bh, bw, 3), np.float32)
    for c in range(bw):
        col = roi[:, c]
        free = col[ink[:, c] == 0]
        bg[:, c] = np.median(free if len(free) >= 3 else col, axis=0)
    return bg


def _erase_line(rgb: np.ndarray, box, prot: np.ndarray,
                regions: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """Стирает одну строку подписи по пикселям «чернил».

    «Чернила» — это пиксели, которые заметно темнее локального фона и при этом
    почти не окрашены: буквы подписей чёрные, а ткань препарата всегда
    окрашена. Фон под стёртыми буквами восстанавливается inpaint'ом по
    окружению, поэтому ни белых прямоугольников, ни швов не остаётся.
    Длинные линии Хафа (стрелки, обводки) не затрагиваются.
    """
    H, W = rgb.shape[:2]
    x0, y0, x1, y1 = box
    X0, Y0 = max(0, x0 - 3), max(0, y0 - 3)
    X1, Y1 = min(W, x1 + 5), min(H, y1 + 5)
    if X1 - X0 < 8 or Y1 - Y0 < 6:
        return None
    roi = rgb[Y0:Y1, X0:X1]
    gr = cv2.cvtColor(roi, cv2.COLOR_RGB2GRAY)
    chroma = roi.astype(np.int16).max(2) - roi.astype(np.int16).min(2)
    local = cv2.medianBlur(gr, 21).astype(np.float32)
    ink = ((local - gr.astype(np.float32)) > 12) & (chroma <= 70)
    ink = cv2.morphologyEx(ink.astype(np.uint8), cv2.MORPH_CLOSE,
                           np.ones((2, 2), np.uint8))
    # добираем ореол антиалиасинга вокруг уже найденных штрихов
    ring = cv2.dilate(ink, np.ones((3, 3), np.uint8), iterations=1) > 0
    halo = ring & (local - gr.astype(np.float32) > 5) & (chroma <= 70)
    ink = (ink.astype(bool) | halo).astype(np.uint8)
    band = np.zeros_like(ink)
    band[max(0, y0 - Y0):min(Y1 - Y0, y1 - Y0),
         max(0, x0 - X0):min(X1 - X0, x1 - X0)] = 1
    ink &= band
    ink[prot[Y0:Y1, X0:X1] > 0] = 0
    # На светлой плашке буквы — это любые бесхромные пиксели, заметно темнее
    # плашки. Так снимаются и наклонные штрихи, которые не дают «дыры» в фоне.
    reg0 = regions[Y0:Y1, X0:X1] > 0
    if float(reg0.mean()) > 0.55:
        vals = roi[reg0].reshape(-1, 3)
        plate0 = np.clip(np.median(vals, axis=0), 200, 255).astype(np.int16)
        diff0 = np.abs(roi.astype(np.int16) - plate0).max(2)
        ink = ink | ((diff0 > 10) & (chroma <= 40) & band).astype(np.uint8)
    if ink.sum() < 12:
        return None
    ink = cv2.dilate(ink, np.ones((3, 3), np.uint8), iterations=1)
    # восстановление фона: если подпись на светлой плашке, заливаем её цветом
    # (inpaint на однородном фоне оставляет серые разводы), иначе — inpaint
    reg = regions[Y0:Y1, X0:X1] > 0
    if float(reg.mean()) > 0.55:
        vals = roi[reg].reshape(-1, 3)
        bright = vals[gr[reg] >= np.percentile(gr[reg], 70)]
        plate = np.clip(np.median(bright if len(bright) >= 30 else vals, axis=0),
                        200, 255).astype(np.uint8)
        restored = np.broadcast_to(plate, roi.shape).copy()
    else:
        restored = cv2.inpaint(cv2.cvtColor(roi, cv2.COLOR_RGB2BGR), ink, 4,
                               cv2.INPAINT_TELEA)[:, :, ::-1]
    out = rgb.copy()
    sub = out[Y0:Y1, X0:X1]
    sel = ink > 0
    sub[sel] = restored[sel]
    mask = np.zeros((H, W), np.uint8)
    mask[Y0:Y1, X0:X1] = ink * 255
    return out, mask


def mask_captions(rgb: np.ndarray, passes: int = 2) -> np.ndarray:
    """Стирает строго буквы подписей; стрелки, рамки и ткань не меняются."""
    out = crop_slide(rgb).copy()
    for _ in range(passes):
        lines = _ocr_lines(out)
        if not lines:
            break
        regions = _light_regions(out)
        prot = _protect_lines(cv2.cvtColor(out, cv2.COLOR_RGB2GRAY))
        changed = 0
        for box in lines:
            result = _erase_line(out, box, prot, regions)
            if result is None:
                continue
            out, erased = result
            changed += int(erased.sum() // 255)
        if changed < 15:
            break
    return out


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


HINT_CHARS = 700   # с запасом: приложение само укорачивает подсказку до 240 знаков


def clean_text_snippet(text: str) -> str:
    """Описание препарата: начало прозы без служебной шапки.

    Раньше обрезали до 230 знаков, но первые 100–150 обычно занимает название
    препарата с номером и окраской. После их удаления от описания оставался
    обрывок без единого целого предложения, и подсказка вырождалась.
    """
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"^\d+\.\s*", "", text)
    text = re.sub(r"^Общая характеристика:\s*", "", text, flags=re.I)
    text = text[:HINT_CHARS].rstrip(" ,;:")
    return text + ("…" if len(text) >= HINT_CHARS else "")


SERVICE_LINE = re.compile(r"^(Препарат|Окраска|Раздел)\b", re.I)
URL_RE = re.compile(r"https?://\S+")
TITLE_NOISE = re.compile(r"[«»\"'()]")


def text_key(text: str) -> str:
    """Ключ сравнения названий: регистр, ё→е, пунктуация не важны."""
    return re.sub(r"[^a-zа-я0-9]+", " ", re.sub(r"ё", "е", text.lower())).strip()


def title_paths(title: str) -> list[str]:
    """Название препарата в разных видах — чтобы вычистить его из описания."""
    out = [title]
    bare = re.sub(r"\s*\([^)]*\)\s*", " ", title).strip()
    if bare and bare != title:
        out.append(bare)
    m = re.search(r"\(([^)]+)\)", title)
    if m:
        out.append(m.group(1))
    seen, uniq = set(), []
    for t in out:
        k = text_key(t)
        if len(k) >= 5 and k not in seen:
            seen.add(k)
            uniq.append(t)
    return uniq


def page_prose(page, ignore=()) -> str:
    """Абзацы (а не подписи-стрелки) со страницы со слайдами."""
    keys = [text_key(t) for t in ignore if len(text_key(t)) >= 5]
    rows = []
    for x0, y0, _x1, _y1, word, *_ in page.get_text("words"):
        rows.append((round(y0 / 3), x0, word))
    rows.sort(key=lambda r: (r[0], r[1]))
    lines, cur, last_y = [], [], None
    for y, _x0, word in rows:
        if last_y is not None and y != last_y:
            lines.append(" ".join(cur))
            cur = []
        cur.append(word)
        last_y = y
    if cur:
        lines.append(" ".join(cur))
    picked = []
    for line in lines:
        if len(line) < 60 or SERVICE_LINE.match(line) or URL_RE.search(line):
            continue
        k = text_key(line)
        if any(name in k for name in keys):
            continue
        picked.append(line)
    return " ".join(picked)


def collect_hints(pages: dict) -> dict[str, str]:
    hints: dict[str, str] = {}
    for gid, title, number, stain, system, ranges in GROUPS:
        best = ""
        fallback = ""
        for tag, a, b in ranges:
            for pn in range(a, b + 1):
                info = pages.get((tag, pn))
                if not info:
                    continue
                t = info["text"]
                if not info["imgs"]:
                    if len(t) > 80 and not re.match(r"^\d+\.\s*Препарат", t):
                        best = clean_text_snippet(t)
                        break
                    if len(t) > 20 and not fallback:
                        fallback = clean_text_snippet(t)
                    continue
                prose = page_prose(info["page"], ignore=title_paths(title))
                if prose and not fallback:
                    fallback = clean_text_snippet(prose)
            if best:
                break
        hints[gid] = HINTS_MANUAL.get(gid) or best or fallback or (
            f"Раздел: {dict((s[0], s[1]) for s in SYSTEMS)[system]}. Окраска: {stain}."
        )
    return hints


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf-dir", default="/tmp/arena-coding-uploads", help="Папка с тремя исходными PDF")
    ap.add_argument("--out", default=str(ROOT), help="Корень проекта")
    ap.add_argument("--only-hints", action="store_true",
                    help="Обновить только описания препаратов, не пересобирая ассеты")
    ap.add_argument("--only-pages", default="",
                    help="Пересобрать только эти слайды: «0113:14,15» (тег PDF:страницы)")
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

    # Подсказки: проза с текстовой страницы группы. Сначала ищем страницу без
    # картинок, затем — абзацы на страницах со слайдами (там текст часто лежит
    # рядом со снимком, и раньше такие группы оставались без описания).
    hints = collect_hints(pages)

    if args.only_hints:
        dest = out / "js" / "data" / "preparations.js"
        raw = dest.read_text(encoding="utf-8")
        data = json.loads(raw.split("=", 1)[1].rstrip().rstrip(";"))
        for grp in data["groups"]:
            grp["hint"] = hints[grp["id"]]
        dest.write_text(
            "/* Сгенерировано scripts/build_assets.py. Не редактировать вручную. */\n"
            "window.HISTO_DATA = " + json.dumps(data, ensure_ascii=False, indent=2) + ";\n",
            encoding="utf-8",
        )
        empty = [gid for gid in hints if len(hints[gid]) < 60]
        print(json.dumps({"groups": len(data["groups"]), "shortHints": empty}, ensure_ascii=False, indent=2))
        return 0

    prep_dir = out / "assets" / "prep"
    reveal_dir = out / "assets" / "reveal"
    only_pages: set[tuple[str, int]] = set()
    for part in filter(None, (p.strip() for p in args.only_pages.split(";"))):
        tag, _, nums = part.partition(":")
        for n in nums.split(","):
            if n.strip():
                only_pages.add((tag.strip(), int(n)))
    partial = bool(only_pages)
    dest = out / "js" / "data" / "preparations.js"
    kept: list[dict] = []
    old_groups: dict[str, dict] = {}
    if partial:
        # Точечная пересборка: трогаем только выбранные слайды, остальные
        # карточки берём из готового манифеста как есть.
        raw = dest.read_text(encoding="utf-8")
        previous = json.loads(raw.split("=", 1)[1].rstrip().rstrip(";"))
        old_groups = {g["id"]: g for g in previous["groups"]}
        kept = [c for c in previous["cards"]
                if (c["pdf"], c["page"]) not in only_pages]
        for c in kept:
            for rel in (c["clean"], c["reveal"]):
                if rel and not (out / rel).exists():
                    print(f"Нет файла {rel}; запустите полную сборку", file=sys.stderr)
                    return 1
    else:
        for d in (prep_dir, reveal_dir):
            if d.exists():
                for f in d.glob("*.jpg"):
                    f.unlink()
            d.mkdir(parents=True, exist_ok=True)

    cards: list[dict] = []
    seen_xref: set[tuple[str, int]] = set()
    hashes: dict[str, list[int]] = defaultdict(list)
    stats = defaultdict(int)

    def add_card(tag, pn, idx, rgb, gid, *, masked=False, has_labels=False, suffix=""):
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
        if partial and (tag, pn) not in only_pages:
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

    if partial:
        cards = kept + cards

    groups_out = []
    for gid, title, number, stain, system, ranges in GROUPS:
        group = {
            "id": gid, "title": title, "number": number, "stain": stain,
            "system": system, "hint": hints[gid],
            "slides": [f"{SLIDE_OFFSET[tag] + a}–{SLIDE_OFFSET[tag] + b}" for tag, a, b in ranges],
        }
        # Поля, которых этот генератор уже не пишет, при точечной пересборке
        # сохраняем из прежнего манифеста.
        for key, value in old_groups.get(gid, {}).items():
            group.setdefault(key, value)
        groups_out.append(group)

    data = {
        "version": 1,
        "generatedFrom": [f"Гистология_{'0113-0220' if t == '0113' else '0221-0330' if t == '0221' else '0331-0426'}-сжатый.pdf" for t in TAGS],
        "systems": [{"id": s[0], "title": s[1], "color": s[2]} for s in SYSTEMS],
        "groups": groups_out,
        "cards": sorted(cards, key=lambda c: (c["pdf"], c["page"], c["id"])),
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
