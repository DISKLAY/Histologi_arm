'use strict';

// Необязательный smoke-тест интерфейса. Требует jsdom:
//   npm install --no-save jsdom && npm test
// Без jsdom тест пропускается, поэтому у проекта нет обязательных зависимостей.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dataSrc = fs.readFileSync(path.join(ROOT, 'js/data/preparations.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');

function boot(hash) {
  const dom = new JSDOM(html, {
    url: 'http://localhost/' + (hash || ''),
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const w = dom.window;
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  w.eval(dataSrc);
  w.eval(appSrc);
  return { dom, w, app: w.document.getElementById('app') };
}
function visit(w, r) {
  w.location.hash = '#/' + r;
  w.dispatchEvent(new w.HashChangeEvent('hashchange'));
}

test('UI: все маршруты рендерятся без ошибок', { skip: JSDOM ? false : 'jsdom не установлен' }, () => {
  const { w, app } = boot();
  const expected = {
    home: 'Узнайте препарат',
    train: 'Тренировка',
    atlas: 'Атлас препаратов',
    mistakes: 'Работа над ошибками',
    favorites: 'Избранное',
    stats: 'Статистика',
    compare: 'Отдельная или встроенная?',
    about: 'О проекте'
  };
  for (const [r, text] of Object.entries(expected)) {
    visit(w, r);
    assert.ok(app.textContent.includes(text), `маршрут ${r}: нет «${text}»`);
  }
  visit(w, 'atlas');
  assert.ok(w.document.querySelectorAll('.prep-card').length > 20, 'в атласе мало карточек');
});

test('UI: сессия, ответ, подсказка, разбор и следующий вопрос', { skip: JSDOM ? false : 'jsdom не установлен' }, () => {
  const { w, app } = boot();
  visit(w, 'train');
  w.document.querySelector('[data-action="start"]').click();
  assert.ok(app.textContent.includes('Что за препарат на снимке'), 'сессия не началась');
  assert.equal(w.document.querySelectorAll('.option').length, 4, 'должно быть 4 варианта');

  const hint = w.document.querySelector('[data-action="hint"]');
  hint.click();
  const hintBox = w.document.querySelector('.hintbox');
  assert.ok(hintBox, 'подсказка не показалась');
  // в режиме выбора подсказка — описание, а не маска букв
  assert.ok(!hintBox.textContent.includes('Первые буквы'), 'в режиме выбора маска букв выдаёт ответ');
  assert.ok(hintBox.textContent.trim().length > 20, 'подсказка пустая');

  w.document.querySelector('.option').click();
  assert.ok(app.querySelector('.feedback'), 'нет блока разбора после ответа');

  const reveal = w.document.querySelector('[data-action="toggle-reveal"]');
  if (reveal) {
    reveal.click();
    assert.ok(app.querySelector('.reveal'), 'подписанный снимок не открылся');
  }

  w.document.querySelector('[data-action="next"]').click();
  assert.ok(app.textContent.includes('Вопрос 2'), 'нет перехода к следующему вопросу');

  const saved = JSON.parse(w.localStorage.getItem('histo-trainer-v1'));
  assert.ok(saved.session, 'сессия не сохранилась');
  assert.ok(Object.keys(saved.progress).length > 0, 'ответ не сохранился в прогресс');
});

test('UI: атлас открывает препарат, тема переключается', { skip: JSDOM ? false : 'jsdom не установлен' }, () => {
  const { w } = boot();
  visit(w, 'atlas');
  w.document.querySelector('.prep-card').click();
  assert.ok(!w.document.getElementById('modalRoot').hidden, 'модальное окно не открылось');
  assert.ok(w.document.querySelectorAll('.modal__shot').length > 0, 'нет снимков в модальном окне');
  w.document.querySelector('[data-action="close-modal"]').click();
  assert.ok(w.document.getElementById('modalRoot').hidden, 'модальное окно не закрылось');

  w.document.getElementById('themeToggle').click();
  assert.equal(w.document.documentElement.getAttribute('data-theme'), 'dark');
});

test('UI: режим ввода названия принимает ответ', { skip: JSDOM ? false : 'jsdom не установлен' }, () => {
  const { w, app } = boot();
  visit(w, 'train');
  w.document.querySelector('[data-action="set-mode"][data-mode="input"]').click();
  w.document.querySelector('[data-action="start"]').click();
  const input = w.document.getElementById('answerText');
  assert.ok(input, 'нет поля ввода');
  const group = w.eval(`(function () {
    var s = JSON.parse(localStorage.getItem('histo-trainer-v1')).session;
    var card = window.HISTO_DATA.cards.find(function (c) { return c.id === s.ids[s.idx]; });
    return window.HISTO_DATA.groups.find(function (g) { return g.id === card.groupId; }).title;
  })()`);
  input.value = group;
  w.document.querySelector('[data-action="check-input"]').click();
  assert.ok(app.querySelector('.feedback.is-ok'), 'полное название не засчитано');
});

test('UI: подсказка в режиме выбора не выдаёт ответ', { skip: JSDOM ? false : 'jsdom не установлен' }, () => {
  const { w } = boot();
  // Функции подсказки замкнуты внутри IIFE, поэтому проверяем их через сам
  // интерфейс: каждый препарат открывается отдельной сессией из одного вопроса.
  // Состояние живёт в памяти, поэтому «подменить» группу через localStorage нельзя —
  // вопрос листаем по карточкам одной сессии.
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ').trim();

  visit(w, 'train');
  const mode = w.document.querySelector('[data-action="set-mode"][data-mode="choice"]');
  if (mode && mode.getAttribute('aria-pressed') !== 'true') mode.click();
  const all = w.document.querySelector('[data-action="set-count"][data-count="all"]');
  if (all) all.click();                       // все карточки, а не 20 по умолчанию
  w.document.querySelector('[data-action="start"]').click();

  const problems = [];
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const wrap = w.document.querySelector('.quiz__imgwrap');
    if (!wrap) break;
    const cap = (wrap.getAttribute('data-cap') || '').split(' · ')[0];
    const g = w.HISTO_DATA.groups.find(x => x.title === cap);
    w.document.querySelector('[data-action="hint"]').click();
    const box = w.document.querySelector('.hintbox');
    const text = box ? box.textContent.replace(/\s+/g, ' ').trim() : '';
    const id = g ? g.id : cap;
    if (!seen.has(id)) {
      seen.add(id);
      if (!text) problems.push(`${id}: пустая подсказка`);
      if (/№\s*\d/.test(text)) problems.push(`${id}: номер препарата`);
      if (/_{2,}/.test(text)) problems.push(`${id}: маска букв`);
      if (/•/.test(text)) problems.push(`${id}: маркер списка`);
      if (/\(\s*[,;:]|\(\s*$|\(\s*\)/.test(text)) problems.push(`${id}: осиротевшая скобка`);
      if (g) {
        const names = [g.title, g.title.replace(/\s*\([^)]*\)/g, '').trim()]
          .map(norm).filter(n => n.length > 5);
        const low = norm(text);
        if (names.some(n => low.includes(n))) problems.push(`${id}: название препарата`);
        // главное слово названия, если оно отличает препарат от остальных
        const head = norm(g.title).split(' ').pop();
        if (head && head.length >= 6 && low.split(' ').includes(head)) {
          const rivals = w.HISTO_DATA.groups.filter(x =>
            norm(x.title).split(' ').some(t => t.startsWith(head.slice(0, 4))));
          if (rivals.length === 1) problems.push(`${id}: главное слово «${head}»`);
        }
      }
      if (text.length > 300) problems.push(`${id}: слишком длинная (${text.length})`);
    }
    w.document.querySelector('[data-action="skip"]').click();
    w.document.querySelector('[data-action="next"]').click();
  }
  assert.ok(seen.size >= 20, 'просмотрено слишком мало препаратов: ' + seen.size);
  assert.deepEqual(problems, [], 'подсказка выдаёт ответ:\n' + problems.join('\n'));
});

test('UI: маска первых букв осталась только в режиме ввода', { skip: JSDOM ? false : 'jsdom не установлен' }, () => {
  const { w, app } = boot();
  visit(w, 'train');
  const mode = w.document.querySelector('[data-action="set-mode"][data-mode="input"]');
  if (mode && mode.getAttribute('aria-pressed') !== 'true') mode.click();
  w.document.querySelector('[data-action="start"]').click();
  w.document.querySelector('[data-action="hint"]').click();
  assert.ok(app.textContent.includes('Первые буквы'), 'в режиме ввода маска букв должна остаться');
  assert.ok(!/№\s*\d/.test(w.document.querySelector('.hintbox').textContent), 'номер препарата не должен показываться');
});

test('UI: чистые кадры вытесняют замазанные из тренировки', { skip: JSDOM ? false : 'jsdom не установлен' }, () => {
  const { w, app } = boot();
  visit(w, 'train');
  const mode = w.document.querySelector('[data-action="set-mode"][data-mode="choice"]');
  if (mode && mode.getAttribute('aria-pressed') !== 'true') mode.click();
  const all = w.document.querySelector('[data-action="set-count"][data-count="all"]');
  if (all) all.click();
  w.document.querySelector('[data-action="start"]').click();

  const cleanGroups = new Set(w.HISTO_DATA.cards.filter(c => !c.masked).map(c => c.groupId));
  const problems = [];
  const revealChecked = new Set();
  for (let i = 0; i < 400; i++) {
    const wrap = w.document.querySelector('.quiz__imgwrap');
    if (!wrap) break;
    const src = (wrap.getAttribute('data-src') || '');
    const card = w.HISTO_DATA.cards.find(c => src.endsWith(c.clean));
    if (!card) { problems.push('неизвестная карточка: ' + src); break; }
    if (card.masked && cleanGroups.has(card.groupId)) {
      problems.push(`${card.id}: замазанный кадр группы ${card.groupId}, где есть чистый`);
    }
    // После ответа у чистого кадра группы с подписанным слайдом должна быть кнопка.
    if (!card.masked && !revealChecked.has(card.groupId)) {
      revealChecked.add(card.groupId);
      w.document.querySelector('[data-action="skip"]').click();
      const btn = w.document.querySelector('[data-action="toggle-reveal"]');
      const mate = w.HISTO_DATA.cards.some(c => c.groupId === card.groupId && c.reveal);
      if (mate && !btn) problems.push(`${card.id}: нет кнопки подписанного снимка`);
      if (btn) {
        btn.click();
        const img = w.document.querySelector('.reveal img');
        if (!img) problems.push(`${card.id}: подписанный снимок не раскрылся`);
        else if (!/^assets\/reveal\//.test(img.getAttribute('src'))) {
          problems.push(`${card.id}: раскрылось не фото с подписями`);
        }
        const hide = w.document.querySelector('[data-action="toggle-reveal"]');
        if (hide) hide.click();
      }
    } else {
      w.document.querySelector('[data-action="skip"]').click();
    }
    w.document.querySelector('[data-action="next"]').click();
  }
  assert.ok(revealChecked.size >= 10, 'слишком мало чистых карточек просмотрено: ' + revealChecked.size);
  assert.deepEqual(problems, [], 'правило показа нарушено:\n' + problems.join('\n'));
});

test('UI: подсказки — законченные фразы без обрывков', { skip: JSDOM ? false : 'jsdom не установлен' }, () => {
  const { w } = boot();
  visit(w, 'train');
  const mode = w.document.querySelector('[data-action="set-mode"][data-mode="choice"]');
  if (mode && mode.getAttribute('aria-pressed') !== 'true') mode.click();
  const all = w.document.querySelector('[data-action="set-count"][data-count="all"]');
  if (all) all.click();
  w.document.querySelector('[data-action="start"]').click();

  const dangling = /^(в|во|на|с|со|из|от|до|по|при|для|к|ко|у|над|под|за|про|через|и|а|но|или|что|как|котор\w*)$/i;
  const problems = [];
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const wrap = w.document.querySelector('.quiz__imgwrap');
    if (!wrap) break;
    const cap = (wrap.getAttribute('data-cap') || '').split(' · ')[0];
    const g = w.HISTO_DATA.groups.find(x => x.title === cap);
    const id = g ? g.id : cap;
    if (!seen.has(id)) {
      seen.add(id);
      w.document.querySelector('[data-action="hint"]').click();
      const box = w.document.querySelector('.hintbox');
      const text = box ? box.textContent.replace(/\s+/g, ' ').trim() : '';
      const tail = text.replace(/[.!?…;:,]+$/, '').split(' ').pop() || '';
      if (!text) problems.push(id + ': пустая подсказка');
      if (dangling.test(tail)) problems.push(`${id}: обрыв на «${tail}»`);
      if (/т\.\s*[ке]\.?$/.test(text)) problems.push(id + ': обрыв на сокращении «т.к.»');
      if (/…$/.test(text)) problems.push(id + ': многозначительное многоточие');
      if (/\bвидно\s+(покрыт|состоит|представлен|образован)/.test(text)) problems.push(id + ': висячее причастие');
      if (/\bклеток\s+[а-яё]+(ых|ые|ой),/.test(text)) problems.push(id + ': прилагательное без существительного');
    }
    w.document.querySelector('[data-action="skip"]').click();
    w.document.querySelector('[data-action="next"]').click();
  }
  assert.ok(seen.size >= 50, 'просмотрено слишком мало препаратов: ' + seen.size);
  assert.deepEqual(problems, [], 'подсказки с обрывками:\n' + problems.join('\n'));
});

test('UI: атлас показывает теорию и не показывает замазанные кадры', { skip: JSDOM ? false : 'jsdom не установлен' }, () => {
  const { w } = boot();
  visit(w, 'atlas');
  const problems = [];

  // У каждой группы есть теория и обложка без «замазанного» кадра.
  const missing = w.HISTO_DATA.groups.filter(g => !g.theory || g.theory.replace(/[^a-zа-яё0-9]/gi, '').length < 100);
  if (missing.length) problems.push('нет теории: ' + missing.map(g => g.id).join(', '));

  for (const gid of ['heart', 'cornea', 'lymph_node', 'pancreas', 'kidney_rat']) {
    const card = w.document.querySelector(`[data-action="open-group"][data-gid="${gid}"]`);
    if (!card) { problems.push(gid + ': нет карточки в атласе'); continue; }
    const cover = card.querySelector('.prep-card__img img').getAttribute('src');
    const cards = w.HISTO_DATA.cards.filter(c => c.groupId === gid);
    const maskedSources = cards.filter(c => c.masked).map(c => c.clean).concat(cards.filter(c => c.masked && c.reveal).map(c => c.reveal));
    if (cards.some(c => !c.masked) && maskedSources.includes(cover)) problems.push(gid + ': на обложке замазанный кадр');
    if (!cover) problems.push(gid + ': нет обложки');

    card.click();
    const items = w.document.querySelectorAll('.theory__list li');
    if (items.length < 3) problems.push(`${gid}: пунктов теории ${items.length}`);
    const text = w.document.querySelector('.theory').textContent;
    if (text.length < 200) problems.push(gid + ': теория короче 200 знаков');
    if (/\.\.\.|…/.test(items[0].textContent)) problems.push(gid + ': теория начинается с обрывка');

    // Замазанный кадр допустим только там, где чистых кадров у препарата нет
    // вовсе, и он должен быть честно подписан.
    const shots = [...w.document.querySelectorAll('.modal__shot img')].map(i => i.getAttribute('src'));
    const maskedClean = cards.filter(c => c.masked).map(c => c.clean);
    const hasClean = cards.some(c => !c.masked);
    const bad = shots.filter(s => maskedClean.includes(s));
    if (hasClean && bad.length) problems.push(`${gid}: в галерее замазанный кадр (${bad.length})`);
    if (!hasClean && bad.length) {
      const labels = [...w.document.querySelectorAll('.modal__shot p')]
        .filter(p => p.textContent.includes('подписи удалены')).length;
      if (!labels) problems.push(gid + ': замазанный кадр без пометки');
      if (!w.document.querySelector('.theory__note')) problems.push(gid + ': нет пояснения, что чистого кадра нет');
    }
    if (!shots.length) problems.push(gid + ': галерея пуста');
    w.document.querySelector('[data-action="close-modal"]').click();
  }
  assert.deepEqual(problems, [], 'атлас:\n' + problems.join('\n'));
});

test('UI: снимок открывается крупно, с зумом и кнопкой полного экрана', { skip: JSDOM ? false : 'jsdom не установлен' }, () => {
  const { w } = boot();
  visit(w, 'train');
  w.document.querySelector('[data-action="start"]').click();
  const wrap = w.document.querySelector('.quiz__imgwrap');
  assert.ok(wrap, 'нет снимка в вопросе');
  wrap.click();

  const box = w.document.getElementById('lightbox');
  assert.equal(box.hidden, false, 'просмотр не открылся');
  const img = box.querySelector('.lightbox__img');
  assert.ok(img, 'нет изображения в просмотре');
  for (const a of ['zoom-in', 'zoom-out', 'zoom-reset', 'fullscreen', 'close-lightbox']) {
    assert.ok(box.querySelector(`[data-action="${a}"]`), `нет кнопки ${a}`);
  }
  assert.equal(box.querySelector('.lightbox__level').textContent, '100%');

  box.querySelector('[data-action="zoom-in"]').click();
  const scale = Number((img.style.transform.match(/scale\(([\d.]+)\)/) || [])[1]);
  assert.ok(scale > 1, 'масштаб не вырос: ' + img.style.transform);
  assert.match(box.querySelector('.lightbox__level').textContent, /^(1[6-9]\d|[2-9]\d\d)%$/);
  assert.ok(box.classList.contains('is-zoomed'));

  box.querySelector('[data-action="zoom-out"]').click();
  box.querySelector('[data-action="zoom-out"]').click();
  assert.equal(box.querySelector('.lightbox__level').textContent, '100%', 'меньше 100% не опускается');
  assert.equal(box.querySelector('[data-action="zoom-in"]').closest('.lightbox__bar') !== null, true);

  box.querySelector('[data-action="zoom-reset"]').click();
  assert.equal(box.querySelector('.lightbox__level').textContent, '100%');

  // Закрытие и повторное открытие — масштаб сбрасывается.
  box.querySelector('[data-action="zoom-in"]').click();
  box.querySelector('[data-action="close-lightbox"]').click();
  assert.equal(box.hidden, true, 'просмотр не закрылся');
  wrap.click();
  assert.equal(box.querySelector('.lightbox__level').textContent, '100%', 'масштаб не сбросился');

  // Подписанный снимок в разборе тоже открывается крупно.
  box.querySelector('[data-action="close-lightbox"]').click();
  w.document.querySelector('.option').click();
  const signed = w.document.querySelector('.reveal');
  if (signed) {
    signed.click();
    assert.equal(box.hidden, false, 'подписанный снимок не открылся');
    assert.ok(box.querySelector('.lightbox__img').getAttribute('src').includes('reveal'));
  }
});

test('UI: возврат к предыдущему вопросу сохраняет ответ и разбор', { skip: JSDOM ? false : 'jsdom не установлен' }, () => {
  const { w } = boot();
  visit(w, 'train');
  w.document.querySelector('[data-action="start"]').click();
  const count = () => w.document.querySelector('.quiz__count').textContent;
  assert.match(count(), /^Вопрос 1 из \d+$/);
  assert.equal(w.document.querySelector('[data-action="prev"]').disabled, true, 'на первом вопросе «Назад» активна');

  w.document.querySelector('.option').click();
  const first = w.document.querySelector('.feedback__answer').textContent;
  w.document.querySelector('[data-action="next"]').click();
  assert.match(count(), /^Вопрос 2 из /);

  w.document.querySelector('.option').click();
  w.document.querySelector('[data-action="prev"]').click();
  assert.match(count(), /^Вопрос 1 из /, 'не вернулись на предыдущий вопрос');
  assert.ok(w.document.querySelector('.feedback'), 'ответ не сохранился');
  assert.equal(w.document.querySelector('.feedback__answer').textContent, first, 'показан другой препарат');

  w.document.querySelector('[data-action="next"]').click();
  assert.match(count(), /^Вопрос 2 из /, 'вперёд не ведёт');
  assert.ok(w.document.querySelector('.feedback'), 'ответ второго вопроса потерялся');
});

test('UI: «Тренировать этот препарат» работает из атласа и из разбора', { skip: JSDOM ? false : 'jsdom не установлен' }, () => {
  const { w } = boot();
  const tick = () => new Promise(r => setTimeout(r, 20));
  return (async () => {
    visit(w, 'atlas');
    w.document.querySelector('[data-action="open-group"][data-gid="heart"]').click();
    w.document.querySelector('[data-action="train-group-from"]').click();
    await tick();
    assert.equal(w.location.hash, '#/train', 'не перешли на экран тренировки');
    assert.equal(w.document.getElementById('modalRoot').hidden, true, 'карточка атласа осталась открытой');
    assert.ok(w.document.querySelector('.quiz__count'), 'вопрос не показан');
    assert.equal(w.document.querySelector('.quiz__top .badge').textContent, 'Стенка сердца', 'сессия не про выбранный препарат');

    // Из разбора: кнопка знает, к какому препарату относится.
    w.document.querySelector('.option').click();
    const again = w.document.querySelector('[data-action="train-group"]');
    assert.ok(again.getAttribute('data-gid'), 'у кнопки нет препарата');
    again.click();
    await tick();
    assert.match(w.document.querySelector('.quiz__count').textContent, /^Вопрос 1 из /, 'сессия не началась заново');
  })();
});

test('UI: «Коротко» в атласе не обрывается многоточием и не дублирует теорию целиком', { skip: JSDOM ? false : 'jsdom не установлен' }, () => {
  const { w } = boot();
  visit(w, 'atlas');
  const problems = [];
  for (const g of w.HISTO_DATA.groups) {
    const card = w.document.querySelector(`[data-action="open-group"][data-gid="${g.id}"]`);
    if (!card) { problems.push(g.id + ': нет карточки'); continue; }
    card.click();
    const items = [...w.document.querySelectorAll('.theory__list li')].map(li => li.textContent);
    if (!items.length) problems.push(g.id + ': нет теории');
    if (items.some(t => /…\s*$/.test(t))) problems.push(g.id + ': пункт теории с многоточием');
    const hint = w.document.querySelector('.theory__hint');
    if (hint) {
      const t = hint.textContent.replace(/^Коротко:\s*/, '').trim();
      if (/…\s*$/.test(t)) problems.push(g.id + ': «Коротко» обрывается многоточием');
      if (!/[.!?]$/.test(t)) problems.push(g.id + ': «Коротко» без точки');
      const norm = s => s.toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
      if (norm(t).length > 40 && norm(g.theory).startsWith(norm(t))) {
        problems.push(g.id + ': «Коротко» — дубль начала теории');
      }
    }
    w.document.querySelector('[data-action="close-modal"]').click();
  }
  assert.deepEqual(problems, [], 'атлас:\n' + problems.join('\n'));
});

test('Данные: у «с подписями» есть подписи, кадры целые, нет повторов', () => {
  // В файле есть комментарий-шапка, поэтому режем по самому имени.
  const data = JSON.parse(dataSrc.slice(dataSrc.indexOf('window.HISTO_DATA =') + 'window.HISTO_DATA ='.length).replace(/;\s*$/, ''));

  const problems = [];
  // 1. «С подписями» не должен совпадать с «без подписей» и с другим кадром.
  const byPath = {};
  for (const c of data.cards) {
    if (c.reveal) {
      if (byPath[c.reveal]) problems.push(`reveal повторяется: ${c.reveal} (${byPath[c.reveal]} и ${c.id})`);
      byPath[c.reveal] = c.id;
    }
  }
  // 2. Если у группы есть замазанные кадры, у неё должен быть подписанный
  //    слайд для разбора (чистым кадрам без подписей он не нужен).
  for (const g of data.groups) {
    const cs = data.cards.filter(c => c.groupId === g.id);
    if (cs.some(c => c.masked) && !cs.some(c => c.reveal)) {
      problems.push(g.id + ': есть замазанные кадры, но нет подписанного слайда');
    }
  }
  // 3. Файлы вообще на месте и не пустые.
  for (const c of data.cards) {
    for (const rel of [c.clean, c.reveal]) {
      if (!rel) continue;
      const full = path.join(ROOT, rel);
      if (!fs.existsSync(full)) { problems.push(`${c.id}: нет файла ${rel}`); continue; }
      if (fs.statSync(full).size < 3000) problems.push(`${c.id}: подозрительно маленький файл ${rel}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('Данные: щитовидная железа показывает подписи, а не пустой снимок', () => {
  const data = JSON.parse(dataSrc.slice(dataSrc.indexOf('window.HISTO_DATA =') + 'window.HISTO_DATA ='.length).replace(/;\s*$/, ''));
  const cards = data.cards.filter(c => c.groupId === 'thyroid');
  assert.ok(cards.length >= 3, 'мало карточек щитовидной железы');
  const signed = cards.filter(c => c.reveal);
  assert.ok(signed.length >= 3, 'у щитовидной железы нет подписанных слайдов');
  for (const c of signed) {
    const a = fs.statSync(path.join(ROOT, c.clean)).size;
    const b = fs.statSync(path.join(ROOT, c.reveal)).size;
    assert.ok(b > 20000, `${c.id}: подписанный слайд подозрительно маленький (${b} Б)`);
  }
});
