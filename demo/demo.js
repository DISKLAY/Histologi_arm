/* Демо режима «Структуры»: номера стоят на кончиках стрелок. */
(function () {
  'use strict';

  var cards = window.DEMO_CARDS || [];
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };

  /* mode: 'type' — вписать название, 'point' — показать структуру на снимке */
  var st = { idx: 0, order: [], answers: {}, results: null, cur: 0, answered: {}, mode: 'type', picked: null };

  /* ---------- матчер ---------- */

  function norm(s) {
    return String(s || '').toLowerCase().replace(/ё/g, 'е')
      .replace(/[‐‑–—−-]/g, ' ')
      .replace(/[^а-яa-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function stemOf(w) {
    if (w.length <= 4) return w;
    var re = /(ами|ями|ов|ев|ей|ой|ый|ий|ая|яя|ое|ее|ые|ие|ам|ям|ах|ях|ом|ем|ую|юю|а|я|о|е|ы|и|у|ю|ь)$/;
    var a = w.replace(re, '');
    var b = a.replace(re, '');
    var c = b.length >= 4 ? b.replace(/(а|о|е|и|ы|у)$/, '') : b;
    return c.length >= 3 ? c : a;
  }
  function lev(a, b) {
    if (a === b) return 0;
    var m = a.length, n = b.length, i, j;
    if (!m) return n;
    if (!n) return m;
    var prev = [], cur = [];
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur.slice();
    }
    return prev[n];
  }
  function words(s) { return norm(s).split(' ').filter(Boolean); }

  var SYN = {
    'клетки зерна': ['зернистые клетки'],
    'мягкая мозговая оболочка': ['мягкая мозговая'],
    'нервные волокна параллельные волокна': ['параллельные волокна', 'нервные волокна']
  };

  function typo(a, b) {
    if (!a || !b || a[0] !== b[0]) return false;
    if (Math.abs(a.length - b.length) > 2) return false;
    return lev(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 5));
  }
  function partsOf(label) {
    var bits = String(label || '').split(/\s*[–—−]\s*|\s*,\s*/).map(function (x) { return x.trim(); })
      .filter(function (x) { return x && words(x).length <= 4; });
    return bits.length > 1 ? bits.map(norm) : [];
  }

  function match(given, right) {
    var g = norm(given), r = norm(right);
    if (!g) return 0;
    if (g === r) return 2;
    var gw = words(g), rw = words(r), i, j;
    var syn = SYN[r] || [];
    for (i = 0; i < syn.length; i++) if (g === norm(syn[i])) return 2;

    if (gw.length === rw.length && gw.length > 0) {
      var stemsEqual = true, allTypo = true;
      for (i = 0; i < rw.length; i++) {
        if (gw[i] === rw[i]) continue;
        if (stemOf(gw[i]) !== stemOf(rw[i])) {
          stemsEqual = false;
          if (!typo(gw[i], rw[i])) allTypo = false;
        }
      }
      if (stemsEqual) return 2;
      if (allTypo) return 1;
    }
    if (gw.length === 1 && rw.length > 1) {
      var GENERAL = ['слой', 'вещество', 'оболочка', 'ткань', 'клетка', 'канал', 'кость'];
      for (i = 0; i < rw.length; i++) {
        if (stemOf(rw[i]) === stemOf(gw[0]) && GENERAL.indexOf(rw[i]) < 0) return 1;
      }
    }
    var parts = partsOf(right);
    for (i = 0; i < parts.length; i++) {
      if (g === parts[i]) return 2;
      if (gw.length > 1 && parts[i].indexOf(g) === 0) return 1;
    }
    if (gw.length > 1 && gw.length < rw.length) {
      var subset = true;
      for (i = 0; i < gw.length; i++) {
        var found = false;
        for (j = 0; j < rw.length; j++) {
          if (stemOf(gw[i]) === stemOf(rw[j]) || typo(gw[i], rw[j])) { found = true; break; }
        }
        if (!found) { subset = false; break; }
      }
      if (subset) return 1;
    }
    if (gw.length > rw.length) {
      var cover = 0;
      for (i = 0; i < rw.length; i++) {
        for (j = 0; j < gw.length; j++) {
          if (stemOf(rw[i]) === stemOf(gw[j]) || typo(rw[i], gw[j])) { cover++; break; }
        }
      }
      if (cover === rw.length) return 1;
    }
    return 0;
  }

  function maskTitle(t) {
    return Array.from(String(t)).map(function (ch, i) {
      return /[a-zа-я0-9]/i.test(ch) && i > 1 && i % 3 !== 0 ? '·' : ch;
    }).join('');
  }
  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b === 1) return one;
    if (b >= 2 && b <= 4) return few;
    return many;
  }

  /* ---------- карточка ---------- */

  function card() { return cards[st.idx]; }

  function buildOrder(c) {
    var idx = c.labels.map(function (_, i) { return i; });
    if (st.mode === 'point') {
      // «покажи, где структура» — спрашиваем только те подписи, у которых
      // есть кончик стрелки: без него на снимке нечего нажимать
      idx = idx.filter(function (i) { return c.labels[i].tips && c.labels[i].tips.length; });
    }
    return idx.sort(function (a, b) {
      var A = c.labels[a].b, B = c.labels[b].b;
      var ay = (A[1] + A[3]) / 2, by = (B[1] + B[3]) / 2;
      if (Math.abs(ay - by) > c.h * 0.06) return ay - by;
      return A[0] - B[0];
    });
  }

  function renderPicker() {
    $('picker').innerHTML = cards.map(function (c, i) {
      var t = c.title.replace(/\s*\(.*?\)\s*/g, '').trim();
      return '<button class="pick" data-i="' + i + '" aria-pressed="' + (i === st.idx) + '">' +
        esc(t) + ' <span class="n">слайд ' + c.slide + '</span></button>';
    }).join('');
  }

  function start(i) {
    st.idx = Math.max(0, Math.min(cards.length - 1, i));
    var c = card();
    st.order = buildOrder(c);
    st.answers = {};
    st.results = null;
    st.cur = 0;
    st.answered = {};
    st.picked = null;
    $('pic').src = c.q;
    $('pic').alt = c.title;
    $('cardTitle').textContent = c.title;
    $('cardSub').textContent = [(c.num ? '№ ' + c.num : ''), c.stain, 'слайд ' + c.slide,
      c.labels.length + ' ' + plural(c.labels.length, 'структура', 'структуры', 'структур')]
      .filter(Boolean).join(' · ');
    $('verdict').hidden = true;
    $('verdict').innerHTML = '';
    $('stamp').textContent = '';
    $('checkBtn').disabled = false;
    $('skipBtn').disabled = false;
    renderPicker();
    paint();
    $('answer').value = '';
    $('answer').disabled = false;
    if (st.mode === 'type') $('answer').focus();
  }

  function current() { return st.order[st.cur]; }
  function doneCount() { return Object.keys(st.answered).length; }

  /* У нескольких подписей бывает один и тот же кончик (соседние стрелки
     сходятся в одну точку) — разводим такие метки веером вокруг кончика,
     чтобы обе были видны и нажимались. */
  function spread(points, radius) {
    var out = points.map(function (p) { return { x: p[0], y: p[1] }; });
    var groups = {};
    out.forEach(function (p, i) {
      var key = Math.round(p.x / 16) + ':' + Math.round(p.y / 16);
      (groups[key] = groups[key] || []).push(i);
    });
    Object.keys(groups).forEach(function (key) {
      var ids = groups[key];
      if (ids.length < 2) return;
      ids.forEach(function (id, j) {
        var a = -Math.PI / 2 + (2 * Math.PI * j) / ids.length;
        out[id].x += Math.cos(a) * radius;
        out[id].y += Math.sin(a) * radius;
      });
    });
    return out;
  }

  function placeMarkers() {
    var c = card(), host = $('tips');
    host.innerHTML = '';
    var shown = $('pic').clientWidth;
    if (!shown) return;
    var k = shown / c.w;
    var raw = st.order.map(function (li) {
      var tip = c.labels[li].tips && c.labels[li].tips[0];
      return tip ? [tip[0] * k, tip[1] * k] : null;
    });
    var placed = spread(raw.filter(Boolean), 22);
    var pi = 0;
    st.order.forEach(function (li, pos) {
      var lab = c.labels[li];
      if (!(lab.tips && lab.tips[0])) return;
      var pt = placed[pi++];
      var el = document.createElement('div');
      el.className = 'tip';
      el.textContent = String(pos + 1);
      el.style.left = pt.x + 'px';
      el.style.top = pt.y + 'px';
      el.dataset.i = String(li);
      var res = st.results && st.results[li];
      if (st.results) {
        el.classList.add(res.kind === 'ok' ? 'done' : res.kind === 'near' ? 'near' : 'bad');
      } else if (pos === st.cur && st.mode === 'type') {
        el.classList.add('cur');
      }
      if (st.mode === 'point' && !st.results) {
        el.classList.add('clickable');
        el.addEventListener('click', function () { pickTip(li); });
      }
      host.appendChild(el);
    });
  }

  function placeSpot() {
    var c = card(), spot = $('spot'), lab = c.labels[current()];
    var shown = $('pic').clientWidth;
    if (st.mode !== 'type' || !lab || !shown) { spot.className = 'spot'; return; }
    var k = shown / c.w, b = lab.b, m = 8;
    spot.className = 'spot on';
    spot.style.left = Math.max(0, b[0] * k - m) + 'px';
    spot.style.top = Math.max(0, b[1] * k - m) + 'px';
    spot.style.width = Math.max(26, (b[2] - b[0]) * k + m * 2) + 'px';
    spot.style.height = Math.max(22, (b[3] - b[1]) * k + m * 2) + 'px';
  }

  function paint() {
    var c = card(), total = st.order.length, n = doneCount();
    if (st.results) {
      $('counter').innerHTML = 'Разбор <b>' + (st.cur + 1) + '</b> из ' + total;
    } else {
      $('counter').innerHTML = (st.mode === 'type' ? 'Структура ' : 'Найдите структуру ') +
        '<b>' + (st.cur + 1) + '</b> из ' + total + ' · отвечено ' + n;
    }
    $('bar').style.width = Math.round((n / total) * 100) + '%';
    placeSpot();
    placeMarkers();

    $('shape').innerHTML = '';
    var lab = c.labels[current()];
    if (st.mode === 'type' && lab && $('optShape').checked && !st.results) {
      var w = lab.t.split(/\s+/);
      $('shape').innerHTML = 'подсказка: <b>' + w.length + '</b> ' +
        (w.length === 1 ? 'слово' : w.length < 5 ? 'слова' : 'слов') +
        ' · <code>' + maskTitle(lab.t) + '</code>';
    } else if (st.mode === 'point' && !st.results) {
      $('shape').innerHTML = 'нажмите на номер у нужной стрелки';
    }
    renderQueue();
  }

  function renderQueue() {
    var c = card(), html = '<h3>На этом снимке</h3>';
    st.order.forEach(function (li, pos) {
      var res = st.results && st.results[li];
      var cls = res ? (res.kind === 'ok' ? 'done' : res.kind === 'near' ? 'near' : 'bad') : '';
      var mark = res ? (res.kind === 'ok' ? '✓' : res.kind === 'near' ? '±' : '✕')
        : (pos === st.cur && !st.results ? '→' : '');
      var txt = res ? c.labels[li].t : 'стрелка ' + (pos + 1);
      html += '<div class="qitem ' + cls + (pos === st.cur ? ' cur' : '') + '">' +
        '<span class="dot">' + mark + '</span><span class="txt">' + esc(txt) + '</span></div>';
    });
    $('queue').innerHTML = html;
  }

  /* ---------- действия ---------- */

  function nextOpen(from) {
    for (var i = 1; i <= st.order.length; i++) {
      var p = (from + i) % st.order.length;
      if (!st.answered[st.order[p]]) return p;
    }
    return -1;
  }

  function record(li, kind, given) {
    st.answered[li] = { kind: kind, given: given };
    var nx = nextOpen(st.cur);
    if (nx >= 0) {
      st.cur = nx;
      $('stamp').textContent = '';
      $('answer').value = '';
      paint();
      if (st.mode === 'type') $('answer').focus();
    } else {
      finish();
    }
  }

  function submit() {
    if (st.results || st.mode !== 'type') return;
    var li = current(), val = $('answer').value.trim();
    var m = val ? match(val, card().labels[li].t) : 0;
    if ($('optStrict').checked && m === 1) m = 0;
    record(li, m === 2 ? 'ok' : m === 1 ? 'near' : 'bad', val);
  }

  function skip() {
    if (st.results) return;
    record(current(), 'bad', '');
  }

  function pickTip(li) {
    if (st.results || st.mode !== 'point') return;
    var want = current();
    record(want, li === want ? 'ok' : 'bad', li === want ? '' : 'стрелка ' + (st.order.indexOf(li) + 1));
  }

  function back() {
    var prev = (st.cur - 1 + st.order.length) % st.order.length;
    if (!st.results && !st.answered[st.order[prev]]) return;
    st.cur = prev;
    $('answer').value = st.results ? '' : (st.answers[st.order[prev]] || '');
    paint();
    var li = st.order[prev], r = st.results && st.results[li];
    if (st.results) {
      $('stamp').textContent = card().labels[li].t + (r && r.given ? ' · вы: ' + r.given : '');
    }
    if (st.mode === 'type') $('answer').focus();
  }

  function finish() {
    var c = card();
    st.results = {};
    st.order.forEach(function (li) {
      st.results[li] = st.answered[li] || { kind: 'bad', given: '' };
    });
    $('answer').disabled = true;
    $('checkBtn').disabled = true;
    $('skipBtn').disabled = true;
    $('stamp').textContent = '';
    paint();
    verdict();
  }

  function verdict() {
    var c = card(), full = 0, half = 0;
    st.order.forEach(function (i) {
      var r = st.results[i];
      if (r.kind === 'ok') full++;
      else if (r.kind === 'near') half++;
    });
    var total = st.order.length;
    var pct = Math.round(((full + half * 0.5) / total) * 100);
    var rows = st.order.map(function (i) {
      var l = c.labels[i];
      var r = st.results[i];
      var mark = r.kind === 'ok' ? '✓' : r.kind === 'near' ? '±' : '✕';
      var tag = r.kind === 'ok' ? '<span class="tag ok">верно</span>'
        : r.kind === 'near' ? '<span class="tag near">почти</span>'
        : '<span class="tag bad">мимо</span>';
      var given = r.given ? '<span class="given' + (r.kind === 'ok' ? '' : ' s') + '">' + esc(r.given) + '</span>'
        : '<span class="given">— пропущено</span>';
      return '<li><span class="mark">' + mark + '</span>' + tag +
        '<span class="right">' + esc(l.t) + '</span>' + given + '</li>';
    }).join('');

    var v = $('verdict');
    v.hidden = false;
    v.innerHTML = '<h2>Разбор · ' + esc(c.title) + '</h2>' +
      '<div class="score">Верно <b>' + full + '</b> из ' + total +
      (half ? ' · почти верно ' + half : '') + ' · зачёт <b>' + pct + '%</b></div>' +
      '<ul class="review">' + rows + '</ul>' +
      '<div class="btns">' +
      '<button class="primary" id="nextBtn">Следующий снимок</button>' +
      '<button id="againBtn">Заново</button>' +
      '<button class="ghost" id="prevBtn">← предыдущая</button>' +
      '</div>' +
      '<div class="cmp">' +
      '<figure><img src="' + c.q + '" alt="вопрос" data-lb="1" loading="lazy"><figcaption>Как спрашивалось</figcaption></figure>' +
      '<figure><img src="' + c.a + '" alt="ответ" data-lb="1" loading="lazy"><figcaption>С названиями</figcaption></figure>' +
      '</div>';
    $('nextBtn').addEventListener('click', function () { start(st.idx + 1 < cards.length ? st.idx + 1 : 0); });
    $('againBtn').addEventListener('click', function () { start(st.idx); });
    $('prevBtn').addEventListener('click', back);
    v.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function setMode(mode) {
    st.mode = mode;
    $('modeType').setAttribute('aria-pressed', String(mode === 'type'));
    $('modePoint').setAttribute('aria-pressed', String(mode === 'point'));
    $('qbox').style.display = mode === 'type' ? '' : 'none';
    $('qlabel').textContent = mode === 'type' ? 'Название структуры' : 'Найдите её на снимке';
    $('checkBtn').disabled = mode !== 'type';
    start(st.idx);
  }

  /* ---------- события ---------- */

  $('picker').addEventListener('click', function (e) {
    var b = e.target.closest('.pick');
    if (b) start(Number(b.dataset.i));
  });
  $('modeType').addEventListener('click', function () { setMode('type'); });
  $('modePoint').addEventListener('click', function () { setMode('point'); });
  $('checkBtn').addEventListener('click', submit);
  $('skipBtn').addEventListener('click', skip);
  $('answer').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Tab') { e.preventDefault(); skip(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.key === 'Enter' && !st.results) { e.preventDefault(); submit(); }
  });
  window.addEventListener('resize', function () { placeSpot(); placeMarkers(); });

  document.addEventListener('click', function (e) {
    var img = e.target.closest('img[data-lb], .shot img');
    if (!img) return;
    var lb = $('lb');
    lb.querySelector('img').src = img.src;
    lb.classList.add('on');
  });
  $('lb').addEventListener('click', function () { this.classList.remove('on'); });

  var nLab = cards.reduce(function (n, c) { return n + c.labels.length; }, 0);
  var nTips = cards.reduce(function (n, c) {
    return n + c.labels.filter(function (l) { return l.tips.length; }).length;
  }, 0);
  var nPrep = new Set(cards.map(function (c) { return c.g; })).size;
  $('subtitle').textContent = cards.length + ' ' + plural(cards.length, 'снимок', 'снимка', 'снимков') +
    ' · ' + nLab + ' ' + plural(nLab, 'подпись', 'подписи', 'подписей') +
    ' · ' + nPrep + ' ' + plural(nPrep, 'препарат', 'препарата', 'препаратов');
  $('nCards').textContent = String(cards.length);
  $('nLabels').textContent = String(nLab);
  $('nTips').textContent = String(nTips);

  start(0);
})();
