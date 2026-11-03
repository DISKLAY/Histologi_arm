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
  assert.ok(app.textContent.includes('Первые буквы'), 'подсказка не показалась');

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
