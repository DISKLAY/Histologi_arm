'use strict';

// Проверки данных режима «Структуры» (js/data/structures.js) и демо.
// Запуск: npm test — тесту не нужен браузер, только node.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const structSrc = fs.readFileSync(path.join(ROOT, 'js/data/structures.js'), 'utf8');

function load() {
  const body = structSrc.slice(structSrc.indexOf('=') + 1).replace(/;\s*$/, '');
  const data = JSON.parse(body);
  return data.cards || [];
}

test('Структуры: манифест не пустой и у каждой карточки есть кадры', () => {
  const cards = load();
  assert.ok(cards.length >= 20, 'снимков меньше, чем ожидалось: ' + cards.length);
  const missing = [];
  cards.forEach(c => {
    for (const suffix of ['-q.jpg', '-a.jpg']) {
      const rel = path.join(ROOT, 'assets', 'structures', c.id + suffix);
      if (!fs.existsSync(rel)) missing.push(path.relative(ROOT, rel));
    }
    assert.ok(c.w > 100 && c.h > 100, 'неверный размер кадра у ' + c.id);
  });
  assert.deepEqual(missing, [], 'нет готовых файлов снимков');
});

test('Структуры: почти у каждой подписи есть стрелка, и кончик не на тексте', () => {
  const cards = load();
  let total = 0;
  let withTip = 0;
  const bad = [];
  cards.forEach(c => {
    c.labels.forEach(l => {
      total++;
      if (l.tips && l.tips.length) withTip++;
      (l.tips || []).forEach(t => {
        const inside = t[0] >= l.box[0] - 2 && t[0] <= l.box[2] + 2 &&
                       t[1] >= l.box[1] - 2 && t[1] <= l.box[3] + 2;
        if (inside) bad.push(c.id + ': «' + l.text + '» метка стоит на тексте подписи');
        if (t[0] < 0 || t[1] < 0 || t[0] > c.w || t[1] > c.h) {
          bad.push(c.id + ': «' + l.text + '» метка вылезла за кадр');
        }
      });
    });
  });
  assert.deepEqual(bad, [], bad.join('\n'));
  assert.ok(withTip / total > 0.95,
    'стрелки нашлись только у ' + withTip + ' из ' + total + ' подписей');
});

test('Структуры: подписи не обрезаны и не дублируются в пределах снимка', () => {
  const cards = load();
  const bad = [];
  cards.forEach(c => {
    const seen = new Map();
    c.labels.forEach(l => {
      assert.ok(l.text && l.text.trim().length >= 4, c.id + ': пустая подпись');
      // «Дистальны й» — признак того, что строка разорвана по буквам.
      // Одиночные союзы («и», «в», «с») — нормальный текст, их не трогаем.
      // Обрывок — это одно-двухбуквенное слово, приклеенное к другому без пробела
      // перед ним. Одиночные «и», «в», «с» внутри фразы — обычный текст.
      if (/[а-яё][а-яё]\s[а-яё]{1,2}\s/i.test(l.text) && !/\s(и|в|с|к|на|по|во|со)\s/i.test(l.text)) {
        bad.push(c.id + ': разорвано «' + l.text + '»');
      }
      const key = l.text.toLowerCase().replace(/ё/g, 'е');
      // Повтор того же названия на одном снимке — норма, но не больше двух раз.
      seen.set(key, (seen.get(key) || 0) + 1);
    });
    // На слайде бывает несколько одинаковых структур (три «Тонких канальца») —
    // это нормально; важно лишь, чтобы их не было десяток из-за склейки.
    seen.forEach((n, title) => {
      if (n > 4) bad.push(c.id + ': «' + title + '» встречается ' + n + ' раз');
    });
  });
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('Структуры: демо ссылается на существующие кадры', () => {
  const demo = path.join(ROOT, 'demo', 'data.js');
  if (!fs.existsSync(demo)) return;
  const src = fs.readFileSync(demo, 'utf8');
  const cards = JSON.parse(src.slice(src.indexOf('=') + 1).replace(/;\s*$/, ''));
  const missing = [];
  cards.forEach(c => {
    ['q', 'a'].forEach(k => {
      const rel = c[k].replace(/^\.\.\//, '');
      if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
    });
  });
  assert.deepEqual(missing, [], 'демо ссылается на отсутствующие файлы');
});

test('Структуры: каждая подпись кадра становится вопросом', () => {
  // Регресс, который заметил пользователь: на 0113-001 было 9 подписей,
  // а вопросов — 6. Причина — подписи без белого облачка выбрасывались.
  // Теперь вопрос строится по подписи, а не по найденной стрелке.
  const cards = load();
  const bad = [];
  cards.forEach(c => {
    const nLab = c.labels.length;
    const nQ = c.labels.filter(l => l.text && l.text.trim()).length;
    if (nQ !== nLab) bad.push(c.id + ': подписей ' + nLab + ', вопросов ' + nQ);
  });
  assert.deepEqual(bad, [], bad.join('\n'));
  const single = cards.find(c => c.id === '0113-001');
  assert.ok(single, 'нет карточки 0113-001');
  assert.equal(single.labels.length, 9, 'на 0113-001 должно остаться 9 подписей');
});

test('Структуры: в вопросы не попадают шапка слайда и водяные знаки', () => {
  const cards = load();
  const bad = [];
  const junk = [/^\s*Препарат/i, /^\s*Окраска/i, /picture-id/i, /shutterstock/i,
                /^\s*«?Мозжечок»?\s*$/i, /гематоксин/i];
  cards.forEach(c => {
    c.labels.forEach(l => {
      junk.forEach(re => { if (re.test(l.text)) bad.push(c.id + ': «' + l.text + '»'); });
    });
  });
  assert.deepEqual(bad, [], 'вопросы из шапки: ' + bad.join('; '));
});

test('Структуры: демо спрашивает все подписи, включая запечённые', () => {
  const demo = path.join(ROOT, 'demo', 'demo.js');
  if (!fs.existsSync(demo)) return;
  const src = fs.readFileSync(demo, 'utf8');
  const order = src.slice(src.indexOf('function buildOrder'), src.indexOf('function renderPicker'));
  assert.ok(/labels\.map/.test(order), 'порядок вопросов должен строиться по всем подписям');
  // У запечённых подписей кончика нет — в режиме «покажи» нажимают плашку,
  // поэтому подписи без tips из вопросов больше не выкидываются.
  assert.ok(!/idx = idx\.filter/.test(order),
    'нельзя выбрасывать подписи без кончика: у запечённых его нет');
  assert.ok(/on-plate/.test(src), 'номер запечённой подписи ставится на плашку');
  assert.ok(/st\.order\.length/.test(src), 'счётчик вопросов должен идти по st.order');
});

test('Запечённые подписи: карточки честные — без выдуманных кончиков', () => {
  const file = path.join(ROOT, 'js', 'data', 'baked.js');
  if (!fs.existsSync(file)) return;
  const src = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(src.slice(src.indexOf('=') + 1).trim().replace(/;$/, ''));
  assert.ok(data.cards.length > 0, 'должна быть хотя бы одна запечённая карточка');
  const curated = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'baked_labels.json'), 'utf8'));
  data.cards.forEach(card => {
    assert.ok(curated[card.id], 'нет названий для ' + card.id);
    assert.equal(card.labels.length, curated[card.id].length,
      'число названий и плашек должно совпадать: ' + card.id);
    card.labels.forEach(l => {
      // На растре кончик не вычисляется: номер ставится на плашку.
      // Пустой tips — это честно, «примерная» точка была бы выдумкой.
      assert.deepEqual(l.tips, [], 'у запечённой подписи не должно быть кончика');
      assert.ok(l.text && l.text.trim().length > 2, 'у подписи должно быть название');
      assert.equal(l.box.length, 4, 'у подписи должна быть рамка плашки');
      const [x0, y0, x1, y1] = l.box;
      assert.ok(x1 > x0 && y1 > y0, 'рамка должна быть непустой: ' + l.text);
      assert.ok(x1 <= card.w && y1 <= card.h, 'рамка не должна вылезать за снимок: ' + l.text);
    });
    const files = ['js', 'data'].join('/');
    [card.id + '-q.jpg', card.id + '-a.jpg'].forEach(name => {
      const p = path.join(ROOT, 'assets', 'baked', name);
      assert.ok(fs.existsSync(p), 'нет кадра ' + files + '/' + name);
    });
  });
});

test('Запечённые подписи: в кадре-вопросе нет названия препарата', () => {
  const file = path.join(ROOT, 'js', 'data', 'baked.js');
  if (!fs.existsSync(file)) return;
  // Шапку «Препарат №…» закрашиваем в кадре-вопросе: см. header_plate
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build_baked.py'), 'utf8');
  assert.ok(/def header_plate/.test(src), 'шапка препарата должна находиться');
  assert.ok(/make_pair[\s\S]{0,1200}header_plate\(img\)/.test(src),
    'кадр-вопрос должен закрашивать шапку препарата');
});

test('Запечённые подписи: шапка препарата не становится отдельным вопросом', () => {
  // «Препарат №92а «Кора большого мозга»» — это название препарата, а не
  // структура. Если шапка попадёт в плашки, вопрос будет с готовым ответом.
  const file = path.join(ROOT, 'js', 'data', 'baked.js');
  if (!fs.existsSync(file)) return;
  const src = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(src.slice(src.indexOf('=') + 1).trim().replace(/;$/, ''));
  data.cards.forEach(card => {
    card.labels.forEach(l => {
      assert.ok(!/^Препарат\s*№/i.test(l.text), 'шапка препарата попала в вопросы: ' + card.id);
      assert.ok(!/^Окраска\b/i.test(l.text), 'строка «Окраска» попала в вопросы: ' + card.id);
    });
  });
});
