// 浏览器内交互验证：改日期/票价/节假日、切换次卡方案，检查页面是否随之更新
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = [
  'index.html',
  '上海地铁计次票划算计算器.html',
  '../上海地铁计次票划算计算器.html',
  '../index.html'
].map(p => path.resolve(here, p)).find(p => fs.existsSync(p));
if (!htmlPath) { console.error('找不到计算器 HTML'); process.exit(1); }
const URL = 'file:///' + htmlPath.replace(/\\/g, '/');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = path.join(os.tmpdir(), 'shmetro-interact-' + process.pid);
const port = 9500 + Math.floor(Math.random() * 200);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(p, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method });
  return res.json();
}
for (let i = 0; i < 100; i++) { try { await call('/json/version'); break; } catch { await sleep(100); } }
const target = await call(`/json/new?${encodeURIComponent(URL)}`, 'PUT');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, m => m.error ? rej(new Error(method + ' ' + JSON.stringify(m.error))) : res(m.result));
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable'); await send('Runtime.enable');
await sleep(1200);

const errors = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text || 'exception');
});

async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('JS error: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

const results = [];
const check = (name, ok, detail) => { results.push((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + String(detail).replace(/\n/g, ' ') : '')); };

// 初始状态：默认 31 天（官方：激活当日及之后 30 个自然日），45 次卡 215 比全直刷 216 省 1 → 「推荐购买」
let v = await evalJS(`({ verdict: document.querySelector('#verdict').innerText.slice(0,40), stats: document.querySelectorAll('#stats .tile')[0].innerText })`);
check('默认 31 天：推荐购买', /推荐购买/.test(v.verdict), v.verdict);
check('默认 31 天：23 个工作日', /23/.test(v.stats), v.stats);
const noSelect = await evalJS(`!document.querySelector('#validity')`);
check('有效期不再有 31/30 选择框', noSelect === true);

// 改激活日期 -> 2026-02-10（春节）
await evalJS(`(()=>{const d=document.querySelector('#activationDate'); d.value='2026-02-10'; d.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await sleep(400);
let feb = await evalJS(`({ stats: document.querySelectorAll('#stats .tile')[0].innerText, verdict: document.querySelector('#verdict').innerText.slice(0,60) })`);
check('春节窗口 19 个工作日', /19/.test(feb.stats), feb.stats);
check('春节窗口不建议购买', /不建议购买/.test(feb.verdict), feb.verdict);

// 票价 6 元：35 次卡 208 应变成推荐
await evalJS(`(()=>{const f=document.querySelector('#fare'); f.value='6'; f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(400);
let f6 = await evalJS(`document.querySelector('#verdict').innerText.slice(0,160)`);
check('票价 6 元后推荐 35 次卡 208', /推荐购买/.test(f6) && /208\.00/.test(f6) && /35次/.test(f6), f6);

// 恢复 12-01 / 5 元
await evalJS(`(()=>{const d=document.querySelector('#activationDate'); d.value='2026-12-01'; d.dispatchEvent(new Event('change',{bubbles:true})); const f=document.querySelector('#fare'); f.value='5'; f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(400);
let back = await evalJS(`document.querySelector('#verdict').innerText.slice(0,40)`);
check('恢复默认参数（推荐 45 次卡）', /推荐购买/.test(back), back);

// localStorage 是否记住
const saved = await evalJS(`localStorage.getItem('shmetro-pass-calc/v1')`);
check('参数已写入 localStorage', !!saved && saved.includes('2026-12-01'), String(saved).slice(0, 80));

// 节假日文本错误提示（calStatus 在折叠区，用 textContent）
await evalJS(`(()=>{const t=document.querySelector('#calText'); t.value='2026-13-01 元旦'; t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(400);
let errState = await evalJS(`({ status: document.querySelector('#calStatus').textContent, warn: document.querySelector('#warnings').textContent })`);
check('非法日期给出提示', /无法解析/.test(errState.status) && /无法解析/.test(errState.warn), errState.status);

// 恢复日历
await evalJS(`document.querySelector('#calReset').click()`);
await sleep(400);
let restored = await evalJS(`document.querySelector('#calStatus').textContent`);
check('恢复默认节假日', /2025、2026、2027/.test(restored), restored);

// 日历默认按「纯刷卡」
const cal = await evalJS(`(()=>{
  const box = document.querySelector('#dayCalendar');
  const days = box.querySelectorAll('.dc-day');
  const tabs = [...box.querySelectorAll('.plan-tab')].map(b => b.textContent + '|' + b.classList.contains('is-active'));
  const cost = [...box.querySelectorAll('.dc-day .c')].map(e=>e.textContent);
  const spendSum = cost.reduce((s,t)=>s+parseFloat(t.replace('¥','')),0);
  return {
    days: days.length,
    tabs,
    cardLines: box.querySelectorAll('.dc-day .u.is-card').length,
    cashLines: box.querySelectorAll('.dc-day .u.is-cash').length,
    spendSum: Math.round(spendSum*10)/10,
    summary: box.querySelector('.dc-mhead .msub').textContent,
    cost: box.querySelector('.plan-cost').textContent
  };
})()`);
check('日历覆盖整月天数', cal.days === 31, 'cells=' + cal.days);
check('方案标签 5 个（纯刷卡 + 四种次卡）', cal.tabs.length === 5, cal.tabs.join(' / '));
check('默认高亮 45 次卡（最省方案）', /^45次卡/.test(cal.tabs[2]) && /true/.test(cal.tabs[2]), cal.tabs[2]);
check('默认日历：次卡 23 天 + 刷卡 1 天', cal.cardLines === 23 && cal.cashLines === 1, 'card=' + cal.cardLines + ' cash=' + cal.cashLines);
check('默认日历支出 215', /支出 ¥215\.00/.test(cal.summary), cal.summary);

// 切换到 45 次卡
await evalJS(`document.querySelectorAll('#dayCalendar .plan-tab')[2].click()`);
await sleep(300);
const c45 = await evalJS(`(()=>{
  const box = document.querySelector('#dayCalendar');
  const cost = [...box.querySelectorAll('.dc-day .c')].map(e=>e.textContent);
  const spendSum = cost.reduce((s,t)=>s+parseFloat(t.replace('¥','')),0);
  return {
    active: box.querySelector('.plan-tab.is-active').textContent,
    cardLines: box.querySelectorAll('.dc-day .u.is-card').length,
    cashLines: box.querySelectorAll('.dc-day .u.is-cash').length,
    spendSum: Math.round(spendSum*10)/10,
    cost: box.querySelector('.plan-cost').textContent,
    note: box.querySelector('.plan-note').textContent,
    summary: box.querySelector('.dc-mhead .msub').textContent,
    monthly: document.querySelector('#monthly').innerText.slice(0,60)
  };
})()`);
check('45 次卡方案按天：23 天次卡 + 1 天刷卡', /45次卡/.test(c45.active) && c45.cardLines === 23 && c45.cashLines === 1, JSON.stringify({ active: c45.active, card: c45.cardLines, cash: c45.cashLines }));
check('45 次卡成本 215（次卡 ¥210 + 直刷 1 次 ¥5）', /次卡 45 次 ¥210\.00/.test(c45.cost) && /直刷 1 次 ¥5\.00/.test(c45.cost), c45.cost);
check('45 次卡逐日合计≈215', Math.abs(c45.spendSum - 215) <= 1.2, 'sum=' + c45.spendSum);
check('45 次卡提示「其余 1 次照常刷卡」', /其余 1 次照常刷卡/.test(c45.note), c45.note);
check('月度明细跟随所选方案', /45次卡/.test(c45.monthly), c45.monthly);

// 切回纯刷卡
await evalJS(`document.querySelectorAll('#dayCalendar .plan-tab')[0].click()`);
await sleep(300);
const backBase = await evalJS(`(()=>{const b=document.querySelector('#dayCalendar');return {card:b.querySelectorAll('.dc-day .u.is-card').length, cash:b.querySelectorAll('.dc-day .u.is-cash').length, active:b.querySelector('.plan-tab.is-active').textContent};})()`);
check('可切回纯刷卡', /纯刷卡/.test(backBase.active) && backBase.card === 0 && backBase.cash === 23, JSON.stringify(backBase));

// 表格里 45 次行应带「最省」徽标
const bestBadge = await evalJS(`(()=>{const rows=[...document.querySelectorAll('#plans tr')];const r=rows.find(x=>/45\\s*次/.test(x.textContent)&&x.querySelector('.badge'));return r?r.querySelector('.badge').textContent:'';})()`);
check('划算时表格推荐 45 次卡', /最省/.test(bestBadge), bestBadge);

// 春节窗口应出现「节」与「班」标记
await evalJS(`(()=>{const d=document.querySelector('#activationDate'); d.value='2026-02-10'; d.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await sleep(400);
const spring = await evalJS(`(()=>{const box=document.querySelector('#dayCalendar');return {hol:box.querySelectorAll('.dc-day .t.hol').length, mk:box.querySelectorAll('.dc-day .t.mk').length, names:[...box.querySelectorAll('.dc-day .nm')].map(e=>e.textContent).slice(0,6)};})()`);
check('春节窗口显示节假日与调休', spring.hol === 9 && spring.mk === 2, JSON.stringify(spring));

// 打印样式存在
const printRule = await evalJS(`[...document.styleSheets[0].cssRules].some(r=>r.cssText.includes('print'))`);
check('打印样式存在', printRule === true);

// 负值/空值容错
await evalJS(`(()=>{const f=document.querySelector('#fare'); f.value=''; f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(400);
let invalid = await evalJS(`document.querySelector('#verdict').innerText.slice(0,40)`);
check('空票价格式提示', /参数有误|请输入/.test(invalid), invalid);

// 恢复默认按钮
await evalJS(`document.querySelector('#resetAll').click()`);
await sleep(300);
let resetOk = await evalJS(`({ fare: document.querySelector('#fare').value, verdict: document.querySelector('#verdict').innerText.slice(0,10) })`);
check('恢复默认按钮生效', resetOk.fare === '5' && /推荐购买/.test(resetOk.verdict), JSON.stringify(resetOk));

// —— 视图切换：单次激活 / 区间排期 ——
const tabs0 = await evalJS(`(()=>({rangeHidden:document.querySelector('#viewRange').hidden, singleHidden:document.querySelector('#viewSingle').hidden, active:document.querySelector('.view-tab.is-active').dataset.view}))()`);
check('默认停在单次激活 tab', tabs0.active === 'single' && tabs0.rangeHidden === true && tabs0.singleHidden === false, JSON.stringify(tabs0));

await evalJS(`document.querySelector('.view-tab[data-view="range"]').click()`);
await sleep(900);
const tabs1 = await evalJS(`(()=>({rangeHidden:document.querySelector('#viewRange').hidden, singleHidden:document.querySelector('#viewSingle').hidden, active:document.querySelector('.view-tab.is-active').dataset.view}))()`);
check('切到区间排期 tab 并渲染', tabs1.active === 'range' && tabs1.rangeHidden === false && tabs1.singleHidden === true, JSON.stringify(tabs1));

// —— 错峰排期：先直刷、晚点激活 ——
const schDefault = await evalJS(`(()=>{const b=document.querySelector('#schCard');return {text:b.innerText.slice(0,90), rows:b.querySelectorAll('table tbody tr').length};})()`);
check('排期卡片默认渲染', schDefault.rows >= 4, JSON.stringify(schDefault));

await evalJS(`(()=>{const set=(s,v)=>{const el=document.querySelector(s);el.value=v;el.dispatchEvent(new Event('change',{bubbles:true}));};set('#fare','6');set('#schFrom','2027-01-20');set('#schTo','2027-03-31');})()`);
await sleep(1000);
const sch = await evalJS(`(()=>{const b=document.querySelector('#scheduleBody');const t=b.querySelectorAll('table');return {text:b.innerText, names:[...t[1].querySelectorAll('tbody tr')].map(r=>r.cells[0].textContent.trim())};})()`);
check('排期给出 484 的两卡方案', /¥484\.00/.test(sch.text) && /45次卡 \+ 35次卡/.test(sch.text), sch.text.slice(0, 80));
check('排期对比全直刷省 ¥50.60', /省 ¥50\.60/.test(sch.text), sch.text.slice(0, 160));
check('候选表含多种卡种组合', new Set(sch.names).size >= 4, sch.names.join(' / '));
check('排期自动决定张数', /建议买 2 张/.test(sch.text), sch.text.slice(0, 60));

// 逐日安排：哪天用次卡、哪天直刷
const days = await evalJS(`(()=>{const d=document.querySelector('#scheduleBody details.sch-days');return d?{open:d.open, grids:d.querySelectorAll('.dc-grid').length, cards:d.querySelectorAll('.u.is-card').length, cash:d.querySelectorAll('.u.is-cash').length, sum:d.innerText.slice(0,80)}:null;})()`);
check('排期带逐日安排日历', !!days && days.grids >= 2 && days.cards > 0 && days.cash > 0, JSON.stringify(days));

// 一年区间：自动加卡
await evalJS(`(()=>{const set=(s,v)=>{const el=document.querySelector(s);el.value=v;el.dispatchEvent(new Event('change',{bubbles:true}));};set('#schFrom','2026-03-01');set('#schTo','2027-02-28');})()`);
await sleep(1600);
const longRange = await evalJS(`(()=>{const b=document.querySelector('#scheduleBody');return {text:b.innerText.slice(0,220), grids:b.querySelectorAll('.dc-grid').length};})()`);
check('一年区间自动买到 11 张', /建议买 11 张/.test(longRange.text) && /¥2429\.80/.test(longRange.text), longRange.text.replace(/\n/g, ' | ').slice(0, 120));
check('一年区间逐日安排渲染 12 个月', longRange.grids >= 12, 'grids=' + longRange.grids);

// 页面无横向溢出
const overflow = await evalJS(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
check('无横向溢出', overflow <= 0, 'scrollWidth-clientWidth=' + overflow);

check('运行期无 JS 异常', errors.length === 0, errors.join(' | '));

console.log(results.join('\n'));
console.log(results.every(r => r.startsWith('PASS')) ? 'ALL UI CHECKS PASSED' : 'SOME UI CHECKS FAILED');
ws.close(); chrome.kill(); process.exit(0);
