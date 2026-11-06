// A headless Chrome driven over the DevTools protocol (Node's built-in
// WebSocket): load a page or HTML, click and evaluate, save a PNG.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];

export async function launchChrome() {
  const bin = CANDIDATES.find(p => fs.existsSync(p));
  if (!bin) throw new Error('no Chrome/Chromium found');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxtree-shots-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  const proc = spawn(bin, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 100 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (!ver) throw new Error('Chrome did not start');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const waiting = new Map(), listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { const { res, rej } = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; waiting.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
  const once = (method) => new Promise(res => { const l = (m) => { if (m.method === method) { listeners.splice(listeners.indexOf(l), 1); res(m.params); } }; listeners.push(l); });
  await send('Page.enable');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const api = {
    async size(width, height, scale = 2) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }); },
    async goto(url) { const loaded = once('Page.loadEventFired'); await send('Page.navigate', { url }); await loaded; await sleep(300); },
    async html(html, width, height, scale = 2) {
      const f = path.join(dir, `p${Date.now()}${Math.random().toString(36).slice(2)}.html`);
      fs.writeFileSync(f, html);
      await api.size(width, height, scale);
      await api.goto(`file://${f}`);
    },
    async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; },
    async shot(file, clip) {
      const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}), captureBeyondViewport: !!clip });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    sleep,
    async close() { try { ws.close(); } catch {} proc.kill('SIGKILL'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
  return api;
}
