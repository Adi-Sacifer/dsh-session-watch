#!/usr/bin/env node
'use strict';
/*
 * budget-hold-test.mjs - a tool that declared a long timeout gets to USE it, but not forever.
 *
 * THE TWO FAILURES THIS PINS, and they are opposite failures
 *
 *   1. The watchdog ignored the declaration entirely. Measured twice on a real session: a `pwsh` call
 *      that said `timeoutMs: 900000` (15 min), then `timeoutMs: 1500000` (25 min), was reported
 *      stuck at ~302s of silence while it was working perfectly. The evidence was sitting in the
 *      transcript the whole time - the call had told everyone how long it intended to take.
 *
 *   2. The obvious fix goes too far. Honouring any declaration means a call that says two hours buys
 *      two hours of silence, and a watchdog that says nothing for two hours is furniture. The user
 *      put it exactly right: "要是他给自己定2h我就白白看着吗".
 *
 * So the rule has three tiers, and every one of them has an assertion here:
 *
 *   declared?   quiet time                          expected
 *   ---------   ---------------------------------   -----------------------------------
 *   none        > staleSeconds                      stuck        (tier 1, unchanged behaviour)
 *   900s        302s                                working      (tier 2, inside its budget)
 *   900s        1400s                               stuck        (tier 2, past budget + margin)
 *   7200s       1700s                               working      (tier 3, capped at 1200s ceiling)
 *   7200s       1900s                               stuck        (tier 3, past ceiling + margin)
 *
 *   BUDGET_GRACE = 1.5, MAX_BUDGET_SECONDS = 1200  =>  honoured limits 1350s and 1800s
 *
 * Usage: node test/budget-hold-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/*
 * ONE DSH_HOME for every scenario, set BEFORE the first import.
 *
 * index.js resolves `SESS_ROOT` at module-load time from `process.env.DSH_HOME`, so a scenario that
 * points DSH_HOME somewhere new AFTER importing is only changing a variable nobody re-reads - the
 * plugin keeps listing the first directory and every session "goes missing". That cost a full debug
 * cycle here: the snapshot came back with an empty `sessions` array while the fixtures sat on disk.
 * Scenarios therefore share the root and use distinct session ids, which is what isolation actually
 * needs; only the module instance has to be fresh.
 */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-budget-'));
process.env.DSH_HOME = ROOT;
let instance = 0;
const freshPlugin = () => import(`../plugin/index.js?budget=${++instance}`);

const WS = '--C-Users-test-project--';
let seq = 0;
const rec = (type, data, at) => ({ type, seq: ++seq, time: at, data });

/** A transcript ending on an unmatched tool/call, optionally declaring its own timeout. */
function writeToolCall(id, quietMs, timeoutMs) {
  const now = Date.now();
  const mtime = now - quietMs;
  const dir = path.join(ROOT, 'sessions', WS, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const args = timeoutMs === null
    ? { command: 'node tools/cdp-group.mjs', description: 'no declared timeout' }
    : { command: 'node tools/cdp-group.mjs', description: 'group suite', timeoutMs };
  fs.writeFileSync(file, Buffer.concat([
    rec('turn/start', { turn: 1 }, mtime - 60_000),
    rec('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify(args) }, mtime),
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
  /* no fresh DSH_HOME here on purpose - see the note above the ROOT constant */
  const state = { routes: {}, delivered: [], logged: [] };
  const registry = roots.map((id) => ({ id, followup(m) { state.delivered.push({ to: id, message: m }); } }));
  const ctx = {
    interval: (fn) => { state.tick = fn; return () => { }; },
    timeout: () => () => { },
    effect: undefined,
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
  /*
   * Cleanup must really clean, because every scenario shares one DSH_HOME (see the ROOT note).
   * Without this, an earlier scenario's fixture is still in the scan window and the next scenario
   * counts its deliveries - which is exactly how "nobody was woken" failed on a correct
   * implementation: it was counting a message sent about a DIFFERENT session.
   */
  const cleanup = () => { try { fs.rmSync(path.join(ROOT, 'sessions'), { recursive: true, force: true }); } catch { } };
  return { state, snapshot, cleanup };
}

const MIN = 60_000;
const stateOf = (served, id) => served.sessions.find((s) => s.id === id)?.state;

/* ---- tier 1: nothing declared -> the old flat rule, unchanged ------------------------------- */
{
  const s = await scenario(['observer']);
  writeToolCall('sess-no-decl', 800 * 1000, null);          // 800s silent, no declaration
  s.state.tick();
  const served = s.snapshot();
  check('no declaration, past staleSeconds -> stuck', stateOf(served, 'sess-no-decl'), 'stuck');
  check('...and it is the strong signal', served.stuck.find((r) => r.id === 'sess-no-decl')?.signal, 'tool-call');
  check('...and there is no budget to hold it', served.sessions.find((r) => r.id === 'sess-no-decl')?.budgetHold ?? null, null);
  check('...and it IS reported, so the watchdog is still alive', s.state.delivered.length >= 1, true);
  s.cleanup();
}

/* ---- tier 2: a sane declaration is honoured ------------------------------------------------- */
{
  const s = await scenario(['observer']);
  /* THE REAL CASE: the call that was flagged at 302s while working fine. */
  writeToolCall('sess-real', 302 * 1000, 900_000);
  s.state.tick();
  const served = s.snapshot();
  check('the 302s/900s call that was falsely flagged is now working', stateOf(served, 'sess-real'), 'working');
  check('...it does not appear in the stuck list', served.stuck.some((r) => r.id === 'sess-real'), false);
  check('...and nobody was woken about it', s.state.delivered.length, 0);
  /* the snapshot says WHY, rather than silently dropping a candidate */
  const hold = served.sessions.find((r) => r.id === 'sess-real')?.budgetHold;
  check('...and the snapshot discloses the held budget', hold?.declaredSeconds, 900);
  check('...with the honoured limit applied (900 * 1.5)', hold?.limitSeconds, 1350);
  s.cleanup();
}

/* ---- tier 2b: past its own budget it IS reported -------------------------------------------- */
{
  const s = await scenario(['observer']);
  writeToolCall('sess-over', 1400 * 1000, 900_000);        // 1400s > 1350s limit
  s.state.tick();
  const served = s.snapshot();
  check('past its own declared budget -> stuck again', stateOf(served, 'sess-over'), 'stuck');
  check('...and it is reported to a conversation', s.state.delivered.length >= 1, true);
  s.cleanup();
}

/* ---- tier 3: THE THING THE USER ASKED ABOUT - a two-hour declaration must not buy silence ----- */
{
  const s = await scenario(['observer']);
  writeToolCall('sess-greedy-early', 1700 * 1000, 7_200_000);   // declares 2h, quiet 28min
  writeToolCall('sess-greedy-late', 1900 * 1000, 7_200_000);    // declares 2h, quiet 32min
  s.state.tick();
  const served = s.snapshot();
  check('a 2h declaration is capped, not obeyed (28min in: still patient)', stateOf(served, 'sess-greedy-early'), 'working');
  check('a 2h declaration is capped, not obeyed (32min in: flagged)', stateOf(served, 'sess-greedy-late'), 'stuck');
  const early = served.sessions.find((r) => r.id === 'sess-greedy-early')?.budgetHold;
  check('...and the cap is disclosed as 1200s, not 7200s', early?.limitSeconds, 1800);
  /* 32 minutes is roughly half of the two hours it wanted - the point of the ceiling */
  check('...so two hours of silence is not granted', stateOf(served, 'sess-greedy-late') === 'stuck', true);
  s.cleanup();
}

/* ---- a declaration SHORTER than staleSeconds must not shorten the rule ----------------------- */
{
  const s = await scenario(['observer']);
  writeToolCall('sess-tiny', 400 * 1000, 20_000);          // declares 20s but is quiet 400s
  s.state.tick();
  const served = s.snapshot();
  check('a short declaration does not make it MORE trigger-happy', stateOf(served, 'sess-tiny'), 'stuck');
  check('...no budget hold is recorded for it', served.sessions.find((r) => r.id === 'sess-tiny')?.budgetHold ?? null, null);
  s.cleanup();
}

/* ---- the ceiling is configurable, for an operator who genuinely wants to wait longer ---------- */
{
  const s = await scenario(['observer'], { maxBudgetSeconds: 3000 });
  writeToolCall('sess-configured', 1900 * 1000, 7_200_000);   // 1900s < 3000 * 1.5
  s.state.tick();
  const served = s.snapshot();
  check('raising maxBudgetSeconds really raises the ceiling', stateOf(served, 'sess-configured'), 'working');
  check('...and the honoured limit follows the config', served.sessions.find((r) => r.id === 'sess-configured')?.budgetHold?.limitSeconds, 4500);
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
