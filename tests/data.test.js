'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'js/data/preparations.js'), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const data = sandbox.window.HISTO_DATA;

function exists(rel) {
  return rel && fs.existsSync(path.join(ROOT, rel));
}

test('манифест загружается и содержит обязательные разделы', () => {
  assert.ok(data, 'window.HISTO_DATA должен существовать');
  assert.ok(Array.isArray(data.systems) && data.systems.length > 0);
  assert.ok(Array.isArray(data.groups) && data.groups.length > 0);
  assert.ok(Array.isArray(data.cards) && data.cards.length > 0);
});

test('системы и группы уникальны и связаны', () => {
  const sys = new Set(data.systems.map(s => s.id));
  assert.equal(sys.size, data.systems.length, 'дубликаты id систем');
  const gids = new Set(data.groups.map(g => g.id));
  assert.equal(gids.size, data.groups.length, 'дубликаты id групп');
  for (const g of data.groups) {
    assert.ok(sys.has(g.system), `неизвестная система ${g.system} у ${g.id}`);
    assert.ok(g.title && typeof g.title === 'string', `нет названия у ${g.id}`);
    assert.ok(Array.isArray(g.slides) && g.slides.length, `нет слайдов у ${g.id}`);
    assert.ok(typeof g.hint === 'string' && g.hint.length > 10, `нет описания у ${g.id}`);
  }
});

test('у каждой группы есть хотя бы один снимок', () => {
  const counts = new Map(data.groups.map(g => [g.id, 0]));
  for (const c of data.cards) counts.set(c.groupId, (counts.get(c.groupId) || 0) + 1);
  for (const [gid, n] of counts) assert.ok(n > 0, `группа ${gid} без снимков`);
});

test('все карточки уникальны и ссылаются на существующие файлы', () => {
  const ids = new Set();
  for (const c of data.cards) {
    assert.ok(!ids.has(c.id), `дубликат карточки ${c.id}`);
    ids.add(c.id);
    assert.ok(data.groups.some(g => g.id === c.groupId), `неизвестная группа ${c.groupId}`);
    assert.ok(exists(c.clean), `нет файла clean: ${c.clean}`);
    if (c.reveal) assert.ok(exists(c.reveal), `нет файла reveal: ${c.reveal}`);
    assert.equal(typeof c.masked, 'boolean');
    assert.ok(c.source && c.pdf && Number.isInteger(c.page));
  }
});

test('есть и чистые, и обработанные кадры, и подписанные слайды', () => {
  assert.ok(data.cards.some(c => !c.masked), 'нет чистых кадров');
  assert.ok(data.cards.some(c => c.masked), 'нет обработанных кадров');
  assert.ok(data.cards.filter(c => c.reveal).length > 100, 'слишком мало подписанных слайдов');
});

test('нет «висячих» файлов изображений без карточек', () => {
  const used = new Set();
  for (const c of data.cards) {
    used.add(path.basename(c.clean));
    if (c.reveal) used.add(path.basename(c.reveal));
  }
  const prep = fs.readdirSync(path.join(ROOT, 'assets/prep'));
  for (const f of prep) assert.ok(used.has(f), `лишний файл assets/prep/${f}`);
});

test('приложение подключает манифест до своей логики', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const a = html.indexOf('js/data/preparations.js');
  const b = html.indexOf('js/app.js');
  assert.ok(a > -1 && b > a, 'порядок подключения скриптов нарушен');
  assert.ok(fs.existsSync(path.join(ROOT, 'css/styles.css')));
  assert.ok(fs.existsSync(path.join(ROOT, 'js/app.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'assets/favicon.svg')));
});
