#!/usr/bin/env node
'use strict';
/*
 * watch-sessions.mjs - poll the stuck rule in a loop for the DURATION OF ONE TURN (mode 2).
 *
 * WHAT THIS IS
 *   probe-sessions.mjs looks once and exits. This runs that same verdict on a timer and reports
 *   only STATE CHANGES, so a long wait produces a handful of lines instead of hundreds.
 *
 * WHAT THIS IS NOT
 *   It is not a daemon, and it cannot outlive the turn that started it. A session cannot schedule
 *   its own wake-up, so when the agent's turn ends this process is killed with its job. It is
 *   still worth running, because:
 *     - the transition log is written to disk, so the NEXT turn can read what happened meanwhile
 *     - `--json` state is a durable heartbeat other tools (or the host plugin) can consume
 *   For monitoring that survives the turn, use the host plugin (mode 3).
 *
 * WHY ONLY TRANSITIONS
 *   A watcher that repeats "all clear" every interval trains you to ignore it. Emitting nothing
 *   for minutes at a time is the feature, not a bug - the heartbeat exists so you can still tell
 *   "quiet because nothing happened" from "quiet because it died".
 *
 * Usage:
 *   node watch-sessions.mjs [--interval 60] [--minutes 180] [--stale 300]
 *                           [--log <file.jsonl>] [--state <file.json>] [--heartbeat 300] [--once] [--quiet]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scan, DSH } from './lib/scan.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const INTERVAL_S = Math.max(5, Number(arg('interval', 60)));
const WINDOW_MIN = Number(arg('minutes', 180));
const STALE_S = Number(arg('stale', 300));
const HEARTBEAT_S = Math.max(INTERVAL_S, Number(arg('heartbeat', 300)));
const ONCE = argv.includes('--once');
const QUIET = argv.includes('--quiet') || argv.includes('--json');

const DEFAULT_DIR = path.join(DSH, 'session-watch');
const LOG_FILE = arg('log', path.join(DEFAULT_DIR, 'watch.jsonl'));
const STATE_FILE = arg('state', path.join(DEFAULT_DIR, 'state.json'));

const stamp = (ms = Date.now()) => new Date(ms).toTimeString().slice(0, 8);
const short = (id) => String(id).slice(0, 18);

function shortTitle(t, n = 26) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

function appendLog(record) {
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n'); } catch { }
}

function writeState(rows, extra = {}) {
  const byState = {};
  for (const r of rows) byState[r.state] = (byState[r.state] || 0) + 1;
  const payload = {
    updatedAt: Date.now(),
    updatedAtText: stamp(),
    pid: process.pid,
    intervalS: INTERVAL_S,
    staleS: STALE_S,
    windowMin: WINDOW_MIN,
    counts: byState,
    stuck: rows.filter((r) => r.state === 'stuck').map((r) => ({ id: r.id, title: r.title, quietS: r.quietS, tail: r.tail })),
    ...extra,
  };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2)); } catch { }
  return payload;
}

/* previous verdict per session id, and how many consecutive polls a tracked id has been missing */
const prev = new Map();
const missing = new Map();
const GONE_AFTER = 3;

const say = (line) => { if (!QUIET) console.log(line); };

function announce(row, extra = '') {
  const arrow = row.state === 'stuck' ? '-> STUCK   ' : `-> ${row.state.toUpperCase().padEnd(9)}`;
  say(`[${stamp()}] ${arrow} ${short(row.id)}  "${shortTitle(row.title)}"  quiet ${row.quietS}s  tail=${row.tail}${extra}`);
}

let lastHeartbeat = 0;
let started = false;

function tick() {
  const r = scan({ minutes: WINDOW_MIN, staleS: STALE_S });
  const now = r.at;

  if (!started) {
    started = true;
    const c = (n) => String(n).padStart(2);
    say(`[${stamp()}] watch started: every ${INTERVAL_S}s · window ${WINDOW_MIN}min · stuck if silent > ${STALE_S}s`);
    say(`[${stamp()}] baseline: ${r.checked} session(s) checked — ` +
      `${r.stuck.length} stuck, ${r.working.length + r.mine.length} working, ${r.idle.length} idle`);
    say(`[${stamp()}] log: ${LOG_FILE}`);
    appendLog({ type: 'start', at: now, pid: process.pid, intervalS: INTERVAL_S, windowMin: WINDOW_MIN, staleS: STALE_S, checked: r.checked, counts: { stuck: r.stuck.length, working: r.working.length + r.mine.length, idle: r.idle.length } });
    for (const row of r.rows) prev.set(row.id, row.state);
    // A session already stuck at startup is worth one explicit line each: it is the reason you ran this.
    for (const row of r.stuck) announce(row, '  (already stuck at startup)');
  } else {
    for (const row of r.rows) {
      const before = prev.get(row.id);
      if (before !== row.state) {
        if (before !== undefined || row.state === 'stuck') {
          const extra = before === 'stuck' && row.state !== 'stuck' ? '  (recovered)' : '';
          announce(row, extra);
          appendLog({ type: 'transition', at: now, id: row.id, title: row.title, from: before ?? null, to: row.state, quietS: row.quietS, tail: row.tail });
        }
        prev.set(row.id, row.state);
      }
      missing.set(row.id, 0);
    }

    /* a session that left the window: it finished, was archived, or was deleted */
    for (const [id, state] of [...prev]) {
      if (r.rows.some((row) => row.id === id)) continue;
      const n = (missing.get(id) || 0) + 1;
      missing.set(id, n);
      if (n >= GONE_AFTER) {
        if (state === 'stuck') say(`[${stamp()}] -> GONE      ${short(id)}  was STUCK, no longer active (archived/deleted?)`);
        appendLog({ type: 'gone', at: now, id, was: state });
        prev.delete(id);
        missing.delete(id);
      }
    }
  }

  const state = writeState(r.rows, { started: now });
  if (!ONCE && now - lastHeartbeat >= HEARTBEAT_S * 1000) {
    lastHeartbeat = now;
    const c = state.counts;
    say(`[${stamp()}] ... alive: ${r.checked} checked — ${c.stuck || 0} stuck, ${(c.working || 0) + (c.mine || 0)} working, ${c.idle || 0} idle`);
  }
  return r;
}

if (argv.includes('--json')) {
  const r = tick();
  console.log(JSON.stringify({ at: r.at, counts: { stuck: r.stuck.length, working: r.working.length + r.mine.length, idle: r.idle.length }, stuck: r.stuck }, null, 2));
  process.exit(0);
}

if (ONCE) {
  tick();
  process.exit(0);
}

process.on('SIGINT', () => {
  say(`[${stamp()}] watch stopped by SIGINT`);
  appendLog({ type: 'stop', at: Date.now(), reason: 'SIGINT' });
  process.exit(0);
});
process.on('SIGTERM', () => {
  appendLog({ type: 'stop', at: Date.now(), reason: 'SIGTERM' });
  process.exit(0);
});

tick();
/*
 * Deliberately NOT unref()'d: an unref'd timer does not hold the event loop open, so the process
 * would exit on the spot instead of watching. This interval is the reason the process stays alive.
 */
setInterval(tick, INTERVAL_S * 1000);
