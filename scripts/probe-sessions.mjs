#!/usr/bin/env node
'use strict';
/*
 * probe-sessions.mjs - is any OTHER agent session stuck? (READ-ONLY, one shot)
 *
 * THE PROBLEM
 *   You have several agent conversations open. One of them goes quiet. Is it done, or is it hung?
 *   A file timestamp cannot tell you: an idle session and a hung session look exactly the same.
 *   The transcript can tell you, because a healthy turn has a shape.
 *
 * WHAT A TRANSCRIPT IS  (measured against real sessions)
 *   ~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd
 *   The ".zstd" is NOT one compressed stream - it is an append-only log of independent zstd
 *   frames, one per flush. zstdDecompressSync() reads only the FIRST frame and hands back a few
 *   hundred bytes that look like an empty conversation. You must walk the frame magic
 *   (28 B5 2F FD), inflate each frame between boundaries, and concatenate.
 *
 * WHAT A HEALTHY TURN LOOKS LIKE
 *   turn/start -> step/start -> assistant/message -> tool/call -> tool/result -> turn/end
 *   - a finished turn ENDS on `turn/end`
 *   - a tool in flight leaves a `tool/call` with no matching `tool/result` after it
 *
 * So: stuck == the transcript stopped growing AND its tail is an unmatched tool/call (or an
 * open turn). Quiet + `turn/end` is just idle, which is normal and must NOT be reported.
 *
 * TWO FALSE SIGNALS THIS DELIBERATELY AVOIDS  (both were observed in practice)
 *   1. Do not judge liveness by looking for a matching OS process. The host process command line
 *      does not name the session, so "no process found" is noise - it flagged a perfectly healthy
 *      session as stuck.
 *   2. Do not pair calls and results by data.callId alone. The result carries its id under
 *      data.message.toolCallId; with the wrong field every single call looks unresolved
 *      (145/145 on a session that was working fine), which is a false alarm loud enough to make
 *      the whole report worthless.
 *
 * This is a SNAPSHOT, not a daemon - it looks once and exits. For a loop, use watch-sessions.mjs.
 *
 * Usage: node probe-sessions.mjs [--minutes 90] [--stale 180] [--json]
 */
import { scan } from './lib/scan.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const WINDOW_MIN = Number(arg('minutes', 90));
const STALE_S = Number(arg('stale', 180));
const AS_JSON = argv.includes('--json');

const r = scan({ minutes: WINDOW_MIN, staleS: STALE_S });

if (AS_JSON) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

const hhmmss = (ms) => new Date(ms).toTimeString().slice(0, 8);

console.log(`=== cross-session stuck check   ${hhmmss(r.at)}`);
console.log(`    window: touched within ${WINDOW_MIN} min   |   sessions on disk: ${r.total}`);
console.log(`    rule: silent > ${STALE_S}s with open work (tool/call or turn)  =>  stuck\n`);

const show = (row) => {
  console.log(`${row.state === 'mine' ? '*' : ' '} ${row.id}`);
  console.log(`    ${row.title}`);
  console.log(`    ${(row.size / 1024).toFixed(1)} KB · last write ${hhmmss(row.mtime)} · quiet ${row.quietS}s · record ${row.lastType}`);
  console.log(`    tail: ${row.tail}`);
};

if (r.stuck.length) {
  console.log('-- possibly STUCK ------------------------------');
  for (const row of r.stuck) show(row);
  console.log('');
}
if (r.mine.length || r.working.length) {
  console.log('-- working -------------------------------------');
  for (const row of [...r.mine, ...r.working]) show(row);
  console.log('');
}
if (r.unreadable.length) {
  console.log('-- unreadable ----------------------------------');
  for (const row of r.unreadable) console.log(`    ${row.id}  ${row.error}`);
  console.log('');
}
if (r.idle.length) {
  console.log('-- idle (turn closed cleanly) ------------------');
  for (const row of r.idle) console.log(`    ${row.id.slice(0, 46).padEnd(46)} quiet ${String(row.quietS).padStart(5)}s  ${row.title}`);
  console.log('');
}

console.log(r.stuck.length
  ? `>>> ${r.stuck.length} session(s) look stuck: the transcript stopped but the turn never closed.`
  : `>>> all clear: no session is parked on an unmatched tool call. Checked ${r.checked} session(s) touched in the last ${WINDOW_MIN} min.`);
