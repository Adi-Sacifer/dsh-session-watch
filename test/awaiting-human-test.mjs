#!/usr/bin/env node
'use strict';
/*
 * awaiting-human-test.mjs - a session waiting for ITS USER is not stuck.
 *
 * THE FAILURE THIS PINS, measured on a real conversation
 *
 *   【会话监视】另一个对话卡住了 · 原因：卡在工具 ask_user_question 上，已经 313 秒没有返回
 *   要我：① 去看一眼现状 ② 什么都不做让它继续 ③ 试试把它打断？
 *
 *   The session was not stuck. It had asked its user "Agent 接口做哪一层？" and was waiting for an
 *   answer - a person is allowed to think for ten minutes. Two things were wrong with that alarm:
 *
 *     1. It was false. The turn was open, healthy, and doing exactly what it should.
 *     2. Worse, its advice was self-defeating. "① 去看一眼" is the very action that ANSWERS the
 *        question, so the notice was asking the user to click it, then click again. A watchdog whose
 *        remedy is a second notification has invented work.
 *
 * This is a different case from a slow tool. There the budget is knowable and the tool declares it
 * (budget-hold-test.mjs). Here there is no budget and no honest upper bound: silence is not evidence
 * of trouble, it is evidence that nobody has answered yet.
 *
 * Usage: node test/awaiting-human-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-human-'));
process.env.DSH_HOME = ROOT;   // before the first import: index.js reads it at module load
let instance = 0;
const freshPlugin = () => import(`../plugin/index.js?human=${++instance}`);

const WS = '--C-Users-test-project--';
let seq = 0;
const rec = (type, data, at) => ({ type, seq: ++seq, time: at, data });

/** An unmatched tool/call: `toolName`, silent for `quietMs`. */
function writePendingTool(id, toolName, quietMs, args = {}) {
  const mtime = Date.now() - quietMs;
  const dir = path.join(ROOT, 'sessions', WS, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat([
    rec('turn/start', { turn: 1 }, mtime - 60_000),
    rec('tool/call', { turn: 1, step: 1, callId: 'c1', name: toolName, arguments: JSON.stringify(args) }, mtime),
  ].map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')))));
  const when = new Date(mtime);
  fs.utimesSync(file, when, when);
}

let pass = 0;
const failures = [];
const check = (label, actual, expected) => {
  if (actual === expected) { pass++; return; }
  failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

async function scenario(roots, config = {}) {
  const state = { routes: {}, delivered: [], logged: [] };
  const registry = roots.map((id) => ({ id, followup(m) { state.delivered.push({ to: id, message: m }); } }));
  const ctx = {
    interval: (fn) => { state.tick = fn; return () => { }; },
    timeout: () => () => { },
    webServer: { register: (r) => { state.routes[`${r.method} ${r.path}`] = r; return () => { }; } },
    emit: () => { }, on: () => () => { },
    logger: { info: (m) => state.logged.push(m), warn: (m) => state.logged.push('WARN ' + m) },
    agents: { roots: () => registry, get: (id) => registry.find((a) => a.id === id) },
  };
  const plugin = await freshPlugin();
  plugin.apply(ctx, { intervalSeconds: 15, staleSeconds: 300, windowMinutes: 1440, ...config });
  const snapshot = () => {
    const key = Object.keys(state.routes).find((k) => /^GET \/session-watch\/state-.*\.json$/.test(k));
    let s = null;
    state.routes[key].handler({}, { writeHead: () => { }, end: (b) => { s = JSON.parse(b); } });
    return s;
  };
  const cleanup = () => { try { fs.rmSync(path.join(ROOT, 'sessions'), { recursive: true, force: true }); } catch { } };
  return { state, snapshot, cleanup };
}

const stateOf = (served, id) => served.sessions.find((s) => s.id === id)?.state;
const MIN = 60_000;

/* ---- the measured case: silent 313s on ask_user_question ------------------------------------- */
{
  const s = await scenario(['observer']);
  writePendingTool('sess-asking', 'ask_user_question', 313 * 1000, {
    questions: [{ id: 'agent_scope', header: 'Agent 接口做哪一层' }],
  });
  s.state.tick();
  const served = s.snapshot();

  check('a session waiting on its user is not stuck', stateOf(served, 'sess-asking'), 'waiting-for-human');
  check('...it is not in the stuck list', served.stuck.some((r) => r.id === 'sess-asking'), false);
  check('...nobody is woken about it', s.state.delivered.length, 0);
  check('...the snapshot counts it separately', served.waitingForHuman, 1);
  check('...and it is reported as its own signal',
    served.sessions.find((r) => r.id === 'sess-asking')?.state, 'waiting-for-human');
  s.cleanup();
}

/* ---- the wait does not expire: a person may think for a long time ----------------------------- */
{
  const s = await scenario(['observer']);
  writePendingTool('sess-thinking', 'ask_user_question', 90 * MIN, { questions: [{ id: 'q' }] });
  s.state.tick();
  const served = s.snapshot();
  check('90 minutes of waiting is still waiting, not stuck', stateOf(served, 'sess-thinking'), 'waiting-for-human');
  check('...and still wakes nobody', s.state.delivered.length, 0);
  s.cleanup();
}

/* ---- an ordinary long tool is NOT excused by this rule ---------------------------------------- */
{
  const s = await scenario(['observer']);
  writePendingTool('sess-real-tool', 'pwsh', 90 * MIN, { command: 'node tools/cdp-group.mjs' });
  s.state.tick();
  const served = s.snapshot();
  check('a non-human tool silent for 90min is still stuck', stateOf(served, 'sess-real-tool'), 'stuck');
  check('...and it IS reported', s.state.delivered.length >= 1, true);
  s.cleanup();
}

/* ---- waiting on a human must not silence the rest of the watchdog ----------------------------- */
{
  const s = await scenario(['observer']);
  writePendingTool('sess-asking', 'ask_user_question', 20 * MIN, { questions: [{ id: 'q' }] });
  writePendingTool('sess-hung', 'pwsh', 20 * MIN, { command: 'node deploy.mjs' });
  s.state.tick();
  const served = s.snapshot();
  check('the hung tool is still caught alongside the waiting one', stateOf(served, 'sess-hung'), 'stuck');
  check('...and the waiting one is not', stateOf(served, 'sess-asking'), 'waiting-for-human');
  check('...the report is about the hang, not the wait',
    s.state.delivered.every((d) => String(d.message?.content?.[0]?.text ?? '').includes('sess-hung')), true);
  check('...the counts agree with the rows', served.waitingForHuman, 1);
  s.cleanup();
}

/* ---- a session waiting on a human is BUSY: never a recipient ---------------------------------- */
{
  const s = await scenario(['waiter', 'other']);
  /* the waiter is itself the one waiting on its user */
  writePendingTool('sess-victim', 'pwsh', 30 * MIN, { command: 'node deploy.mjs' });
  writePendingTool('waiter', 'ask_user_question', 30 * MIN, { questions: [{ id: 'q' }] });
  s.state.tick();
  const served = s.snapshot();
  check('a conversation waiting on its user is not woken about someone else',
    s.state.delivered.some((d) => d.to === 'waiter'), false);
  check('...the free conversation is told instead',
    s.state.delivered.some((d) => d.to === 'other'), true);
  s.cleanup();
}

console.log(`sandbox: ${ROOT}`);
console.log(`${pass} assertion(s) passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
fs.rmSync(ROOT, { recursive: true, force: true });
