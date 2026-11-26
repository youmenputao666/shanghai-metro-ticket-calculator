// 用 CDP 精确模拟移动端视口后截图（headless Chrome 的 --window-size 有最小宽度限制）
// 用法: node shot.mjs <url> <width> <height> <out.png> [mobile=true]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, w, h, out, mobileArg] = process.argv.slice(2);
const width = Number(w), height = Number(h);
const mobile = mobileArg !== 'false';
const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].find(p => fs.existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome / Edge，请用环境变量 CHROME_PATH 指定浏览器可执行文件');
  process.exit(1);
}
const profile = path.join(os.tmpdir(), 'shmetro-shot-' + process.pid);
const port = 9333 + Math.floor(Math.random() * 200);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: path.startsWith('/json/new') ? 'PUT' : 'GET' });
  return res.json();
}

async function waitPort() {
  for (let i = 0; i < 100; i++) {
    try { await getJSON('/json/version'); return; } catch { await sleep(100); }
  }
  throw new Error('chrome devtools port not ready');
}

await waitPort();
const target = await getJSON(`/json/new?${encodeURIComponent(url)}`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, m => (m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
if (process.argv[7] === 'print') await send('Emulation.setEmulatedMedia', { media: 'print' });
await send('Page.navigate', { url });
await sleep(1200);
const metrics = await send('Page.getLayoutMetrics');
const css = metrics.cssContentSize;
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width, height: Math.ceil(css.height), scale: 1 }
});
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(out, 'ok, contentWidth=', css.width, 'contentHeight=', css.height);
ws.close();
chrome.kill();
process.exit(0);
