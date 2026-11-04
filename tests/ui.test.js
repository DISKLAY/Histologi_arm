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
