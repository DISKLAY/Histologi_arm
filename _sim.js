const { JSDOM } = require('jsdom'); const fs=require('fs');
const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{runScripts:'outside-only',url:'http://localhost/'});
const w=dom.window; w.scrollTo=()=>{}; w.HTMLElement.prototype.scrollTo=()=>{};
w.eval(fs.readFileSync('js/data/preparations.js','utf8'));
w.eval(fs.readFileSync('js/app.js','utf8'));
w.location.hash='#/atlas'; w.dispatchEvent(new w.HashChangeEvent('hashchange'));
const report=[];
for (const g of w.HISTO_DATA.groups) {
  const card=w.document.querySelector(`[data-action="open-group"][data-gid="${g.id}"]`);
  if (!card) continue;
  card.click();
  const shots=[...w.document.querySelectorAll('.modal__shot img')].map(i=>i.getAttribute('src'));
  const seen=new Set(), dup=shots.filter(s=>{ if(seen.has(s)) return true; seen.add(s); return false; });
  if (dup.length) report.push([g.id, shots.length, new Set(shots).size]);
  w.document.querySelector('[data-action="close-modal"]').click();
}
console.log('групп с повторяющимся снимком в галерее:', report.length);
report.slice(0,10).forEach(r=>console.log('  ', r[0], 'показано', r[1], 'уникальных', r[2]));
