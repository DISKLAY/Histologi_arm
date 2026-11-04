/* ==========================================================================
   Гистология · отдельный тренажёр препаратов
   Всё состояние — в localStorage, внешних запросов нет.
   ========================================================================== */
(function () {
  'use strict';

  var DATA = window.HISTO_DATA;
  var STORE_KEY = 'histo-trainer-v1';
  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');
  var modalRoot = document.getElementById('modalRoot');
  var lightbox = document.getElementById('lightbox');
  var mobileNav = document.getElementById('mobileNav');
  var menuToggle = document.getElementById('menuToggle');

  if (!DATA || !DATA.cards || !DATA.cards.length) {
    app.innerHTML = '<div class="empty"><h3>Данные препаратов не загружены</h3><p>Проверьте файл js/data/preparations.js.</p></div>';
    return;
  }

  /* ------------------------------------------------------------- индексы */
  var groups = DATA.groups.slice();
  var cards = DATA.cards.slice();
  var systems = DATA.systems.slice();
  var groupById = {}, cardsByGroup = {}, cardById = {}, systemById = {};
  groups.forEach(function (g) { groupById[g.id] = g; cardsByGroup[g.id] = []; });
  systems.forEach(function (s) { systemById[s.id] = s; });
  cards.forEach(function (c) {
    cardById[c.id] = c;
    if (cardsByGroup[c.groupId]) cardsByGroup[c.groupId].push(c);
  });

  /* У группы есть снимки, снятые без подписей? Тогда в тренировке замазанные
     кадры той же группы ничего не добавляют: показываем чистый кадр, а
     подписанный слайд человек открывает кнопкой после ответа. */
  var cleanGroups = {};
  cards.forEach(function (c) { if (!c.masked) cleanGroups[c.groupId] = true; });
  function trainingCards(list) {
    var out = list.filter(function (c) { return !c.masked || !cleanGroups[c.groupId]; });
    return out.length ? out : list;
  }
  /* Чистый кадр без своего подписанного слайда: показываем подписанный снимок
     другого кадра той же группы — препарат тот же, разбор всё равно нужен. */
  function revealFor(card) {
    if (card.reveal) return card.reveal;
    var mate = (cardsByGroup[card.groupId] || []).filter(function (c) { return c.reveal; })[0];
    return mate ? mate.reveal : null;
  }

  /* ------------------------------------------------------------- состояние */
  function defaults() {
    return {
      theme: 'light',
      progress: {},
      sessions: [],
      settings: { mode: 'choice', count: 20, shuffle: true, systems: [] },
      session: null
    };
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaults();
      var s = JSON.parse(raw), d = defaults();
      return {
        theme: s.theme === 'dark' ? 'dark' : 'light',
        progress: s.progress && typeof s.progress === 'object' ? s.progress : {},
        sessions: Array.isArray(s.sessions) ? s.sessions : [],
        settings: Object.assign(d.settings, s.settings || {}),
        session: s.session || null
      };
    } catch (e) { return defaults(); }
  }
  var state = load();
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast('Не удалось сохранить прогресс'); }
  }
  function prog(id) {
    if (!state.progress[id]) state.progress[id] = { seen: 0, correct: 0, wrong: 0, favorite: false, last: 0 };
    return state.progress[id];
  }

  /* ------------------------------------------------------------- утилиты */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function norm(s) {
    return String(s || '').toLowerCase().replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9+ ]/gi, ' ').replace(/\s+/g, ' ').trim();
  }
  function shortTitle(g) { return g.title.replace(/\s*\([^)]*\)/g, '').trim(); }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove('is-on'); }, 2300);
  }
  function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }
  function fmtDate(ts) {
    try { return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }
  function badge(g) {
    var s = systemById[g.system];
    return '<span class="badge">' + (g.number ? '№ ' + esc(g.number) : esc(s ? s.title : '')) + '</span>';
  }
  function maskBadge(c) {
    return c.masked ? '<span class="badge badge--mask" title="Подписи аккуратно удалены">подписи удалены</span>' : '';
  }
  function route() {
    var h = location.hash.replace(/^#\/?/, '').split('?')[0];
    return h || 'home';
  }
  function go(r) { location.hash = '#/' + r; }

  /* ------------------------------------------------------------- сессия */
  function poolFor(settings, filter) {
    var chosen = settings.systems && settings.systems.length ? settings.systems : null;
    var out = cards.filter(function (c) {
      var g = groupById[c.groupId];
      if (!g) return false;
      if (chosen && chosen.indexOf(g.system) === -1) return false;
      if (filter === 'new' && prog(c.id).seen > 0) return false;
      if (filter === 'fav' && !prog(c.id).favorite) return false;
      if (filter === 'wrong' && prog(c.id).wrong === 0) return false;
      return true;
    });
    return trainingCards(out);
  }
  function makeOptions(card) {
    var right = card.groupId, g = groupById[right];
    var same = groups.filter(function (x) { return x.id !== right && x.system === g.system; });
    var other = groups.filter(function (x) { return x.id !== right && x.system !== g.system; });
    var picks = shuffle(same).slice(0, 2).concat(shuffle(other).slice(0, 2)).slice(0, 3);
    while (picks.length < 3) {
      var extra = shuffle(groups.filter(function (x) { return x.id !== right && picks.indexOf(x) === -1; }))[0];
      if (!extra) break;
      picks.push(extra);
    }
    return shuffle(picks.concat([g])).map(function (x) { return x.id; });
  }
  function startSession(ids, opts) {
    if (!ids || !ids.length) { toast('Нет препаратов по выбранным условиям'); return; }
    opts = opts || {};
    var list = state.settings.shuffle ? shuffle(ids) : ids.slice();
    var count = opts.all ? list.length : Math.min(Number(state.settings.count) || 20, list.length);
    list = list.slice(0, count);
    var options = {};
    list.forEach(function (id) { options[id] = makeOptions(cardById[id]); });
    state.session = {
      ids: list, idx: 0, mode: opts.mode || state.settings.mode,
      label: opts.label || 'Тренировка', answers: {}, options: options,
      started: Date.now(), hinted: {}
    };
    save(); render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function currentCard() {
    if (!state.session) return null;
    return cardById[state.session.ids[state.session.idx]] || null;
  }
  function sessionDone() { return state.session && state.session.idx >= state.session.ids.length; }
  function record(card, correct) {
    var p = prog(card.id);
    p.seen += 1;
    if (correct) p.correct += 1; else p.wrong += 1;
    p.last = Date.now();
    save();
  }
  function finishSession() {
    var s = state.session;
    if (!s) return;
    var correct = 0;
    s.ids.forEach(function (id) { if (s.answers[id] && s.answers[id].correct) correct++; });
    state.sessions.unshift({ id: Date.now(), at: Date.now(), correct: correct, total: s.ids.length, label: s.label, mode: s.mode });
    state.sessions = state.sessions.slice(0, 30);
    save();
  }
  function answer(card, pickedGid, text) {
    var s = state.session;
    if (!s || s.answers[card.id]) return;
    var right = card.groupId, correct;
    if (s.mode === 'input') {
      var n = norm(text), target = norm(groupById[right].title), short = norm(shortTitle(groupById[right]));
      correct = !!n && (n === target || n === short ||
        (n.length >= 4 && (target.indexOf(n) !== -1 || short.indexOf(n) !== -1 ||
          (short.length >= 5 && n.indexOf(short) !== -1))));
    } else {
      correct = pickedGid === right;
    }
    s.answers[card.id] = { correct: correct, picked: pickedGid || null, text: text || '', revealed: false };
    record(card, correct);
    render();
  }
  function next() {
    var s = state.session;
    if (!s) return;
    s.idx += 1;
    if (s.idx >= s.ids.length) finishSession();
    save(); render(); window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ------------------------------------------------------------- статистика */
  function overall() {
    var seen = 0, correct = 0, fav = 0, wrongCards = 0;
    cards.forEach(function (c) {
      var p = state.progress[c.id];
      if (!p) return;
      seen += p.seen || 0; correct += p.correct || 0;
      if (p.favorite) fav++;
      if (p.wrong > 0) wrongCards++;
    });
    return { seen: seen, correct: correct, fav: fav, wrongCards: wrongCards, accuracy: pct(correct, seen) };
  }
  function systemStats() {
    return systems.map(function (s) {
      var gs = groups.filter(function (g) { return g.system === s.id; });
      var cs = cards.filter(function (c) { return gs.some(function (g) { return g.id === c.groupId; }); });
      var seen = 0, correct = 0, touched = 0;
      cs.forEach(function (c) {
        var p = state.progress[c.id]; if (!p) return;
        seen += p.seen || 0; correct += p.correct || 0;
        if (p.seen > 0) touched++;
      });
      return { s: s, groups: gs.length, cards: cs.length, seen: seen, correct: correct, touched: touched, accuracy: pct(correct, seen) };
    });
  }

  /* ------------------------------------------------------------- рендер: главная */
  function renderHome() {
    var o = overall(), ss = systemStats();
    var active = ss.filter(function (x) { return x.seen > 0; }).sort(function (a, b) { return b.seen - a.seen; }).slice(0, 5);
    var last = state.sessions.slice(0, 3);
    return '' +
      '<section class="hero">' +
        '<h1>Узнайте препарат по микрофотографии</h1>' +
        '<p>Отдельный тренажёр по гистологии: чистые снимки без подписей, мгновенная проверка, подсказки и разбор с подписанным вариантом. Сделан как самостоятельная платформа, чтобы сравнить её с встроенной в основной тренажёр.</p>' +
        '<div class="hero__actions">' +
          '<a class="btn btn--primary" href="#/train">Начать тренировку →</a>' +
          '<a class="btn btn--ghost" href="#/atlas">Открыть атлас</a>' +
        '</div>' +
        '<div class="hero__meta">' +
          '<span><strong>' + groups.length + '</strong> препаратов</span>' +
          '<span><strong>' + cards.length + '</strong> снимков</span>' +
          '<span><strong>' + systems.length + '</strong> разделов</span>' +
          '<span><strong>' + cards.filter(function (c) { return c.masked; }).length + '</strong> без подписей после обработки</span>' +
        '</div>' +
      '</section>' +
      '<div class="home-grid">' +
        '<section class="card card--pad">' +
          '<div class="home-card__title"><h2>Быстрый старт</h2><span class="muted" style="font-size:.8rem">Прогресс сохраняется локально</span></div>' +
          '<div class="tile-grid">' +
            tile('#/train', '🎯', 'Тренировка', 'Выбор из вариантов или ввод названия') +
            tile('#/atlas', '🔬', 'Атлас', 'Все препараты по разделам') +
            tile('#/mistakes', '↻', 'Работа над ошибками', o.wrongCards + ' препаратов с ошибками') +
            tile('#/favorites', '★', 'Избранное', o.fav + ' снимков отмечено') +
          '</div>' +
          '<div class="divider"></div>' +
          '<div class="home-card__title"><h2>Разделы курса</h2></div>' +
          (active.length ? '<div class="progress-list">' + active.map(function (x) {
            return '<div class="progress-row"><div class="progress-row__top"><span>' + esc(x.s.title) + '</span><span>' + x.touched + ' / ' + x.cards + ' снимков</span></div>' +
              '<div class="bar"><i style="width:' + pct(x.touched, x.cards) + '%;background:' + x.s.color + '"></i></div></div>';
          }).join('') + '</div>' : '<p class="muted" style="font-size:.87rem">Пока нет отвеченных препаратов — начните первую тренировку, здесь появится прогресс.</p>') +
        '</section>' +
        '<section class="card card--pad">' +
          '<div class="home-card__title"><h2>Ваш результат</h2></div>' +
          '<div class="grid grid--2" style="gap:10px;margin-bottom:16px">' +
            statBox(o.accuracy + '%', 'точность') + statBox(o.seen, 'ответов') +
            statBox(o.correct, 'верных') + statBox(o.fav, 'в избранном') +
          '</div>' +
          '<h3 style="font-size:.9rem;margin-bottom:9px">Последние сессии</h3>' +
          (last.length ? last.map(function (s) {
            return '<div class="summary-line"><span>' + esc(s.label) + ' · ' + fmtDate(s.at) + '</span><span>' + s.correct + ' / ' + s.total + '</span></div>';
          }).join('') : '<p class="muted" style="font-size:.85rem">Сессий ещё не было.</p>') +
          '<div style="margin-top:16px"><a class="btn btn--sm" href="#/stats">Вся статистика →</a></div>' +
        '</section>' +
      '</div>';
  }
  function tile(href, icon, title, sub) {
    return '<a class="tile" href="' + href + '"><span class="tile__icon">' + icon + '</span><span><strong>' + esc(title) + '</strong><span>' + esc(sub) + '</span></span></a>';
  }
  function statBox(num, label) {
    return '<div style="padding:13px;border-radius:var(--r-md);background:var(--surface-2);border:1px solid var(--border)"><div class="stat-num">' + esc(num) + '</div><div class="stat-label">' + esc(label) + '</div></div>';
  }

  /* ------------------------------------------------------------- рендер: настройка */
  function renderSetup() {
    var st = state.settings;
    var sysChips = systems.map(function (s) {
      var on = st.systems.indexOf(s.id) !== -1;
      return '<button type="button" class="chip' + (on ? ' is-on' : '') + '" data-action="toggle-system" data-sid="' + s.id + '">' + esc(s.title) + '</button>';
    }).join('');
    var filters = [
      ['all', 'Все препараты'], ['new', 'Только новые'], ['wrong', 'С ошибками'], ['fav', 'Избранное']
    ].map(function (f) {
      return '<button type="button" class="chip" data-action="quick-start" data-filter="' + f[0] + '">' + f[1] + '</button>';
    }).join('');
    return '' +
      '<div class="page-head"><div><div class="page-head__eyebrow">Режим обучения</div><h1>Тренировка</h1><p>Вам покажут микропрепарат без подписей. Определите, что это за препарат, затем сверьтесь с ответом и подписанным снимком.</p></div></div>' +
      '<div class="setup">' +
        '<section class="card card--pad">' +
          '<div class="setup__section"><h3>Разделы</h3><p>Не выбран ни один — значит, все разделы сразу.</p><div class="chip-row">' + sysChips + '</div></div>' +
          '<div class="setup__section"><h3>Как отвечаем</h3><p>В «Вводе» можно написать краткое название, например «мозжечок».</p>' +
            '<div class="segmented">' +
              '<button type="button" data-action="set-mode" data-mode="choice" class="' + (st.mode === 'choice' ? 'is-on' : '') + '">Выбор из 4</button>' +
              '<button type="button" data-action="set-mode" data-mode="input" class="' + (st.mode === 'input' ? 'is-on' : '') + '">Ввод названия</button>' +
            '</div></div>' +
          '<div class="setup__section"><h3>Длина сессии</h3><p>Снимки выбираются случайно из подходящих.</p>' +
            '<div class="segmented">' + [10, 20, 40].map(function (n) {
              return '<button type="button" data-action="set-count" data-count="' + n + '" class="' + (Number(st.count) === n ? 'is-on' : '') + '">' + n + '</button>';
            }).join('') + '<button type="button" data-action="set-count" data-count="all" class="' + (st.count === 'all' ? 'is-on' : '') + '">Все</button></div></div>' +
          '<div class="setup__section"><h3>Быстрый набор</h3><p>Запустить сессию сразу по готовой подборке.</p><div class="chip-row">' + filters + '</div></div>' +
        '</section>' +
        '<aside class="card card--pad setup__side">' +
          '<h3 style="margin-bottom:12px">Перед стартом</h3>' +
          '<div class="summary-line"><span>Режим</span><span>' + (st.mode === 'input' ? 'Ввод названия' : 'Выбор из 4') + '</span></div>' +
          '<div class="summary-line"><span>Разделов</span><span>' + (st.systems.length ? st.systems.length : systems.length) + ' из ' + systems.length + '</span></div>' +
          '<div class="summary-line"><span>Доступно снимков</span><span>' + poolFor(st, 'all').length + '</span></div>' +
          '<div class="summary-line"><span>Перемешивать</span><span>' + (st.shuffle ? 'да' : 'нет') + '</span></div>' +
          '<button type="button" class="btn btn--sm" data-action="toggle-shuffle" style="margin-top:10px;width:100%">' + (st.shuffle ? 'Не перемешивать' : 'Перемешивать') + '</button>' +
          '<button type="button" class="btn btn--primary" data-action="start" style="margin-top:14px;width:100%">Начать →</button>' +
          '<p class="muted" style="font-size:.76rem;margin-top:12px">Горячие клавиши: <span class="kbd">1</span>–<span class="kbd">4</span> — ответ, <span class="kbd">H</span> — подсказка, <span class="kbd">F</span> — избранное, <span class="kbd">Z</span> — увеличить.</p>' +
        '</aside>' +
      '</div>';
  }

  /* ------------------------------------------------------------- рендер: вопрос */
  function renderQuiz() {
    var s = state.session, card = currentCard();
    if (!card) return renderDone();
    var g = groupById[card.groupId], sys = systemById[g.system];
    var ans = s.answers[card.id], hinted = !!s.hinted[card.id], revealed = ans && ans.revealed;
    var options = s.options[card.id] || makeOptions(card);
    var p = prog(card.id);

    var media = '<section class="card quiz__media">' +
      '<div class="quiz__imgwrap" data-action="zoom" data-src="' + esc(card.clean) + '" data-cap="' + esc(g.title) + ' · ' + esc(card.source) + '">' +
        '<img src="' + esc(card.clean) + '" alt="Микропрепарат без подписей" loading="eager">' +
        '<span class="quiz__zoomhint">Нажмите, чтобы увеличить</span>' +
      '</div>' +
      // Номер препарата — часть ответа: в вопросе его не показываем.
      '<div class="quiz__meta"><div class="chip-row">' + (mentionsAnswer(sys.title, g) ? '' : '<span class="badge">' + esc(sys.title) + '</span>') + maskBadge(card) +
        '<span class="badge">' + esc(card.source) + '</span></div>' +
        '<button type="button" class="btn btn--sm btn--ghost" data-action="favorite">' + (p.favorite ? '★ В избранном' : '☆ В избранное') + '</button></div>' +
      '</section>';

    var right = '<section class="card card--pad">' +
      '<div class="quiz__progress"><i style="width:' + pct(s.idx, s.ids.length) + '%"></i></div>' +
      '<div class="quiz__top"><span class="quiz__count">Вопрос ' + (s.idx + 1) + ' из ' + s.ids.length + '</span><span class="badge">' + esc(s.label) + '</span></div>' +
      '<div class="quiz__question">Что за препарат на снимке?</div>' +
      '<div class="quiz__sub">' + (hinted ? 'Подсказка: ' + esc(systemHint(sys, g)) + ' · окраска ' + esc(g.stain) : 'Ориентируйтесь на структуру ткани и окраску.') + '</div>';

    if (hinted && !ans) {
      // В режиме выбора маска букв — это готовый ответ: из четырёх вариантов
      // она совпадает ровно с одним. Там подсказываем описанием структуры.
      // Система и окраска уже стоят в quiz__sub — в плашке они не нужны.
      var hintText = s.mode === 'choice'
        ? esc(hintClue(g))
        : '<strong>Первые буквы:</strong> ' + esc(maskTitle(g));
      right += '<div class="hintbox">' + hintText + '</div>';
    }

    if (!ans) {
      if (s.mode === 'choice') {
        right += '<div class="options">' + options.map(function (gid, i) {
          return '<button type="button" class="option" data-action="answer" data-gid="' + gid + '"><span class="option__key">' + (i + 1) + '</span><span>' + esc(groupById[gid].title) + '</span></button>';
        }).join('') + '</div>';
      } else {
        right += '<div class="answer-input"><input type="text" id="answerText" placeholder="Например: мозжечок" autocomplete="off" autofocus><button type="button" class="btn btn--primary" data-action="check-input">Проверить</button></div>';
      }
      right += '<div class="quiz__bottom"><div class="chip-row">' +
        '<button type="button" class="btn btn--sm" data-action="hint"' + (hinted ? ' disabled' : '') + '>Подсказка</button>' +
        '<button type="button" class="btn btn--sm btn--ghost" data-action="skip">Не знаю</button></div>' +
        '<button type="button" class="btn btn--sm btn--ghost" data-action="abort">Прервать</button></div>';
    } else {
      var ok = ans.correct;
      right += '<div class="feedback ' + (ok ? 'is-ok' : 'is-bad') + '">' +
        '<div class="feedback__head"><span class="dot">' + (ok ? '✓' : '×') + '</span>' + (ok ? 'Верно' : 'Неверно') + '</div>' +
        '<div class="feedback__answer">' + esc(g.title) + '</div>' +
        '<div class="feedback__chips"><span class="badge">' + esc(sys.title) + '</span> <span class="badge">' + esc(g.stain) + '</span>' + (g.number ? ' <span class="badge">№ ' + esc(g.number) + '</span>' : '') + '</div>' +
        '<p class="feedback__desc" style="margin-top:10px">' + esc(g.hint) + '</p>' +
        '<div class="feedback__actions">' +
          (revealFor(card) ? '<button type="button" class="btn btn--sm" data-action="toggle-reveal">' + (revealed ? 'Скрыть подписи' : 'Показать подписанный снимок') + '</button>' : '') +
          '<button type="button" class="btn btn--sm" data-action="train-group">Тренировать этот препарат</button>' +
        '</div>' +
        (revealed && revealFor(card) ? '<div class="reveal"><img src="' + esc(revealFor(card)) + '" alt="Подписанный вариант препарата"><p class="muted" style="font-size:.76rem;margin-top:6px">Исходный слайд с подписями — для разбора.</p></div>' : '') +
      '</div>' +
      '<div class="quiz__bottom"><span class="muted" style="font-size:.8rem">' + esc(card.source) + '</span>' +
        '<button type="button" class="btn btn--primary" data-action="next">' + (s.idx + 1 >= s.ids.length ? 'Завершить →' : 'Следующий →') + '</button></div>';
    }
    right += '</section>';
    return '<div class="page-head"><div><div class="page-head__eyebrow">Тренировка</div><h1>Определите препарат</h1></div>' +
      '<button type="button" class="btn btn--sm" data-action="abort">Выйти из сессии</button></div>' +
      '<div class="quiz">' + media + right + '</div>';
  }
  function maskTitle(g) {
    var t = shortTitle(g);
    return t.split('').map(function (ch, i) {
      return /[a-zа-я0-9]/i.test(ch) && i > 1 && i % 3 !== 0 ? '_' : ch;
    }).join('');
  }
  /* Названия препарата в разных видах: нужно, чтобы вычистить их из описания.
     Половина описаний в PDF начинается с «Препарат № N. <название>. ...». */
  function keyOf(s) {
    return String(s || '').toLowerCase().replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9]+/g, ' ').trim();
  }
  function titlePaths(g) {
    var out = [];
    function push(s) {
      s = String(s || '').replace(/\s+/g, ' ').trim();
      if (keyOf(s).replace(/[^a-zа-я0-9]/g, '').length < 4) return;
      for (var i = 0; i < out.length; i++) {
        if (keyOf(out[i]) === keyOf(s)) return;
      }
      out.push(s);
    }
    push(g.title);
    push(shortTitle(g));
    // Содержимое скобок бывает уточнением с союзом («Плацента (плодная и
    // материнская части)») — тогда его части тоже называют препарат.
    var m = /\(([^)]+)\)/.exec(g.title || '');
    // «(поперечный срез)», «(мазок)», «(срез яичника кошки)» — это не название, а
    // описание снимка: вырезать его из текста подсказки незачем.
    var GENERIC = /срез|разрез|мазок|стади|окраск|поперечн|продольн|светов(ая|ой)|гистолог/i;
    if (m && !GENERIC.test(m[1])) {
      push(m[1]);
      String(m[1]).split(/\s+(?:и|или)\s+/).forEach(push);
    }
    return out;
  }
  /* Подсказка, которая не выдаёт ответ. Из описания убираются название
     препарата, его номер и служебные «Раздел:»/«Окраска:»; остаётся рассказ о
     том, что видно на срезе. Название вычищается по словам и с учётом
     словоформ: иначе «Печень свиньи» превращалась бы в «и» посреди фразы, а
     «Волокна Пуркинье» оставались бы в тексте. Уцелевшие обрывки («…зёнка»,
     «(нижний мозговой придаток)…») отбрасываются: из нескольких предложений
     собирается связный текст. Если осмысленного описания нет — подсказка
     говорит о структурах, не называя орган. */
  var HINT_FALLBACK = 'Сравните форму, границы и взаимное расположение структур на срезе.';
  var SYSTEM_SCOPE = {
    nervous: 'нервной ткани', sense: 'органов чувств', cardio: 'сосудистой стенки',
    endocrine: 'железистой ткани', immune: 'лимфоидной ткани', digestive: 'слизистой оболочки',
    respiratory: 'дыхательных путей', urinary: 'мочевыделительной системы',
    reproductive: 'половой системы', skin: 'кожи', tooth: 'формирующегося зуба',
    embryo: 'эмбриональных тканей'
  };
  /* Основа слова: «пуркинье» ≈ «пуркинье», «волокна» ≈ «волокон», «печени» ≈ «печень». */
  function stemOf(w) {
    if (w.length <= 3) return w;
    return w.length <= 6 ? w.slice(0, 4) : w.slice(0, w.length - 2);
  }
  function sameWord(a, b) {
    if (a === b) return true;
    if (a.length < 4 || b.length < 4) return false;
    var x = stemOf(a), y = stemOf(b);
    return x === y || (x.length >= 4 && y.indexOf(x) === 0) || (y.length >= 4 && x.indexOf(y) === 0);
  }
  /* Удаляет из текста фразу по словам, не разрезая соседние слова. */
  function cutPhrase(text, phrase) {
    var parts = keyOf(phrase).split(' ').filter(Boolean);
    if (!parts.length) return text;
    var tokens = String(text).split(/(\s+)/);
    var pos = [], words = [];
    for (var i = 0; i < tokens.length; i += 2) {
      if (!tokens[i]) continue;
      pos.push(i);
      words.push(keyOf(tokens[i]).replace(/[^a-zа-я0-9]/g, ''));
    }
    for (var k = 0; k + parts.length <= words.length; k++) {
      var match = true;
      for (var j = 0; j < parts.length; j++) {
        if (!sameWord(words[k + j], parts[j])) { match = false; break; }
      }
      if (!match) continue;
      var gap = pos[k] > 0 && /\W$/.test(tokens[pos[k] - 1] || '');
      var atStart = /(^|[.!?]\s+)$/.test(tokens.slice(0, pos[k]).join('').trim());
      for (var m = 0; m < parts.length; m++) tokens[pos[k + m]] = ' ';
      var out = tokens.join('').replace(/\s+([.,;:])/g, '$1').replace(/[ \t]{2,}/g, ' ');
      // Если название стояло в начале фразы, забираем и его инициал.
      if (gap) out = out.replace(/(^|[.!?]\s+)[а-яё]\s+/g, '$1');
      // «На срезе видно покрытый белочной оболочкой» — предлог, который
      // относился к вырезанному названию, оставляет фразу без дополнения.
      if (atStart) out = out.replace(
        /^\s*(на|в|во|с|со|из|от|о|об|обо|по|при|для|к|ко|у|над|под|за|до|про|через)\s+/i, '');
      return out;
    }
    return text;
  }
  /* Слово встречается в названии только одного препарата — значит, по нему
     можно узнать ответ. */
  function isDistinctWord(word) {
    var stem = stemOf(word), hits = 0;
    for (var i = 0; i < groups.length; i++) {
      var t = keyOf(groups[i].title).split(' ');
      for (var j = 0; j < t.length; j++) {
        if (t[j].length >= 6 && t[j].indexOf(stem) === 0) { hits++; break; }
      }
      if (hits > 1) return false;
    }
    return hits === 1;
  }
  function hintClue(g) {
    // В текстах из PDF встречаются неразрывные пробелы и мягкие переносы — они
    // ломают и сравнение слов, и границы предложений.
    var raw = String(g.hint || '')
      .replace(/[\u00a0\u202f\u2009\u2007]/g, ' ')
      .replace(/[\u00ad\u2010\u2011\ufe63]/g, '-')
      .replace(/\s+/g, ' ').trim();

    // Служебная шапка («ОКРАСКА ГЕМАТОКСИЛИНОМ И ЭОЗИНОМ», «Раздел: …») часто
    // приклеена к первому предложению без точки — отделяем её заранее.
    raw = raw.replace(/\s+(?=(ОКРАСКА|ОКРАШИВАНИЕ|РАЗДЕЛ|ПРЕПАРАТ|Препарат|Окраска|Раздел|Общая характеристика)(?![а-яёa-z]))/g, '. ');
    raw = raw.replace(/Гематоксилин\s*[-–—]\s*эозин(?![а-яёa-z])/gi, ' ');
    raw = raw.replace(/(?<![а-яёa-z])(ОКРАСКА|ОКРАШИВАНИЕ)(?![а-яёa-z])/gi, '. $1');
    raw = raw.replace(/(срез)(?=(артери|вен|нерв|капилляр))/gi, '$1 ');
    raw = raw.replace(/\s+/g, ' ').trim();

    // Название препарата в начале предложения — это заголовок слайда: вместе с
    // ним уходит и сказуемое, такой кусок не спасти. Убираем целиком. Если
    // название стоит в середине фразы, вырезаем только его.
    // Исходные (необрезанные) предложения: если из-за вырезанного названия
    // фраза рассыпается — «клетки, светлые пенистые, почти пустые, т.к.» —
    // лучше взять её целиком, со скобками: «клетки крупные, светлые (пенистые,
    // почти пустые, т.к. липиды вымыты)». Ключ — обрезанная версия.
    var hintRawSentences = {};
    // Точка внутри «т.к.» и «т.е.» разрезает предложение пополам — прячем её
    // за плейсхолдер до разбиения и возвращаем в собранном тексте.
    var ABBR = '\u0001';
    var src = raw.replace(/т\.\s*([ке])\./gi, 'т' + ABBR + '$1' + ABBR);
    var sentences = src.split(/(?<=[.!?…])\s+/).map(function (x) {
      return x.replace(/^\s*\d+[.)]\s*/, '').replace(/^[\s.,;:—–-]+/, '').trim();
    }).filter(Boolean).map(function (st) {
      var head = /^([^,.:;]{0,40})/.exec(st)[0];
      var lead = keyOf(head).split(' ').filter(Boolean);
      var title = keyOf(st).split(' ').filter(Boolean);
      var names = titlePaths(g).map(function (n) {
        return keyOf(n).split(' ').filter(Boolean);
      });
      var opensWithName = names.some(function (p) {
        if (!p.length || p.length > lead.length) return false;
        for (var i = 0; i < p.length; i++) {
          if (!sameWord(lead[i], p[i]) && lead[i].indexOf(stemOf(p[i])) !== 0) return false;
        }
        return true;
      });
      if (opensWithName) return '';
      var t = st;
      for (var pass = 0; pass < 3; pass++) {
        var before = t;
        titlePaths(g).forEach(function (name) { t = cutPhrase(t, name); });
        if (t === before) break;
      }
      if (t !== st) hintRawSentences[t] = st;
      return t;
    }).filter(Boolean);

    var kept = [];
    sentences.forEach(function (st) {
      var t = st
        .replace(/^\s*(ГЕМАТОКСИЛИН|ЭОЗИН|ПИКРОФУКСИН|КОНГОРОТ|ИМПРЕГНАЦ)\w*[^.]*\.?\s*/i, '')
        .replace(/(^|[\s.;])(Раздел|Окраска|Препарат)(?![а-яёa-z])\s*:[^.]*\.?/gi, '$1')
        .replace(/(^|[\s.;])ОКРАСКА(?![а-яёa-z])[^.]*\.?/gi, '$1')
        .replace(/^\s*Общая характеристика\s*:\s*/i, '')
        .replace(/^\s*(Локализация|Строение|Функция|Состав|Расположение)\s*:\s*/i, '')
        .replace(/^\s*Важный момент\s*:\s*/i, '')
        .replace(/\s*[•·]\s*/g, ' ')
        .replace(/\s+/g, ' ').replace(/^[\s.,;:—–-]+/, '').trim();
      if (t && /^[а-яё]/.test(t)) t = t.charAt(0).toUpperCase() + t.slice(1);
      // В скобках PDF часто уточнение, без которого фраза рвётся: «клетки,
      // светлые пенистые, почти пустые, т.к.» — это «(пенистые, почти пустые,
      // т.к. липиды вымыты)» без самого уточнения. Если обрезка названия
      // сломала фразу, берём её целиком из исходного текста, со скобками.
      var whole = hintRawSentences[t] || '';
      if (whole && /т\.\s*[ке]\.?\s*$|[(\u2014-]\s*$|\u2026\s*$/i.test(t)) t = whole;
      if (mentionsAnswer(t, g)) return;
      if (!isCleanSentence(t)) return;
      kept.push(t);
    });

    // «Они собраны в пучки…», «Она состоит из…» — подлежащее осталось в
    // предыдущем (вырезанном) предложении, читается как обрывок.
    kept = kept.filter(function (x) {
      // «Они собраны…» — подлежащее осталось в вырезанном предложении;
      // «Это позволяет…» — отсылка к тому, чего в подсказке уже нет.
      if (/^(Он|Она|Они|Оно|Его|Её|Их)\s+[а-яё]/i.test(x)) return false;
      if (/^Это\s+(позволяет|даёт|видно|объясняется)/i.test(x)) return false;
      // «На срезе видно покрытый … оболочкой» — дополнением было название.
      if (/^(На\s+(срезе|снимке|препарате)\s+(виден|видна|видно|видны)\s+)?(покрыт|состоит|представлен|образовани|называем)\w*/i.test(x)) return false;
      // «Формируется состоящий из нескольких клеточных слоёв» — то же самое:
      // дополнение ушло, причастие повисло.
      if (/^(Формируется|Формируются|Образуется|Образуются|Виден|Видна|Видно|Видны)\s+(состоящ|представл|покрыт|образован)\w*/i.test(x)) return false;
      return true;
    });
    // Короткие обрывки по краям вырваны из контекста («…жировая ткань.»).
    while (kept.length > 1 && kept[0].replace(/[^a-zа-яё0-9]/gi, '').length < 30) kept.shift();
    while (kept.length > 1 &&
           kept[kept.length - 1].replace(/[^a-zа-яё0-9]/gi, '').length < 30) kept.pop();

    // Последнюю фразу не обрываем на «т.к.», «которые», предлоге — она
    // читается как незаконченная. Лучше закончить на предыдущей.
    while (kept.length > 1 && !/[.!?…]$/.test(kept[kept.length - 1])) kept.pop();
    if (kept.length > 1) {
      var tail = kept[kept.length - 1];
      var lastWord = tail.replace(/[.!?…;:,]+$/, '').split(/\s+/).pop().toLowerCase();
      if (/т\.\s*к\.?/i.test(tail) || /т\.\s*е\.?/i.test(tail) ||
          /^(в|во|на|с|со|из|от|до|по|при|для|к|ко|у|над|под|за|про|через|и|а|но|или|что|как|котор\w*)$/.test(lastWord)) {
        kept.pop();
      }
    }

    // Длина — по целым фразам: многоточие на полуслове читается как обрыв.
    while (kept.length > 1 && kept.join(' ').length > 260) kept.pop();

    var out = kept.join(' ').replace(/\s+/g, ' ').trim();
    out = out.replace(/(?<![А-Яа-яЁёA-Za-z])\([^)]*\b(Tunica|Stratum|Papillae|Cryptae|gemmae|scala|stratum|Folliculi|Epidermis|Cortex|lobuli)\b[^)]*\)/g,
      function (m) { return m; })
      .replace(/\s*\)\s*/g, ' ')
      .replace(/\s*\(\s*/g, ' ')
      .replace(/(?<![а-яёa-z])ткань,\s*(заполняет|образует|состоит)/gi, 'ткань $1')
      // Обрывки, оставшиеся от вырезанного названия в середине фразы:
      // «Жёлтое тело … из лютеиновых клеток желточных», «… состоящий из»,
      // «… покрытый белочной оболочкой».
      .replace(/\s+(из|состоящий|состоящая|покрытый|покрытая|представлен\w*|образованный|называем\w*)\s*\./gi, '.')
      .replace(/,\s*(из|состоящий|состоящая|покрытый|покрытая)\s*\./gi, '.')
      // «Состоит из лютеиновых клеток желточных, разделённых…» — прилагательное
      // без своего существительного (оно ушло вместе с названием препарата).
      .replace(/(клеток|клетками|клетки|волокон|волокна|ткани|тканей)\s+([а-яё]+(?:ых|ыми|ые|ой|ая|ое))(?=[\s,.])/gi,
        function (m, noun) { return /(ых|ыми|ые|ой|ая|ое)$/.test(noun) ? m : noun; })
      .replace(/\(\s*[,;:]\s*/g, '(').replace(/\(\s*\)/g, ' ')
      .replace(/\s*\(\s*(?=[.,;:]|$)/g, '')
      .replace(/\(\s*([.,;:]|$)/g, '$1').replace(/\)\s*,/g, '),')
      .replace(/[;,]\s*\./g, '.').replace(/\.\s*\./g, '.')
      .replace(/\s+([.,;:])/g, '$1').replace(/\s{2,}/g, ' ')
      .replace(/^[\s.,;:—–-•·]+/, '').replace(/[\s,;:—–-]+$/, '').trim();
    out = out.replace(/\u0001/g, '.');
    if (out && !/[.!?…]$/.test(out)) out += '.';
    if (out.replace(/[^a-zа-яё0-9]/gi, '').length < 40) {
      out = 'На снимке — участок ' + (SYSTEM_SCOPE[g.system] || 'ткани') + '. ' + HINT_FALLBACK;
    }
    return out;
  }

  /* Название раздела иногда само содержит ответ: раздел «Плацента и
     эмбриональные ткани» однозначно указывает на плаценту. В таком случае
     показываем нейтральную подпись. */
  function systemHint(sys, g) {
    return mentionsAnswer(sys.title, g) ? 'Раздел скрыт' : sys.title;
  }
  /* Встречается ли в тексте название препарата — в том числе внутри слова
     («аденогипофиз» для «Гипофиз», «двенадцатиперстной» для «12-перстная кишка»). */
  function mentionsAnswer(text, g) {
    var words = keyOf(text).split(' ').filter(Boolean);
    var paths = titlePaths(g).map(function (n) {
      var words = keyOf(n).split(' ').filter(function (w) { return w.length >= 4; });
      // Главное слово названия тоже выдаёт ответ («миндалина» в «Нёбная миндалина»),
      // но только если оно отличает препарат от остальных: «желудка» есть и у
      // «Фундального отдела», и у «Пилорической части», поэтому не считается.
      var head = words[words.length - 1];
      if (words.length > 1 && head && head.length >= 6 && isDistinctWord(head)) words = [head];
      return words;
    });
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (!p.length) continue;
      for (var k = 0; k + p.length <= words.length; k++) {
        var ok = true;
        for (var j = 0; j < p.length; j++) {
          var w = words[k + j], q = p[j];
          if (!sameWord(w, q) && w.indexOf(stemOf(q)) !== 0) { ok = false; break; }
        }
        if (ok) return true;
      }
    }
    return false;
  }
  /* Годится ли предложение в подсказку: не начинается с обрывка, не служебное,
     содержит достаточно слов и хотя бы одно «тканевое» слово. Первое
     предложение описания часто бывает без подлежащего — его удаление при
     вычистке названия даёт «резе на жёлто-коричневом фоне…», поэтому такие
     обрывки отсеиваются по отсутствию ключевого слова. */
  /* Зачины, которые сами по себе осмысленны и не являются обрывком. */
  var ORPHAN_OK = /^(Стенка|Слизистая|Железистые|Паренхима|Корковое|Мозговое|Капсула|Ворсины|Крипты|Слои|Клетки|Эпидермис|Дерма|Три|Два|Орган|Органы|Железа|Кость|Зуб|Трубка|Сосуд|Нерв|Мышца|Кожа|Язык|Пищевод|Желудок|Кишка|Печень|Почка|Лёгкое|Сердце|Матка|Яичник|Семенник|На|В|По|Из|С|У|При|Для|От|До|Под|Над|Между|Здесь|Строение|Снаружи|Изнутри|Вокруг|Часть|Ворсин|Оболочка|Снимке)(?![а-яё])/;
  var HINT_KEYWORDS = /(сло|оболоч|клет|ткан|канал|ядр|капсул|дольк|фолликул|ворсин|крипт|сосочк|эпител|мыш|сосуд|волокн|мембран|стром|паренхим|желез|проток|синус|просвет|цитоплазм|мозгов|корков|вестибул|костн|хрящ|ретикул|коллаген|эластич|сероз|слизист)/i;
  function isCleanSentence(s, minLetters) {
    if (!s) return false;
    var letters = s.replace(/[^a-zа-яё0-9]/gi, '').length;
    if (letters < (minLetters || 10)) return false;
    if (!/^[A-Z0-9ЁА-Я«"•\-–—]/.test(s)) return false;
    if (!HINT_KEYWORDS.test(s)) return false;
    if (/^\d+[.)]?\s*$/.test(s)) return false;
    if (letters / s.length < 0.5) return false;
    return true;
  }

  function renderDone() {
    var s = state.session;
    var correct = 0;
    s.ids.forEach(function (id) { if (s.answers[id] && s.answers[id].correct) correct++; });
    var p = pct(correct, s.ids.length);
    var wrong = s.ids.filter(function (id) { return s.answers[id] && !s.answers[id].correct; });
    return '<div class="card card--pad session-done">' +
      '<div class="session-done__ring" style="--p:' + p + '%"><span>' + p + '%</span></div>' +
      '<h1 style="font-size:1.8rem">Сессия завершена</h1>' +
      '<p class="muted" style="margin-top:8px">' + correct + ' верных из ' + s.ids.length + ' · ' + esc(s.label) + '</p>' +
      '<div class="hero__actions" style="justify-content:center">' +
        '<button type="button" class="btn btn--primary" data-action="restart">Ещё раз</button>' +
        (wrong.length ? '<button type="button" class="btn" data-action="repeat-wrong">Повторить ошибки (' + wrong.length + ')</button>' : '') +
        '<a class="btn btn--ghost" href="#/atlas">В атлас</a>' +
      '</div>' +
      '<div style="margin-top:22px"><button type="button" class="btn btn--sm btn--ghost" data-action="new-session">Новая настройка</button></div>' +
    '</div>';
  }
  function renderTrain() {
    return state.session ? (sessionDone() ? renderDone() : renderQuiz()) : renderSetup();
  }

  /* ------------------------------------------------------------- рендер: атлас */
  var atlasQuery = '', atlasSystem = 'all';
  function renderAtlas() {
    var q = norm(atlasQuery);
    var shown = groups.filter(function (g) {
      if (atlasSystem !== 'all' && g.system !== atlasSystem) return false;
      if (!q) return true;
      return norm(g.title).indexOf(q) !== -1 || norm(g.number).indexOf(q) !== -1 ||
             norm(g.stain).indexOf(q) !== -1 || norm(systemById[g.system].title).indexOf(q) !== -1;
    });
    var bySys = {};
    shown.forEach(function (g) { (bySys[g.system] = bySys[g.system] || []).push(g); });
    var body = systems.filter(function (s) { return bySys[s.id] && bySys[s.id].length; }).map(function (s) {
      return '<section class="atlas-group"><div class="atlas-group__head"><span class="badge badge--dot" style="color:' + s.color + '">' + esc(s.title) + '</span><span class="count">' + bySys[s.id].length + ' препаратов</span></div>' +
        '<div class="atlas-grid">' + bySys[s.id].map(function (g) {
          var cs = cardsByGroup[g.id] || [], first = cs[0];
          var seen = cs.filter(function (c) { return state.progress[c.id] && state.progress[c.id].seen > 0; }).length;
          return '<article class="prep-card" data-action="open-group" data-gid="' + g.id + '">' +
            '<div class="prep-card__img"><img src="' + esc(first ? first.clean : '') + '" alt="" loading="lazy"></div>' +
            '<div class="prep-card__body"><h3>' + esc(g.title) + '</h3><div class="prep-card__meta">' + badge(g) + '<span class="badge">' + cs.length + ' снимков</span></div>' +
            '<div class="prep-card__stats">Пройдено ' + seen + ' / ' + cs.length + ' · ' + esc(g.stain) + '</div></div></article>';
        }).join('') + '</div></section>';
    }).join('');
    return '<div class="page-head"><div><div class="page-head__eyebrow">Коллекция</div><h1>Атлас препаратов</h1><p>Все снимки разложены по разделам. Нажмите на препарат, чтобы посмотреть чистые и подписанные варианты.</p></div></div>' +
      '<div class="atlas-tools"><input type="search" id="atlasSearch" placeholder="Поиск по названию, номеру или окраске…" value="' + esc(atlasQuery) + '">' +
      '<div class="chip-row"><button type="button" class="chip' + (atlasSystem === 'all' ? ' is-on' : '') + '" data-action="atlas-system" data-sid="all">Все разделы</button>' +
      systems.map(function (s) { return '<button type="button" class="chip' + (atlasSystem === s.id ? ' is-on' : '') + '" data-action="atlas-system" data-sid="' + s.id + '">' + esc(s.title) + '</button>'; }).join('') + '</div></div>' +
      (body || '<div class="empty"><div class="empty__icon">🔍</div><h3>Ничего не найдено</h3><p>Попробуйте другой запрос или сбросьте фильтр раздела.</p></div>');
  }
  function openGroup(gid) {
    var g = groupById[gid], cs = cardsByGroup[gid] || [], sys = systemById[g.system];
    var shots = cs.map(function (c) {
      return '<div class="modal__shot"><img src="' + esc(c.clean) + '" alt="" loading="lazy" data-action="zoom" data-src="' + esc(c.clean) + '" data-cap="' + esc(g.title) + ' · ' + esc(c.source) + '">' +
        '<p><span>' + esc(c.source) + '</span>' + (c.masked ? '<span class="badge badge--mask">подписи удалены</span>' : '') + '</p></div>' +
        (c.reveal ? '<div class="modal__shot"><img src="' + esc(c.reveal) + '" alt="Подписанный вариант" loading="lazy" data-action="zoom" data-src="' + esc(c.reveal) + '" data-cap="' + esc(g.title) + ' · подписанный слайд"><p><span>С подписями</span><span>разбор</span></p></div>' : '');
    }).join('');
    openModal('<div class="modal__head"><div><h2>' + esc(g.title) + '</h2><p>' + esc(sys.title) + ' · ' + esc(g.stain) + (g.number ? ' · препарат № ' + esc(g.number) : '') + ' · ' + esc(g.slides.join(', ')) + '</p></div><button class="modal__close" data-action="close-modal" aria-label="Закрыть">×</button></div>' +
      '<div class="modal__body"><p style="font-size:.9rem;color:var(--text-2);margin-bottom:16px">' + esc(g.hint) + '</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px"><button type="button" class="btn btn--primary btn--sm" data-action="train-group-from" data-gid="' + gid + '">Тренировать этот препарат</button>' +
      '<button type="button" class="btn btn--sm" data-action="favorite-group" data-gid="' + gid + '">★ Добавить все в избранное</button></div>' +
      '<h3 style="font-size:.95rem;margin-bottom:11px">Снимки (' + cs.length + ')</h3><div class="modal__gallery">' + shots + '</div></div>');
  }

  /* ------------------------------------------------------------- рендер: списки */
  function cardRow(c, extra) {
    var g = groupById[c.groupId], p = prog(c.id);
    return '<div class="card-row"><img class="card-row__img" src="' + esc(c.clean) + '" alt="" loading="lazy">' +
      '<div class="card-row__body"><h3>' + esc(g.title) + '</h3><p>' + esc(c.source) + ' · ' + esc(g.stain) +
      (extra ? ' · ' + extra : '') + '</p><div class="chip-row" style="margin-top:7px">' + badge(g) + maskBadge(c) + '</div></div>' +
      '<div class="card-row__actions"><button type="button" class="btn btn--sm" data-action="open-group" data-gid="' + g.id + '">Смотреть</button>' +
      '<button type="button" class="btn btn--sm btn--ghost" data-action="favorite-card" data-cid="' + c.id + '">' + (p.favorite ? '★' : '☆') + '</button></div></div>';
  }
  function renderMistakes() {
    var list = cards.filter(function (c) { return state.progress[c.id] && state.progress[c.id].wrong > 0; })
      .sort(function (a, b) { return state.progress[b.id].wrong - state.progress[a.id].wrong; });
    return '<div class="page-head"><div><div class="page-head__eyebrow">Повторение</div><h1>Работа над ошибками</h1><p>Снимки, на которых вы ошиблись хотя бы раз. Можно пройти их отдельной сессией.</p></div>' +
      (list.length ? '<button type="button" class="btn btn--primary" data-action="start-wrong">Повторить все (' + list.length + ')</button>' : '') + '</div>' +
      (list.length ? list.map(function (c) {
        var p = state.progress[c.id];
        return cardRow(c, 'ошибок: ' + p.wrong + ' · верных: ' + p.correct);
      }).join('') : '<div class="empty"><div class="empty__icon">✨</div><h3>Ошибок пока нет</h3><p>После первой тренировки здесь появятся снимки для повторения.</p><a class="btn btn--primary" href="#/train" style="margin-top:14px">Начать тренировку</a></div>');
  }
  function renderFavorites() {
    var list = cards.filter(function (c) { return state.progress[c.id] && state.progress[c.id].favorite; });
    return '<div class="page-head"><div><div class="page-head__eyebrow">Личная подборка</div><h1>Избранное</h1><p>Отмеченные снимки. Звёздочка доступна во время тренировки и в атласе.</p></div>' +
      (list.length ? '<button type="button" class="btn btn--primary" data-action="start-fav">Тренировать избранное</button>' : '') + '</div>' +
      (list.length ? list.map(function (c) { return cardRow(c, ''); }).join('') :
        '<div class="empty"><div class="empty__icon">★</div><h3>Пока пусто</h3><p>Отмечайте сложные препараты звёздочкой, чтобы собрать свою подборку.</p></div>');
  }

  /* ------------------------------------------------------------- рендер: статистика */
  function renderStats() {
    var o = overall(), ss = systemStats();
    var hard = cards.filter(function (c) { return state.progress[c.id] && state.progress[c.id].wrong > 0; })
      .sort(function (a, b) {
        var pa = state.progress[a.id], pb = state.progress[b.id];
        return (pb.wrong / Math.max(1, pb.seen)) - (pa.wrong / Math.max(1, pa.seen)) || pb.wrong - pa.wrong;
      }).slice(0, 8);
    return '<div class="page-head"><div><div class="page-head__eyebrow">Прогресс</div><h1>Статистика</h1><p>Считается только по вашим ответам в этом браузере.</p></div>' +
      '<button type="button" class="btn btn--sm btn--danger" data-action="reset">Сбросить прогресс</button></div>' +
      '<div class="stats-grid">' +
        '<div class="card stat-box"><div class="stat-num">' + o.accuracy + '%</div><div class="stat-label">точность</div></div>' +
        '<div class="card stat-box"><div class="stat-num">' + o.seen + '</div><div class="stat-label">всего ответов</div></div>' +
        '<div class="card stat-box"><div class="stat-num">' + cards.length + '</div><div class="stat-label">снимков в базе</div></div>' +
        '<div class="card stat-box"><div class="stat-num">' + state.sessions.length + '</div><div class="stat-label">сессий</div></div>' +
      '</div>' +
      '<div class="grid grid--2">' +
        '<section class="card card--pad"><h2 style="font-size:1.05rem;margin-bottom:14px">По разделам</h2>' +
          '<table class="table"><thead><tr><th>Раздел</th><th>Пройдено</th><th>Точность</th></tr></thead><tbody>' +
          ss.map(function (x) {
            return '<tr><td><span class="badge badge--dot" style="color:' + x.s.color + '">' + esc(x.s.title) + '</span></td>' +
              '<td>' + x.touched + ' / ' + x.cards + '</td><td>' + (x.seen ? x.accuracy + '%' : '—') + '</td></tr>';
          }).join('') + '</tbody></table></section>' +
        '<section class="card card--pad"><h2 style="font-size:1.05rem;margin-bottom:14px">Сложные препараты</h2>' +
          (hard.length ? hard.map(function (c) {
            var p = state.progress[c.id];
            return '<div class="summary-line"><span>' + esc(groupById[c.groupId].title) + '</span><span>' + p.wrong + ' ошибок / ' + p.seen + '</span></div>';
          }).join('') : '<p class="muted" style="font-size:.87rem">Пока нет данных.</p>') +
          '<div class="divider"></div><h3 style="font-size:.92rem;margin-bottom:10px">Последние сессии</h3>' +
          (state.sessions.length ? state.sessions.slice(0, 6).map(function (s) {
            return '<div class="summary-line"><span>' + esc(s.label) + ' · ' + fmtDate(s.at) + '</span><span>' + s.correct + ' / ' + s.total + '</span></div>';
          }).join('') : '<p class="muted" style="font-size:.87rem">Сессий ещё не было.</p>') +
        '</section>' +
      '</div>';
  }

  /* ------------------------------------------------------------- рендер: сравнение */
  function renderCompare() {
    var rows = [
      ['Специфика препарата', 'Пары «чистый / подписанный», увеличение снимка, окраска и бейдж «подписи удалены» встроены в ядро.', 'Придётся расширять общий движок «вопрос → картинка → ответ» под новый тип медиа.', 'отдельная'],
      ['Общий прогресс', 'Своя статистика и избранное; между дисциплинами прогресс не складывается.', 'Один профиль, единые сессии, награды и мотивация по всем предметам.', 'встроенная'],
      ['Обнаруживаемость', 'Нужна отдельная ссылка/репозиторий, пользователь должен прийти сюда.', 'Раздел уже внутри привычного интерфейса, куда студент заходит каждый день.', 'встроенная'],
      ['Вес и данные', '~48 МБ снимков и генератор PDF изолированы, основной репозиторий не раздувается.', 'Тяжёлый датасет и импорт переезжают в основной проект или требуют внешнего хранилища.', 'отдельная'],
      ['Скорость итераций', 'Можно менять quiz, подсказки и вёрстку без риска для анатомических коллоквиумов.', 'Любое изменение затрагивает общий код тем, роутинга и банков.', 'отдельная'],
      ['Повтор кода', 'Свои темы, навигация, localStorage и стили — часть дублирует disklay.', 'Переиспользуются существующие компоненты и формат банков.', 'встроенная'],
      ['Импорт новых препаратов', 'Скрипт работает с исходными PDF напрямую, схема данных простая.', 'Нужно вписаться в чужие import-скрипты и структуру банков.', 'отдельная'],
      ['Поддержка двух продуктов', 'Две точки входа, два набора багфиксов и две темы.', 'Один деплой, один набор проверок.', 'встроенная']
    ];
    var body = rows.map(function (r) {
      return '<tr><td><strong>' + esc(r[0]) + '</strong></td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td>' +
        '<td><span class="badge ' + (r[3] === 'отдельная' ? 'badge--ok' : 'badge--bad') + '">' + r[3] + '</span></td></tr>';
    }).join('');
    return '<div class="page-head"><div><div class="page-head__eyebrow">Выводы эксперимента</div><h1>Отдельная или встроенная?</h1>' +
      '<p>Честное сравнение сделанного прототипа с гипотетическим разделом внутри <strong>DISKLAY/disklay</strong>. Встроенный вариант не реализовывался — оценка по архитектуре основного проекта и по тому, что показал этот прототип.</p></div></div>' +
      '<section class="card card--pad" style="margin-bottom:16px"><h2 style="font-size:1.05rem;margin-bottom:8px">Короткий ответ</h2>' +
      '<p style="font-size:.92rem;color:var(--text-2)">Для <strong>прототипа и датасета</strong> отдельная платформа оказалась лучше: гистология не укладывается в анатомический формат «вопрос → картинка → ответ», а 48 МБ снимков и генератор из PDF не хочется тащить в основной репозиторий. Для <strong>ежедневной учёбы</strong> лучше встроенный раздел: общий прогресс и единая точка входа важнее автономности. Практичный итог — <strong>гибрид</strong>: оставить этот репозиторий источником данных и полигоном для UX, а в основной платформе сделать тонкий раздел «Гистология», который читает тот же манифест и пишет прогресс в общий профиль.</p></section>' +
      '<section class="card card--pad" style="margin-bottom:16px"><h2 style="font-size:1.05rem;margin-bottom:14px">По критериям</h2>' +
      '<div style="overflow-x:auto"><table class="table"><thead><tr><th style="min-width:150px">Критерий</th><th style="min-width:230px">Отдельная платформа</th><th style="min-width:230px">Встроенный раздел</th><th>Перевес</th></tr></thead><tbody>' + body + '</tbody></table></div></section>' +
      '<div class="grid grid--2">' +
        '<section class="card card--pad"><h2 style="font-size:1.05rem;margin-bottom:10px">Что показал прототип</h2>' +
          '<ul style="padding-left:18px;display:grid;gap:8px;font-size:.88rem;color:var(--text-2)">' +
            '<li>Парный показ «без подписей → с подписями» нужен постоянно: без разбора тренировка превращается в угадайку.</li>' +
            '<li>Увеличение снимка и фильтр по окраске/номеру востребованы сильнее, чем экзаменационный режим.</li>' +
            '<li>Работа над ошибками и избранное естественно ложатся на любую платформу — их стоит вынести в общий компонент.</li>' +
            '<li>Автообработка подписей из PDF — отдельная технологическая задача, не зависимая от UI.</li>' +
          '</ul></section>' +
        '<section class="card card--pad"><h2 style="font-size:1.05rem;margin-bottom:10px">Как решить окончательно</h2>' +
          '<ol style="padding-left:18px;display:grid;gap:8px;font-size:.88rem;color:var(--text-2)">' +
            '<li>Дать 5–10 студентам обе точки входа и замерить, сколько сессий они проходят за неделю.</li>' +
            '<li>Сравнить долю возвращений: отдельная ссылка против пункта меню в основной платформе.</li>' +
            '<li>Если встроенный раздел выигрывает по возвратам — перенести манифест как ещё один банк, оставив изображения во внешнем хранилище/CDN.</li>' +
            '<li>Если выигрывает отдельная — оставить её продуктом, но добавить общий экспорт прогресса.</li>' +
          '</ol>' +
          '<div class="divider"></div><p style="font-size:.83rem;color:var(--muted)">Подробный разбор: <code>docs/comparison.md</code>.</p></section>' +
      '</div>';
  }

  /* ------------------------------------------------------------- рендер: о проекте */
  function renderAbout() {
    var masked = cards.filter(function (c) { return c.masked; }).length;
    return '<div class="page-head"><div><div class="page-head__eyebrow">Эксперимент</div><h1>О проекте</h1><p>Отдельная платформа для тренировки гистологических препаратов, сделанная для сравнения с встроенным режимом основного тренажёра по анатомии.</p></div></div>' +
      '<div class="grid grid--2">' +
        '<section class="card card--pad"><h2 style="font-size:1.05rem;margin-bottom:12px">Что внутри</h2>' +
          '<ul style="display:grid;gap:10px;padding-left:18px;color:var(--text-2);font-size:.9rem">' +
            '<li><strong>' + groups.length + ' препаратов</strong> и <strong>' + cards.length + ' снимков</strong> из трёх присланных PDF (слайды 113–426).</li>' +
            '<li><strong>' + (cards.length - masked) + ' чистых кадров</strong> извлечены напрямую из PDF: там, где подписи были векторными поверх фото, берётся само изображение.</li>' +
            '<li><strong>' + masked + ' кадров обработано</strong>: у снимков без версии без подписей заголовки обрезаны, а выноски, текст и стрелки аккуратно замазаны тоном ткани.</li>' +
            '<li>Разбор после ответа показывает подписанный исходный слайд, окраску, номер препарата и краткую характеристику.</li>' +
          '</ul></section>' +
        '<section class="card card--pad"><h2 style="font-size:1.05rem;margin-bottom:12px">Как устроено</h2>' +
          '<p style="font-size:.9rem;color:var(--text-2)">Это статическое приложение без сборки и без серверной части: откройте <code>index.html</code> или запустите любой статический сервер. Данные препаратов лежат в <code>js/data/preparations.js</code>, прогресс — в <code>localStorage</code> браузера, аккаунтов и внешних запросов нет.</p>' +
          '<div class="divider"></div>' +
          '<p style="font-size:.9rem;color:var(--text-2)">Визуально проект ориентируется на <strong>DISKLAY/disklay</strong> (светлая/тёмная темы, выдвижное меню, карточки, работа над ошибками), но живёт отдельным репозиторием — так проще сравнить, что удобнее: самостоятельная платформа или раздел внутри основной.</p>' +
          '<div class="divider"></div>' +
          '<p style="font-size:.84rem;color:var(--muted)">Генератор изображений: <code>scripts/build_assets.py</code>. Исходные PDF в репозиторий не включены — готовые снимки уже собраны в <code>assets/</code>.</p>' +
        '</section>' +
      '</div>' +
      '<section class="card card--pad" style="margin-top:16px"><h2 style="font-size:1.05rem;margin-bottom:10px">Ограничения</h2>' +
        '<p style="font-size:.88rem;color:var(--text-2)">Названия, номера и окраски перенесены из предоставленных материалов и не проходили отдельной медицинской сверки. Часть снимков — схемы или изображения с авторскими подписями; после автоматической обработки они помечены «подписи удалены». Тренажёр не заменяет работу с атласом и преподавателем.</p></section>';
  }

  /* ------------------------------------------------------------- роутер */
  function render(scroll) {
    var r = route();
    var html;
    switch (r) {
      case 'train': html = renderTrain(); break;
      case 'atlas': html = renderAtlas(); break;
      case 'mistakes': html = renderMistakes(); break;
      case 'favorites': html = renderFavorites(); break;
      case 'stats': html = renderStats(); break;
      case 'compare': html = renderCompare(); break;
      case 'about': html = renderAbout(); break;
      default: html = renderHome();
    }
    app.innerHTML = html;
    document.documentElement.setAttribute('data-theme', state.theme);
    document.querySelectorAll('[data-route]').forEach(function (a) {
      a.classList.toggle('is-active', a.getAttribute('data-route') === r);
    });
    if (scroll) window.scrollTo(0, 0);
    var input = document.getElementById('answerText');
    if (input) setTimeout(function () { input.focus(); }, 30);
  }

  /* ------------------------------------------------------------- оверлеи */
  function openModal(html) {
    modalRoot.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + '</div>';
    modalRoot.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    modalRoot.hidden = true;
    modalRoot.innerHTML = '';
    if (lightbox.hidden) document.body.style.overflow = '';
  }
  function openLightbox(src, cap) {
    lightbox.innerHTML = '<button class="lightbox__close" data-action="close-lightbox" aria-label="Закрыть">×</button>' +
      '<img src="' + esc(src) + '" alt="' + esc(cap) + '"><div class="lightbox__caption">' + esc(cap) + '</div>';
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeLightbox() {
    lightbox.hidden = true;
    lightbox.innerHTML = '';
    if (modalRoot.hidden) document.body.style.overflow = '';
  }

  /* ------------------------------------------------------------- действия */
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-action]');
    if (!t) {
      if (e.target === modalRoot) closeModal();
      if (e.target === lightbox) closeLightbox();
      return;
    }
    var a = t.getAttribute('data-action');
    var gid = t.getAttribute('data-gid'), cid = t.getAttribute('data-cid'), sid = t.getAttribute('data-sid');
    var card, g, s = state.session;

    switch (a) {
      case 'toggle-theme':
        state.theme = state.theme === 'dark' ? 'light' : 'dark'; save(); render(false); break;
      case 'toggle-system':
        var arr = state.settings.systems || (state.settings.systems = []);
        var i = arr.indexOf(sid);
        if (i === -1) arr.push(sid); else arr.splice(i, 1);
        save(); render(false); break;
      case 'set-mode':
        state.settings.mode = t.getAttribute('data-mode'); save(); render(false); break;
      case 'set-count':
        var c = t.getAttribute('data-count');
        state.settings.count = c === 'all' ? 'all' : Number(c); save(); render(false); break;
      case 'toggle-shuffle':
        state.settings.shuffle = !state.settings.shuffle; save(); render(false); break;
      case 'quick-start':
        startSession(poolFor(state.settings, t.getAttribute('data-filter')).map(function (x) { return x.id; }),
          { label: t.getAttribute('data-filter') === 'wrong' ? 'Ошибки' : t.getAttribute('data-filter') === 'fav' ? 'Избранное' : t.getAttribute('data-filter') === 'new' ? 'Новые' : 'Тренировка' });
        break;
      case 'start':
        startSession(poolFor(state.settings, 'all').map(function (x) { return x.id; }),
          { all: state.settings.count === 'all', label: 'Тренировка' }); break;
      case 'start-wrong':
        startSession(trainingCards(cards.filter(function (x) { return state.progress[x.id] && state.progress[x.id].wrong > 0; })).map(function (x) { return x.id; }), { all: true, label: 'Ошибки' }); break;
      case 'start-fav':
        startSession(trainingCards(cards.filter(function (x) { return state.progress[x.id] && state.progress[x.id].favorite; })).map(function (x) { return x.id; }), { all: true, label: 'Избранное' }); break;
      case 'answer':
        card = currentCard(); if (card) answer(card, gid, ''); break;
      case 'check-input':
        card = currentCard();
        var inp = document.getElementById('answerText');
        if (card && inp) answer(card, card.groupId, inp.value);
        break;
      case 'skip':
        card = currentCard(); if (card) answer(card, '__skip__', ''); break;
      case 'hint':
        if (s && currentCard()) { s.hinted[currentCard().id] = true; save(); render(false); }
        break;
      case 'next': next(); break;
      case 'toggle-reveal':
        card = currentCard();
        if (card && s.answers[card.id]) { s.answers[card.id].revealed = !s.answers[card.id].revealed; save(); render(false); }
        break;
      case 'favorite':
        card = currentCard();
        if (card) { var p = prog(card.id); p.favorite = !p.favorite; save(); render(false); toast(p.favorite ? 'Добавлено в избранное' : 'Убрано из избранного'); }
        break;
      case 'favorite-card':
        if (cid) { var pc = prog(cid); pc.favorite = !pc.favorite; save(); render(false); }
        break;
      case 'favorite-group':
        (cardsByGroup[gid] || []).forEach(function (c) { prog(c.id).favorite = true; });
        save(); toast('Все снимки препарата добавлены в избранное'); break;
      case 'abort':
        if (confirm('Прервать текущую сессию? Ответы уже сохранены в статистике.')) {
          state.session = null; save(); render(true);
        }
        break;
      case 'restart':
        if (s) startSession(s.ids, { all: true, mode: s.mode, label: s.label }); break;
      case 'repeat-wrong':
        if (s) startSession(s.ids.filter(function (id) { return s.answers[id] && !s.answers[id].correct; }), { all: true, mode: s.mode, label: 'Ошибки' });
        break;
      case 'new-session':
        state.session = null; save(); render(true); break;
      case 'train-group':
      case 'train-group-from':
        if (gid) {
          if (a === 'train-group-from') closeModal();
          startSession(trainingCards(cardsByGroup[gid] || []).map(function (c) { return c.id; }), { all: true, label: groupById[gid].title });
        }
        break;
      case 'open-group': openGroup(gid); break;
      case 'close-modal': closeModal(); break;
      case 'zoom': openLightbox(t.getAttribute('data-src'), t.getAttribute('data-cap')); break;
      case 'close-lightbox': closeLightbox(); break;
      case 'atlas-system': atlasSystem = sid; render(false); break;
      case 'reset':
        if (confirm('Сбросить весь прогресс, избранное и историю сессий? Настройки и тема останутся.')) {
          state.progress = {}; state.sessions = []; state.session = null; save(); render(true); toast('Прогресс сброшен');
        }
        break;
    }
  });

  // Поиск в атласе без перерисовки всей страницы на каждый символ.
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'atlasSearch') {
      atlasQuery = e.target.value;
      clearTimeout(window.__atlasT);
      window.__atlasT = setTimeout(function () {
        var pos = e.target.selectionStart;
        render(false);
        var again = document.getElementById('atlasSearch');
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (err) {} }
      }, 180);
    }
  });

  document.getElementById('themeToggle').addEventListener('click', function () {
    state.theme = state.theme === 'dark' ? 'light' : 'dark'; save(); render(false);
  });
  menuToggle.addEventListener('click', function () {
    var open = mobileNav.hidden;
    mobileNav.hidden = !open;
    menuToggle.setAttribute('aria-expanded', String(open));
  });
  mobileNav.addEventListener('click', function (e) {
    if (e.target.closest('a')) { mobileNav.hidden = true; menuToggle.setAttribute('aria-expanded', 'false'); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (!lightbox.hidden) closeLightbox(); else if (!modalRoot.hidden) closeModal(); return; }
    if (!lightbox.hidden || !modalRoot.hidden) return;
    if (route() !== 'train' || !state.session || sessionDone()) return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      if (e.key === 'Enter') { e.preventDefault(); var b = document.querySelector('[data-action="check-input"]'); if (b) b.click(); }
      return;
    }
    var card = currentCard(), ans = card && state.session.answers[card.id];
    if (ans) {
      if (e.key === 'Enter') { e.preventDefault(); next(); }
      return;
    }
    if (/^[1-4]$/.test(e.key) && state.session.mode === 'choice') {
      var opts = document.querySelectorAll('.option');
      var b2 = opts[Number(e.key) - 1]; if (b2) b2.click(); return;
    }
    var k = e.key.toLowerCase();
    if (k === 'h') { var hb = document.querySelector('[data-action="hint"]'); if (hb && !hb.disabled) hb.click(); }
    if (k === 'f') { var fb = document.querySelector('[data-action="favorite"]'); if (fb) fb.click(); }
    if (k === 'z') { var zb = document.querySelector('[data-action="zoom"]'); if (zb) zb.click(); }
  });

  window.addEventListener('hashchange', function () { render(true); });
  render(false);
})();
