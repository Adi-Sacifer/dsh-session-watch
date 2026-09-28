#!/usr/bin/env node
'use strict';
/*
 * notice-render.mjs - render notice.js in a REAL browser and assert what it draws.
 *
 * WHY
 *   Every other test in this repo checks behaviour in Node. The notice runs in a browser, and the
 *   one claim that mattered most - "does it actually draw a notice on screen" - could not be settled
 *   by Node tests at all. Asserting that a source file contains a string is not evidence that the
 *   element renders.
 *
 * HOW
 *   A throwaway local HTTP server plays both roles the real one plays: it serves notice.js with a
 *   script tag carrying a data-session-watch-state attribute, and it answers that route with
 *   synthetic state. So notice.js runs against the same relative-URL contract it uses in production,
 *   with no Host, no auth and no restart. A headless Edge connects over CDP, the page is loaded, and
 *   the DOM is read back.
 *
 * Cases covered: nothing flagged (no element at all), one flagged, many flagged (the overflow line),
 * dismissal, recovery (element removed), and the host reporting it cannot read (must say so, not
 * stay silent - a silent monitor is indistinguishable from a healthy one).
 *
 * Usage: node test/notice-render.mjs [--port 8791] [--edge <path>]
 *   Skips with a clear message (exit 0) when no browser is available, so it never blocks a suite.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeNoticeInjection } from '../plugin/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOTICE = path.join(here, '..', 'plugin', 'notice.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', 8791));
const CDP_PORT = Number(arg('cdp', 8792));

const EDGE_CANDIDATES = [
  arg('edge', ''),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const edgePath = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!edgePath) {
  console.log('notice-render: no Edge found; skipping browser rendering check (not a failure)');
  process.exit(0);
}

/* ------------------------------------------------------------------ state fixtures */

const idle = { available: true, staleSeconds: 300, counts: { stuck: 0 }, stuck: [], sessions: [] };

const oneStuck = {
  available: true,
  staleSeconds: 300,
  counts: { stuck: 1 },
  stuck: [{ id: 'sess-a', title: '继续 ai-lover 并运行测试修复问题', quietSeconds: 612, tail: 'tool/call(pwsh)' }],
  sessions: [],
};

const sixStuck = {
  available: true,
  staleSeconds: 300,
  counts: { stuck: 6 },
  stuck: Array.from({ length: 6 }, (_, i) => ({ id: `sess-${i}`, title: `会话 ${i}`, quietSeconds: 400 + i, tail: 'tool/call(bash)' })),
  sessions: [],
};

const unavailable = {
  available: false,
  reason: 'zstd decompression unavailable in this runtime (node 20.0.0); the plugin cannot read transcripts',
  staleSeconds: 300,
  counts: { stuck: 0 },
  stuck: [],
  sessions: [],
};

let CURRENT = idle;

/* ------------------------------------------------------------------ servers */

const noticeSource = fs.readFileSync(NOTICE, 'utf8');
const scriptTag = (statePath) => `<script src="/plugin/notice.js" data-session-watch-state="${statePath}" defer></script>`;
const injectedScript = makeNoticeInjection('/plugin/notice.js', '/live/state.json', '/live/watcher.json').text;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/page.html') {
    const body = `<!doctype html><html><head><meta charset="utf-8"><title>notice test</title></head><body>${scriptTag('/live/state.json')}</body></html>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }
  if (url.pathname === '/injected.html') {
    const body = `<!doctype html><html><head><meta charset="utf-8"><title>injected notice test</title></head><body><main id="shell-marker">shell intact</main><script>${injectedScript}</script></body></html>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }
  if (url.pathname === '/plugin/notice.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(noticeSource);
    return;
  }
  if (url.pathname === '/live/state.json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(CURRENT));
    return;
  }
  res.writeHead(404).end('nope');
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/* ------------------------------------------------------------------ CDP plumbing */

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-edge-'));
const edge = spawn(edgePath, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('headless Edge did not open a CDP port');
}

let pass = 0;
const failures = [];
const check = (label, actual, expected) => {
  if (actual === expected) { pass++; return; }
  failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

async function main() {
  await waitForCdp();

  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate threw');
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  const reload = async () => {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/page.html` });
    await sleep(900);   // the notice polls immediately on load; give it a beat
  };

  /* read the notice element state back out of the live DOM */
  const readNotice = () => evaluate(`(() => {
    const el = document.getElementById('session-watch-notice');
    if (!el) return { present: false };
    return {
      present: true,
      head: el.querySelector('.sw-head') ? el.querySelector('.sw-head').textContent : null,
      rows: el.querySelectorAll('.sw-row').length,
      text: el.innerText,
      hasClose: Boolean(el.querySelector('.sw-x')),
    };
  })()`);

  /* 1. nothing flagged -> the element must not exist at all */
  CURRENT = idle;
  await reload();
  const r1 = await readNotice();
  check('idle: no notice element exists', r1.present, false);

  /* 2. one flagged -> a notice naming the session, its silence and its tail */
  CURRENT = oneStuck;
  await reload();
  const r2 = await readNotice();
  check('one stuck: notice renders', r2.present, true);
  check('one stuck: headline says one', r2.head, '1 个会话可能卡住了');
  check('one stuck: names the session', String(r2.text).includes('继续 ai-lover'), true);
  check('one stuck: shows the silence duration', String(r2.text).includes('612s'), true);
  check('one stuck: shows the tail', String(r2.text).includes('tool/call(pwsh)'), true);
  check('one stuck: shows the rule', String(r2.text).includes('300s'), true);
  check('one stuck: offers dismissal', r2.hasClose, true);

  /* 3. many flagged -> capped at four rows plus an overflow line */
  CURRENT = sixStuck;
  await reload();
  const r3 = await readNotice();
  check('six stuck: headline counts them', r3.head, '6 个会话可能卡住了');
  check('six stuck: at most four detail rows', r3.rows, 4);
  check('six stuck: says how many more', String(r3.text).includes('还有 2 个'), true);

  /* 4. recovery -> the element is removed again */
  CURRENT = idle;
  await evaluate(`fetch('/live/state.json', {cache:'no-store'}).then(r=>r.json())`);   // just touch it
  await sleep(300);
  CURRENT = idle;
  /* force the poller to run by waiting one interval */
  await sleep(5300);
  const r4 = await readNotice();
  check('recovery: notice is removed once nothing is flagged', r4.present, false);

  /* 5. the host cannot read -> must say so rather than stay silent */
  CURRENT = unavailable;
  await sleep(5300);
  const r5 = await readNotice();
  check('unavailable: notice appears even with zero stuck', r5.present, true);
  check('unavailable: states it is not working', String(r5.text).includes('没有在工作'), true);
  check('unavailable: carries the host reason', String(r5.text).includes('zstd'), true);

  /* 6. dismissal hides it */
  await evaluate(`document.querySelector('#session-watch-notice .sw-x').click()`);
  await sleep(200);
  const r6 = await readNotice();
  check('dismissal: element removed after clicking close', r6.present, false);

  /* The actual index-injection code must load the notice without rewriting the shell. */
  CURRENT = oneStuck;
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/injected.html` });
  await sleep(900);
  const injected = await readNotice();
  check('injected: notice renders', injected.present, true);
  check('injected: shell content remains', await evaluate(`document.getElementById('shell-marker')?.textContent`), 'shell intact');
  check('injected: script loader exists', await evaluate(`Boolean(document.getElementById('session-watch-notice-loader'))`), true);

  ws.close();
}

try {
  await main();
} catch (error) {
  failures.push(`harness error: ${error?.message ?? error}`);
} finally {
  /*
   * Kill every process holding THIS test's profile directory.
   *
   * `edge.kill()` on the spawned handle is not enough, and neither is a tree kill: on Windows the
   * launcher re-execs and exits, so the real Edge is re-parented away from the pid Node owns. A tree
   * kill then reaps the launcher's (already empty) tree and leaves the browser and its gpu, network,
   * storage, renderer and crashpad children running - measured at 11 surviving processes from one run,
   * and 90 after a few runs, at which point they fight over the CDP port and make the next run fail
   * for reasons that have nothing to do with the notice.
   *
   * The profile path is the one handle that stays with every process of this instance, and it is
   * unique per run (`mkdtemp`), so matching on it cannot touch a browser the user has open. That is
   * the whole reason this is safe to do from a test.
   */
  const killProfileProcesses = () => new Promise((resolve) => {
    if (process.platform !== 'win32') { try { edge.kill(); } catch { } resolve(); return; }
    const ps = [
      "$procs = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | " +
      `Where-Object { $_.CommandLine -like '*${profileDir}*' }; ` +
      'foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
    ].join('');
    const killer = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
    killer.on('close', resolve);
    killer.on('error', () => { try { edge.kill(); } catch { } resolve(); });
  });

  await killProfileProcesses();
  try { edge.kill(); } catch { }
  server.close();
  await sleep(300);
  /*
   * Removing Edge's profile dir must not be able to destroy the RESULT.
   *
   * Measured: Edge (or a helper it spawned) can still hold the directory a moment after kill, and
   * rmSync then throws EPERM. Unhandled, that exception propagated out of this `finally`, so the
   * process died BEFORE the summary below printed - the run showed a stack trace instead of "19
   * assertions passed", and looked like a broken build when every assertion had in fact passed.
   * A test whose cleanup can erase its own verdict is worse than no test, so this retries and then
   * gives up quietly: a leftover temp directory is untidy, not a failure.
   */
  for (let attempt = 0; attempt < 5; attempt++) {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); break; }
    catch { await sleep(250 * (attempt + 1)); }
  }
}

console.log(`notice-render: real browser check on port ${PORT}`);
console.log(`${pass} assertion(s) passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
