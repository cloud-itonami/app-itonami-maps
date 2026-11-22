// Real-browser check of the 地図 (Maps) restricted-wasm-v1 build (KOTOBA-159). Not part of `npm test`:
// it needs Chrome. Run after `npm run build`:
//   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node scripts/verify-browser.mjs
// It serves dist/ on 127.0.0.1, drives Chrome over the DevTools protocol, answers the canonical
// consent dialog with trusted input (Input.dispatchMouseEvent) and records every request the page
// makes. It prints one JSON report and exits non-zero when a check fails.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const dist = new URL('../dist/', import.meta.url);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/index.html');
  try {
    const body = await readFile(new URL('.' + path, dist));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const appURL = `http://127.0.0.1:${server.address().port}/`;

const profile = await mkdtemp(join(tmpdir(), 'maps-cdp-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1100,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsURL = await new Promise((resolve, reject) => {
  let err = '';
  chrome.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error('Chrome did not start')), 20000);
});
const targets = await (await fetch(wsURL.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
let seq = 0;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
  else for (const l of listeners) l(msg);
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const requests = [];
const contexts = new Map();
const consoleErrors = [];
// A sandboxed (opaque-origin) iframe runs out of process: it is its own target, attached flat.
const ctxKey = (sessionId, id) => `${sessionId ?? 'page'}:${id}`;
listeners.push((m) => {
  if (m.method === 'Target.attachedToTarget') {
    const sid = m.params.sessionId;
    Promise.all([send('Network.enable', {}, sid), send('Runtime.enable', {}, sid), send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid)])
      .then(() => send('Runtime.runIfWaitingForDebugger', {}, sid)).catch(() => {});
  }
  if (m.method === 'Target.detachedFromTarget') for (const k of [...contexts.keys()]) if (k.startsWith(`${m.params.sessionId}:`)) contexts.delete(k);
  if (m.method === 'Network.requestWillBeSent') requests.push({ url: m.params.request.url, frame: m.params.frameId, session: m.sessionId ?? null });
  if (m.method === 'Runtime.executionContextCreated') contexts.set(ctxKey(m.sessionId, m.params.context.id), { ...m.params.context, sessionId: m.sessionId });
  if (m.method === 'Runtime.executionContextDestroyed') contexts.delete(ctxKey(m.sessionId, m.params.executionContextId));
  if (m.method === 'Runtime.executionContextsCleared') for (const k of [...contexts.keys()]) if (k.startsWith(`${m.sessionId ?? 'page'}:`)) contexts.delete(k);
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
});
await send('Network.enable');
await send('Runtime.enable');
await send('Page.enable');
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
const evalIn = async (context, expression) => {
  if (!context) throw new Error('no such context');
  const r = await send('Runtime.evaluate', { expression, contextId: context.id, awaitPromise: true, returnByValue: true }, context.sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const hostContext = () => [...contexts.values()].find((c) => !c.sessionId && c.auxData?.isDefault && c.origin === appURL.slice(0, -1));
const guestContext = () => [...contexts.values()].filter((c) => c.sessionId && c.auxData?.isDefault).at(-1);
async function waitFor(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error('timeout: ' + label); await sleep(150); }
}
async function trustedClick(selector) {
  const box = await evalIn(hostContext(), `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
}
const lookupStatus = () => evalIn(guestContext(), `document.querySelector('.card p[role=status]')?.textContent ?? ''`);
const dialogOpen = () => evalIn(hostContext(), `!!document.querySelector('dialog[open]')`);
const external = () => requests.filter((r) => !r.url.startsWith(appURL) && !r.url.startsWith('data:') && !r.url.startsWith('about:'));

const report = { appURL, checks: {} };
const check = (name, ok, detail) => { report.checks[name] = { ok: !!ok, detail }; };
const notice = () => evalIn(guestContext(), `document.getElementById('notice').innerText`);
try {
  await send('Page.navigate', { url: appURL });
  await waitFor(async () => guestContext() && await evalIn(guestContext(), `!!document.getElementById('map')`), 'guest ready');
  const frame = await evalIn(hostContext(), `(() => { const f = document.querySelector('#app > iframe'); return { sandbox: f.getAttribute('sandbox'), srcdoc: f.hasAttribute('srcdoc'), src: f.getAttribute('src') }; })()`);
  check('guest is a sandboxed srcdoc iframe', frame.sandbox === 'allow-scripts' && frame.srcdoc && frame.src === null, frame);
  check('guest origin is null', (await evalIn(guestContext(), `self.origin`)) === 'null');
  const direct = await evalIn(guestContext(), `fetch('https://yataverse.com/').then(() => 'sent', (e) => 'refused: ' + e.message)`);
  check('guest cannot fetch (connect-src none)', direct.startsWith('refused'), direct);
  await sleep(800);
  const painted = await evalIn(guestContext(), `(() => { const c = document.getElementById('map'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4 * 97) if (d[i + 3]) n++; return { w: c.width, h: c.height, painted: n }; })()`);
  check('the bundled 1:110m map is drawn', painted.w > 0 && painted.painted > 0, painted);
  await evalIn(guestContext(), `(() => { const i = document.getElementById('search'); i.value = 'Japan'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(300);
  const results = await evalIn(guestContext(), `document.getElementById('results').innerText`);
  check('country search works on the device', /日本|Japan/.test(results), results.slice(0, 120));
  const off = await evalIn(guestContext(), `({ detail: document.getElementById('detail-get').disabled, roads: document.getElementById('roads-get').disabled, ds: document.getElementById('detail-status').textContent, rs: document.getElementById('roads-status').textContent })`);
  check('both downloads are off and say why (Yataverse not declared)', off.detail && off.roads && off.ds.includes('確定していない') && off.rs.includes('確定していない'), off);
  const settings = await evalIn(hostContext(), `document.getElementById('allowed-list').textContent`);
  check('設定 › 許可した送信 says nothing is sent', settings.includes('外部へ送る操作はありません'), settings);
  check('no external request at all', external().length === 0, external().map((r) => r.url));
  check('no uncaught exception', consoleErrors.length === 0, consoleErrors);
} catch (error) {
  check('run', false, String(error?.stack ?? error));
  report.diagnostics = {
    contexts: [...contexts.values()].map((c) => ({ id: c.id, origin: c.origin, isDefault: c.auxData?.isDefault, frame: c.auxData?.frameId, session: c.sessionId ?? null })),
    host: await evalIn(hostContext(), `document.body.innerText.slice(0, 500)`).catch((e) => String(e)),
    errors: consoleErrors,
    guest: await evalIn(guestContext(), `document.body.innerText.slice(0, 1500)`).catch((e) => String(e)),
  };
} finally {
  report.externalRequests = external().map((r) => r.url);
  report.ok = Object.values(report.checks).every((c) => c.ok);
  console.log(JSON.stringify(report, null, 2));
  ws.close(); server.close();
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  chrome.kill(); await exited;
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  process.exitCode = report.ok ? 0 : 1;
}
