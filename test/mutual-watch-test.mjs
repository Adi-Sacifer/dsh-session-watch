#!/usr/bin/env node
'use strict';
/*
 * mutual-watch-test.mjs - two conversations watching each other must not become a loop.
 *
 * THE BUG THIS PINS (reported by the user, and it was real)
 *   "我同时开了两个监工，两个监工同时触发，他们就会互相监控，互相觉得对方卡了，两边都在瞅对方。"
 *
 *   Mechanically, on the pre-fix code:
 *     A is flagged stuck  ->  notify() wakes EVERY root conversation, B included
 *     B is now working    ->  a working session writes nothing to its transcript
 *     B's transcript is silent past staleSeconds with an open turn  ->  B is flagged stuck
 *     ->  notify() wakes A to look at B, and A looks exactly like B did
 *   Two healthy conversations, each convinced the other one is hung, forever. One watcher is enough
 *   to start it: the second conversation only has to EXIST and be busy.
 *
 * HOW THIS FILE IS BUILT (and why it looks the way it does)
 *   Every group runs in its OWN temp DSH_HOME with its OWN plugin instance. An earlier version of
 *   this file shared one sandbox across all groups, so each group's snapshot and delivery counters
 *   included the previous groups' transcripts, and one group's only root happened to BE the session
 *   it was diagnosing. Those were test bugs, not plugin bugs, and they made the results worthless in
 *   both directions. Isolation is the fix.
 *
 *   Each assertion group states which way it fails on the PRE-FIX code, so "it passes now" cannot be
 *   confused with "it could never fail".
 *
 * Everything runs against synthetic transcripts and a fake agent registry, so no live conversation is
 * touched. Usage: node test/mutual-watch-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/*
 * Each scenario needs its OWN module instance: apply() mounts one generation per process by design
 * (pinned by reload-safety.mjs), so distinct query specifiers keep the scenarios independent.
 */
let instance = 0;
const freshPlugin = () => import(`../plugin/index.js?mutual=${++instance}`);

let pass = 0;
const failures = [];
const check = (label, actual, expected) => {
  if (actual === expected) { pass++; return; }
  failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const MIN = 60_000;
const STALE = 300;             // the shipped default
const WEAK = STALE * 4;        // an open turn needs 4x the silence: see OPEN_TURN_STALE_FACTOR
const WS = '--C-Users-test-project--';
let seq = 0;
const rec = (type, data, at) => ({ type, seq: ++seq, time: at, data });

/* ------------------------------------------------------------------ fixtures */

function transcript(dir, records, mtime) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat(
    records.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8'))),
  ));
  const when = new Date(mtime);
  fs.utimesSync(file, when, when);
  return file;
}

/** Ends on an UNMATCHED tool/call: the shape of a genuine hang, and the only strong signal. */
function writeHungTool(root, id, quietMs, now) {
  const mtime = now - quietMs;
  transcript(path.join(root, 'sessions', WS, id), [
    rec('turn/start', { turn: 1 }, mtime - 60_000),
    rec('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'deploy.sh' }) }, mtime),
  ], mtime);
}

/** Ends on an OPEN TURN with no tool call: what a model that is still thinking looks like. */
function writeOpenTurn(root, id, quietMs, now) {
  const mtime = now - quietMs;
  transcript(path.join(root, 'sessions', WS, id), [
    rec('turn/start', { turn: 1 }, mtime - 30_000),
    rec('assistant/message', { message: { content: [{ type: 'text', text: '我在想' }] } }, mtime - 10_000),
  ], mtime);
}

/* ------------------------------------------------------------------ fake host */

function makeHost(roots) {
  const state = { routes: {}, delivered: [], logged: [], emitted: [] };
  const makeAgent = (id) => ({ id, followup(message) { state.delivered.push({ to: id, message }); } });
  const registry = roots.map(makeAgent);
  const ctx = {
    interval: (fn) => { state.tick = fn; return () => { }; },
    timeout: () => () => { },
    webServer: { register: (route) => { state.routes[`${route.method} ${route.path}`] = route; return () => { }; } },
    emit: (name, payload) => { state.emitted.push({ name, payload }); },
    on: () => () => { },
    logger: { info: (m) => state.logged.push(m), warn: (m) => state.logged.push('WARN ' + m) },
    agents: { roots: () => registry, get: (id) => registry.find((a) => a.id === id) },
  };
  state.registry = registry;
  return { ctx, state };
}

const snapshotOf = (host) => {
  const key = Object.keys(host.state.routes).find((k) => /^GET \/session-watch\/state-.*\.json$/.test(k));
  let served = null;
  host.state.routes[key].handler({}, { writeHead: () => { }, end: (b) => { served = JSON.parse(b); } });
  return served;
};
const stateOf = (served, id) => served.sessions.find((s) => s.id === id)?.state;

/** A fresh sandbox + plugin instance + host, so no group can contaminate another. */
async function scenario(roots, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-mutual-'));
  process.env.DSH_HOME = root;   // read at import time by index.js, so it must be set before import
  const host = makeHost(roots);
  const plugin = await freshPlugin();
  plugin.apply(host.ctx, { intervalSeconds: 15, staleSeconds: STALE, windowMinutes: 1440, ...config });
  return { root, host, plugin, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/* ==================================================================== groups */

/*
 * GROUP 1 - the verdict. A conversation that is merely MID-THOUGHT must not be called stuck at the
 * same threshold as a tool call that never came back.
 *
 * Pre-fix: 'sess-thinking' is 'stuck' (same threshold for both), there is no `signal` field at all,
 * and there is no `weakStaleSeconds` in the snapshot - so 3 of these 4 assertions fail.
 */
{
  const now = Date.now();
  const s = await scenario(['monitor-1', 'monitor-2']);
  writeOpenTurn(s.root, 'sess-thinking', 10 * MIN, now);       // 600s: past 300, under 1200
  writeHungTool(s.root, 'sess-hung-tool', 10 * MIN, now);      // 600s: past 300
  s.host.state.tick();
  const served = snapshotOf(s.host);

  check('G1 mid-thought is not called stuck at the tool-call threshold',
    stateOf(served, 'sess-thinking'), 'working');
  check('G1 a tool call that never returned IS stuck at that threshold',
    stateOf(served, 'sess-hung-tool'), 'stuck');
  check('G1 the snapshot separates the two signals',
    served.stuck.map((r) => r.signal).join(','), 'tool-call');
  check('G1 the page is told both thresholds',
    typeof served.weakStaleSeconds === 'number' && served.weakStaleSeconds === WEAK, true);
  s.cleanup();
}

/*
 * GROUP 2 - the loop itself. This is the user's bug, end to end.
 *
 * Pre-fix: both monitors get flagged and re-woken on every tick, so this whole group fails.
 */
{
  const now = Date.now();
  const s = await scenario(['monitor-1', 'monitor-2']);
  writeHungTool(s.root, 'sess-victim', 30 * MIN, now);
  s.host.state.tick();

  check('G2 a genuine hang wakes somebody', s.host.state.delivered.length >= 1, true);
  const afterFirst = s.host.state.delivered.length;

  /* Now both monitors are mid-turn AND their transcripts are silent well past every threshold -
   * exactly the shape that used to close the loop. */
  writeOpenTurn(s.root, 'monitor-1', 60 * MIN, now);
  writeOpenTurn(s.root, 'monitor-2', 60 * MIN, now);
  s.host.state.tick();
  const served = snapshotOf(s.host);

  /*
   * ONE conversation is woken, so ONE conversation becomes a monitor.
   *
   * This group was written when every eligible root was notified, and asserted both were withheld.
   * The fan-out is gone (see one-watcher-test.mjs), so exactly one of the two takes the report - and
   * the point of the assertion is unchanged: whoever was woken is no longer a suspect. Which one it
   * is depends on "most recently active", which this fixture does not pin, so the assertion counts
   * rather than names.
   */
  check('G2 exactly one conversation is woken', s.host.state.delivered.length, 1);
  const suppressed = (served.suppressed ?? []).map((x) => x.id).sort();
  check('G2 the woken conversation is withheld as a suspect', suppressed.length, 1);
  check('G2 ...and it is one of the two',
    /^monitor-[12]$/.test(suppressed[0] ?? ''), true);
  /*
   * Only the WOKEN one is exempt, and only from being re-reported.
   *
   * This assertion used to say "no monitor appears in the stuck list" and expect zero - which was
   * simply wrong, and the fixture proved it: the other conversation was never woken, so it is not a
   * watchdog at all. In this fixture it is genuinely hung (an open turn silent for 60 minutes), and a
   * genuinely hung conversation MUST stay on the list or the exemption becomes a way to hide hangs.
   * What must hold is narrower and more useful: whoever took the report is not offered up again.
   */
  check('G2 the woken one is not listed as stuck again',
    served.stuck.some((r) => r.id === suppressed[0]), false);
  check('G2 ...while a conversation that was never woken is still reported',
    served.stuck.some((r) => /^monitor-/.test(r.id)), true);
  check('G2 no monitor is woken again', s.host.state.delivered.length, afterFirst);

  for (let i = 0; i < 5; i++) s.host.state.tick();
  check('G2 repeated ticks still do not re-wake a monitor', s.host.state.delivered.length, afterFirst);
  s.cleanup();
}

/*
 * GROUP 3 - worth the words, because the fix could have gone too far: being woken must not be
 * PERMANENT immunity. A monitor that later hangs on its own is reported again once the hook window
 * has passed, otherwise "stop the loop" would have been bought with "never report these again".
 *
 * Pre-fix: fails - the woken conversation is treated like any other root, so it is reported
 * immediately rather than after a window, and there is no window at all.
 */
{
  const now = Date.now();
  /*
   * The hook window is wall-clock, so the test shortens it rather than ageing the transcripts: a
   * transcript's mtime says how long a session has been SILENT, which is a different clock from how
   * long it has been a MONITOR. 1.5s is long enough to check the suppression is real and short enough
   * to actually wait out.
   */
  const s = await scenario(['monitor-1', 'monitor-2'], { hookWindowSeconds: 1.5 });
  writeHungTool(s.root, 'sess-first', 30 * MIN, now);
  s.host.state.tick();
  check('G3 the first hang is reported', s.host.state.delivered.length >= 1, true);

  /* Immediately after being woken, monitor-1 hangs on its own. Inside the window it must stay quiet:
   * this is the case that, unbounded, re-opens the loop. */
  writeHungTool(s.root, 'monitor-1', 30 * MIN, now);
  s.host.state.tick();
  let served = snapshotOf(s.host);
  check('G3 a freshly woken conversation is not immediately re-reported',
    served.stuck.filter((r) => r.id === 'monitor-1').length, 0);
  check('G3 and the snapshot says why it is being left alone',
    (served.suppressed ?? []).some((x) => x.id === 'monitor-1'), true);

  /* Past the hook window it must COME BACK. A suppression that never expires is just a second way to
   * go blind, and this watchdog would stop reporting precisely the conversations that stay busy. */
  await new Promise((resolve) => setTimeout(resolve, 1700));
  writeHungTool(s.root, 'monitor-1', 30 * MIN, Date.now());
  s.host.state.tick();
  served = snapshotOf(s.host);
  check('G3 after the hook window the suppression is gone',
    (served.suppressed ?? []).some((x) => x.id === 'monitor-1'), false);
  check('G3 and a hung conversation is visible again',
    served.stuck.some((r) => r.id === 'monitor-1'), true);
  s.cleanup();
}

/*
 * GROUP 4 - delivery discipline. Two independent things that the first attempt at this fix got
 * wrong, both of which made the watchdog quietly useless:
 *   (a) a recipient that is mid-turn must not be followup()'d into - but the message must be
 *       DELAYED, not dropped, when it later goes idle
 *   (b) the same conversation must not be told about the same session twice
 *
 * Pre-fix: (a) fails on both halves - there is no busy check, so the mid-turn conversation is
 * interrupted immediately; there is no retry, so a dropped alert never comes back.
 */
{
  const now = Date.now();
  const s = await scenario(['busy-root', 'idle-root']);
  writeHungTool(s.root, 'sess-victim-2', 30 * MIN, now);
  /* busy-root: unmatched call but written 5s ago => verdict 'working', i.e. mid-turn */
  writeHungTool(s.root, 'busy-root', 5_000, now);
  s.host.state.tick();

  const toBusy = s.host.state.delivered.filter((d) => d.to === 'busy-root').length;
  check('G4 a conversation that is mid-turn is not interrupted', toBusy, 0);
  const toIdle = s.host.state.delivered.filter((d) => d.to === 'idle-root').length;
  check('G4 the idle conversation is told instead', toIdle, 1);
  /*
   * ONE recipient, so there is nobody left to defer to.
   *
   * This group used to assert that the mid-turn root was skipped on tick 1 and told on tick 2, when
   * the rule was "every eligible root hears about it". With one watcher per incident that second
   * delivery must NOT happen: idle-root was free and took the message, the incident is closed, and a
   * later nudge to busy-root would be the fan-out the user reported - just staggered by one tick.
   */
  check('G4 exactly one conversation is woken', s.host.state.delivered.length, 1);

  const served = snapshotOf(s.host);
  check('G4 the hung session is on screen for a person to act on',
    served.stuck.some((r) => r.id === 'sess-victim-2'), true);
  check('G4 the busy conversation itself is not called stuck', stateOf(served, 'busy-root'), 'working');

  /* busy-root goes idle; the incident is already announced, so nothing new is sent. */
  writeHungTool(s.root, 'busy-root', 60 * MIN, now);
  s.host.state.tick();
  check('G4 it is not told later either: the incident is already announced',
    s.host.state.delivered.filter((d) => d.to === 'busy-root').length, 0);

  const total = s.host.state.delivered.length;
  for (let i = 0; i < 4; i++) s.host.state.tick();
  check('G4 nothing is repeated on later ticks', s.host.state.delivered.length, total);
  s.cleanup();
}

/*
 * GROUP 5 - the fix must not silence the watchdog.
 *
 * A cheap way to pass every assertion above is to never notify anyone, and the first attempt at this
 * fix did exactly that by accident (an out-of-scope `busy` threw inside notify's own try/catch, so
 * every alert was swallowed while the snapshot still looked healthy). This group is the anti-cheat:
 * a genuine hang must still produce a message, and a weak signal must still reach the screen.
 *
 * Pre-fix: the first assertion fails (both open turns are 'stuck' with no distinction), and the
 * weak-signal assertion fails because there is no `signal` field.
 */
{
  const now = Date.now();
  const s = await scenario(['idle-root']);
  writeHungTool(s.root, 'sess-real-hang', 30 * MIN, now);
  writeOpenTurn(s.root, 'sess-slow-model', 60 * MIN, now);
  s.host.state.tick();
  const served = snapshotOf(s.host);

  check('G5 a genuine hang still produces a message', s.host.state.delivered.length >= 1, true);
  check('G5 the very old open turn still reaches the screen',
    served.stuck.some((r) => r.id === 'sess-slow-model'), true);
  check('G5 ...and is labelled as the weak signal',
    served.stuck.find((r) => r.id === 'sess-slow-model')?.signal, 'open-turn');
  check('G5 the weak signal is the ONLY thing that wakes nobody',
    served.stuck.some((r) => r.id === 'sess-slow-model') && s.host.state.delivered.length === 1, true);
  s.cleanup();
}

/* ==================================================================== report */

console.log(`${pass} assertion(s) passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
