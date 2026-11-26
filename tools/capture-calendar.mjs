// 用 CDP 把页面调成指定激活日（可选切换次卡方案），只截「日历视图」那块卡片。
// 用法：node tools/capture-calendar.mjs 2026-02-10 截图/cal-spring.png [tabIndex]
//   tabIndex：0=纯刷卡，1=35次卡，2=45次卡，3=60次卡，4=90次卡（省略则不点，用默认方案）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file:///' + path.join(here, '..', '上海地铁计次票划算计算器.html').replace(/\\/g, '/');
const date = process.argv[2] || '2026-12-01';
const out = process.argv[3] || path.join(here, '..', '截图', 'calendar.png');
const tab = process.argv[4] === undefined ? null : Number(process.argv[4]);

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9200 + Math.floor(Math.random() * 200);
const profile = path.join(os.tmpdir(), 'shmetro-pass-calc-shot');
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = async (p, m = 'GET') => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json();

for (let i = 0; i < 100; i++) { try { await call('/json/version'); break; } catch { await sleep(100); } }
const target = await call(`/json/new?${encodeURIComponent(pageUrl)}`, 'PUT');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pend.set(id, m => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: pageUrl });
await sleep(1200);
await send('Runtime.evaluate', {
  expression: `(()=>{const d=document.querySelector('#activationDate');d.value='${date}';d.dispatchEvent(new Event('change',{bubbles:true}));})()`
});
await sleep(400);
if (tab !== null) {
  await send('Runtime.evaluate', { expression: `document.querySelectorAll('#dayCalendar .plan-tab')[${tab}].click()` });
  await sleep(400);
}
const box = (await send('Runtime.evaluate', {
  expression: `(()=>{const r=document.querySelector('#dayCalendar').getBoundingClientRect();return {top:r.top+window.scrollY,h:r.height};})()`,
  returnByValue: true
})).result.value;
const shot = await send('Page.captureScreenshot', {
  format: 'png', captureBeyondViewport: true,
  clip: { x: 0, y: Math.max(0, box.top - 8), width: 390, height: box.h + 16, scale: 2 }
});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(out, 'ok', JSON.stringify(box));
ws.close(); chrome.kill(); process.exit(0);
