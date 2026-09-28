#!/usr/bin/env node
'use strict';
/*
 * one-watcher-test.mjs - ONE conversation is woken per incident, not all of them.
 *
 * THE REPORT, after the mutual-watch loop had already been fixed
 *
 *   "虽然监工不会互相看，但是一次性还是会唤起一堆监工，我是这样，首先，一次性只存在一个监工。
 *    （除非监工也死了）"
 *
 * The earlier fix stopped two watchers watching each other. It did not stop the fan-out: the rule was
 * still "every eligible root hears about every stuck session", so four open conversations meant four
 * wake-ups - four models starting a turn, four bills, and four answers to a question the user asked
 * once. The notice is for the PERSON, and there is one person.
 *
 * The contract, in the user's own terms:
 *
 *   一次性只存在一个监工   exactly one recipient per incident
 *   除非监工也死了          and failover exists, so exclusivity can never mean silence
 *
 * Priority: the conversation the person is actually looking at (the page reports its own session id)
 * > a configured pin > the most recently active root.
 *
 * Usage: node test/one-watcher-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-one-'));
process.env.DSH_HOME = ROOT;   // before the first import: index.js reads it at module load
let instance = 0;
const freshPlugin = () => import(`../plugin/index.js?one=${++instance}`);

const WS = '--C-Users-test-project--';
let seq = 0;
const rec = (type, data, at) => ({ type, seq: ++seq, time: at, data });

/**
 * A transcript ending on an unmatched tool/call, silent for `quietMs`.
 *
 * `writtenAgoMs` is the interesting knob: it is how long ago this conversation last wrote, i.e. its
 * transcript mtime, and it is what "most recently active" ranks on. A caller is normally looking at -
 * or typing in - the conversation that moved most recently.
 */
function writeHung(id, { quietMs = 30 * 60_000, writtenAgoMs = null } = {}) {
  const now = Date.now();
  const quiet = writtenAgoMs === null ? quietMs : Math.max(quietMs, writtenAgoMs);
  const mtime = now - quiet;
  const dir = path.join(ROOT, 'sessions', WS, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat([
    rec('turn/start', { turn: 1 }, mtime - 60_000),
    rec('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'node deploy.mjs' }) }, mtime),
  ].map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')))));
  const when = new Date(mtime);
  fs.utimesSync(file, when, when);
}

/** Give a root conversation a recent transcript so it ranks as "most recently active". */
function writeIdle(id, writtenAgoMs) {
  const mtime = Date.now() - writtenAgoMs;
  const dir = path.join(ROOT, 'sessions', WS, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat([
    rec('turn/start', { turn: 1 }, mtime - 1000),
    rec('turn/end', { turn: 1 }, mtime),
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
  const state = { routes: {}, delivered: [], logged: [], watcherPost: null };
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

  /** Make a root unavailable, as if it had exited. */
  state.kill = (id) => {
    const i = registry.findIndex((a) => a.id === id);
    if (i >= 0) registry.splice(i, 1);
  };
  /** Simulate the GUI page reporting which conversation it is showing. */
  state.reportViewing = (sessionId) => {
    const post = Object.entries(state.routes).find(([k]) => k.startsWith('POST '));
    return new Promise((resolve) => {
      post[1].handler({
        on: (evt, cb) => { if (evt === 'end') cb(); },
      }, { writeHead: () => { }, end: () => resolve() });
    });
  };
  const snapshot = () => {
    const key = Object.keys(state.routes).find((k) => /^GET \/session-watch\/state-.*\.json$/.test(k));
    let s = null;
    state.routes[key].handler({}, { writeHead: () => { }, end: (b) => { s = JSON.parse(b); } });
    return s;
  };
  const cleanup = () => { try { fs.rmSync(path.join(ROOT, 'sessions'), { recursive: true, force: true }); } catch { } };
  return { state, snapshot, cleanup };
}

/* ---- the reported problem: one hang must not wake everybody ---------------------------------- */
{
  const s = await scenario(['alice', 'bob', 'carol']);
  writeHung('sess-hang');
  s.state.tick();
  check('exactly one conversation is woken, not three', s.state.delivered.length, 1);
  check('...and it is a conversation that exists',
    ['alice', 'bob', 'carol'].includes(s.state.delivered[0]?.to), true);
  s.cleanup();
}

/* ---- the person's most recently active conversation wins -------------------------------------- */
{
  const s = await scenario(['alice', 'bob', 'carol']);
  writeHung('sess-hang');
  /* alice wrote a moment ago, bob and carol an hour ago: alice is where the person is */
  writeIdle('alice', 2_000);
  writeIdle('bob', 60 * 60_000);
  writeIdle('carol', 90 * 60_000);
  s.state.tick();
  check('still exactly one', s.state.delivered.length, 1);
  check('...and it is the most recently active conversation',
    s.state.delivered[0]?.to, 'alice');
  s.cleanup();
}

/* ---- a pinned target is the only recipient ---------------------------------------------------- */
{
  const s = await scenario(['alice', 'bob', 'carol'], { notifySessionId: 'bob' });
  writeHung('sess-hang');
  s.state.tick();
  check('a pin beats everything', s.state.delivered.map((d) => d.to).join(','), 'bob');
  s.cleanup();
}

/* ---- 除非监工也死了: failover, so exclusivity never means silence ----------------------------- */
{
  const s = await scenario(['alice', 'bob', 'carol'], { notifySessionId: 'alice' });
  writeHung('sess-hang');
  s.state.kill('alice');       // the chosen watcher is gone
  s.state.tick();
  check('a dead watcher does not silence the watchdog', s.state.delivered.length, 1);
  check('...the next conversation takes over',
    ['bob', 'carol'].includes(s.state.delivered[0]?.to), true);
  s.cleanup();
}

/* ---- nobody eligible is deferred, not fanned out and not dropped ------------------------------ */
{
  const s = await scenario([]);
  writeHung('sess-hang');
  s.state.tick();
  check('with no conversations there is no delivery at all', s.state.delivered.length, 0);
  const served = s.snapshot();
  check('...but the hang is still on screen for a person to act on',
    served.stuck.some((r) => r.id === 'sess-hang'), true);
  s.cleanup();
}

/* ---- one incident is one message, even across many ticks -------------------------------------- */
{
  const s = await scenario(['alice', 'bob', 'carol']);
  writeHung('sess-hang');
  for (let i = 0; i < 6; i++) s.state.tick();
  check('six ticks do not produce six messages', s.state.delivered.length, 1);
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
