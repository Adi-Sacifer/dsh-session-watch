#!/usr/bin/env node
'use strict';
/*
 * selftest.mjs - verify the verdict rules against synthetic transcripts (no real data touched).
 *
 * WHY THIS EXISTS
 *   The stuck rule depends on facts that are easy to get subtly wrong and impossible to notice
 *   by eye: the frame-oriented .zstd layout, the record-type names, and the nesting of the
 *   tool-call id. Every one of those was gotten wrong at least once while building this, and each
 *   mistake produced a confidently wrong answer rather than an error. So the rules get a test.
 *
 *   It builds a throwaway DSH_HOME in a temp directory, writes transcripts in the REAL format
 *   (independent zstd frames, one JSON record per frame), points the library at it via DSH_HOME,
 *   and asserts the resulting verdicts.
 *
 * Usage: node test/selftest.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-selftest-'));
process.env.DSH_HOME = ROOT;                 // must be set BEFORE the library is imported
const { scan, tail, readRecords } = await import('../scripts/lib/scan.mjs');

const WS = '--C-Users-test-project--';
const SANDBOX_STALE = 120;

let seq = 0;
const rec = (type, data, at) => ({ type, seq: ++seq, time: at, data });

/* A transcript is a sequence of INDEPENDENT zstd frames, one per flush - same as the real thing. */
function writeTranscript(sessionId, records) {
  const dir = path.join(ROOT, 'sessions', WS, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const frames = records.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')));
  fs.writeFileSync(file, Buffer.concat(frames));
  return file;
}

function writeTitle(sessionId, title) {
  const dir = path.join(ROOT, 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId + '.json'), JSON.stringify({ record: { rows: { title: { val: title } } } }));
}

const now = Date.now();
const MIN = 60_000;

/*
 * The verdict reads the transcript's mtime, because "has it stopped being written" is the signal.
 * So a synthetic transcript must also carry a synthetic mtime - a freshly created file would
 * always look like it was written one second ago and nothing could ever test as stuck.
 */
function setMtime(file, ms) {
  const when = new Date(ms);
  fs.utimesSync(file, when, when);
}

/* scenario builders -------------------------------------------------------- */

// A turn that ran and closed: the normal resting state. Must never be reported.
function idleSession(id, title, quietMin) {
  const at = now - quietMin * MIN;
  writeTitle(id, title);
  const f = writeTranscript(id, [
    rec('turn/start', { turn: 1 }, at - 5000),
    rec('step/start', { turn: 1, step: 1 }, at - 4000),
    rec('tool/call', { turn: 1, step: 1, callId: 'call_a', name: 'read', arguments: '{}' }, at - 3000),
    rec('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call_a', content: [] } }, at - 2000),
    rec('assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }, at - 1000),
    rec('turn/end', { turn: 1 }, at),
  ]);
  setMtime(f, at);
  return f;
}

// A tool call in flight, transcript still being written. Working, not stuck.
function workingSession(id, title) {
  const at = now - 2000;
  writeTitle(id, title);
  const f = writeTranscript(id, [
    rec('turn/start', { turn: 2 }, at - 8000),
    rec('step/start', { turn: 2, step: 1 }, at - 7000),
    rec('tool/call', { turn: 2, step: 1, callId: 'call_b', name: 'pwsh', arguments: '{}' }, at),
  ]);
  setMtime(f, at);
  return f;
}

// A tool call whose result never arrived, and the transcript went silent. THE stuck case.
function stuckToolSession(id, title, quietMin) {
  const at = now - quietMin * MIN;
  writeTitle(id, title);
  const f = writeTranscript(id, [
    rec('turn/start', { turn: 3 }, at - 9000),
    rec('step/start', { turn: 3, step: 1 }, at - 8000),
    rec('assistant/message', { message: { content: [{ type: 'text', text: 'running it' }] } }, at - 6000),
    rec('tool/call', { turn: 3, step: 1, callId: 'call_c', name: 'bash', arguments: '{}' }, at),
  ]);
  setMtime(f, at);
  return f;
}

// An open turn with NO tool call = the model was asked and never answered. Also silent => stuck.
function stuckStreamSession(id, title, quietMin) {
  const at = now - quietMin * MIN;
  writeTitle(id, title);
  const f = writeTranscript(id, [
    rec('turn/start', { turn: 4 }, at - 3000),
    rec('step/start', { turn: 4, step: 1 }, at - 2000),
    rec('assistant/message', { message: { content: [{ type: 'text', text: 'thinking out loud' }] } }, at),
  ]);
  setMtime(f, at);
  return f;
}

// Closed turn that is old: idle for a long time must NOT be mistaken for stuck.
function oldIdleSession(id, title, quietMin) {
  return idleSession(id, title, quietMin);
}

/* assertions --------------------------------------------------------------- */

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  if (actual === expected) { pass++; return; }
  failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* build the sandbox */
idleSession('sess-idle-fresh', 'fresh idle', 1);
idleSession('sess-idle-old', 'ancient idle', 600);
workingSession('sess-working', 'still working');
stuckToolSession('sess-stuck-tool', 'stuck on a tool', 30);
stuckStreamSession('sess-stuck-stream', 'stuck on the model', 45);
const partial = writeTranscript('sess-partial-frame', [
  rec('turn/start', { turn: 9 }, now - 10_000),
  rec('turn/end', { turn: 9 }, now - 9_000),
]);
fs.appendFileSync(partial, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x02, 0x03])); // torn frame mid-flush

/* 1. the reader survives a torn trailing frame and still sees the records before it */
{
  const recs = readRecords(partial);
  check('torn trailing frame: records still readable', recs.length, 2);
  check('torn trailing frame: last type', recs[recs.length - 1].type, 'turn/end');
}

/* 2. pairing: the result id is nested under data.message.toolCallId
 *    (sess-pair2 is intentionally audible at 30 min quiet - only its openTool is asserted here) */
{
  const t = tail(readRecords(idleSession('sess-pair', 'pairing', 1)));
  check('pairing: matched call leaves no open tool', t.openTool, null);
  const t2 = tail(readRecords(stuckToolSession('sess-pair2', 'pairing2', 30)));
  check('pairing: unmatched call stays open', t2.openTool?.name, 'bash');
}

/* 3. verdicts */
{
  const r = scan({ minutes: 24 * 60, staleS: SANDBOX_STALE, now });
  const stateOf = (id) => r.rows.find((x) => x.id === id)?.state;

  check('fresh idle -> idle', stateOf('sess-idle-fresh'), 'idle');
  check('LONG idle is not stuck', stateOf('sess-idle-old'), 'idle');
  check('open tool + writing -> working', stateOf('sess-working'), 'working');
  check('open tool + silent -> stuck', stateOf('sess-stuck-tool'), 'stuck');
  check('open turn + silent -> stuck', stateOf('sess-stuck-stream'), 'stuck');
  check('torn frame session -> idle', stateOf('sess-partial-frame'), 'idle');

  check('scan counts stuck', r.stuck.length, 3);
  check('stuck ids', r.stuck.map((x) => x.id).sort().join(','),
    'sess-pair2,sess-stuck-stream,sess-stuck-tool');
  check('idle count', r.idle.length, 4);
}

/* 4. the caller's own session is never reported as stuck, even when genuinely silent */
{
  const mine = process.env.DSH_SESSION_ID;
  process.env.DSH_SESSION_ID = 'sess-stuck-tool';
  const r = scan({ minutes: 24 * 60, staleS: SANDBOX_STALE, now });
  check('own session is never stuck', r.rows.find((x) => x.id === 'sess-stuck-tool')?.state, 'mine');
  check('own session not in stuck list', r.stuck.some((x) => x.id === 'sess-stuck-tool'), false);
  if (mine === undefined) delete process.env.DSH_SESSION_ID; else process.env.DSH_SESSION_ID = mine;
}

/* 5. the stale threshold is actually the boundary: same session, two thresholds, opposite verdicts */
{
  const quietMin = 30;
  const id = 'sess-boundary';
  const f = stuckToolSession(id, 'boundary case', quietMin);
  const at = now - quietMin * MIN;
  check('boundary: fixture mtime is really 30 min old', Math.round((now - fs.statSync(f).mtimeMs) / MIN), quietMin);

  const below = scan({ minutes: 24 * 60, staleS: 20 * 60, now });   // 20 min < 30 min quiet
  const above = scan({ minutes: 24 * 60, staleS: 60 * 60, now });   // 60 min > 30 min quiet
  check('boundary: flagged when threshold is below the quiet time',
    below.rows.find((x) => x.id === id)?.state, 'stuck');
  check('boundary: spared when the threshold is above the quiet time',
    above.rows.find((x) => x.id === id)?.state, 'working');

  const tiny = scan({ minutes: 24 * 60, staleS: 1, now });
  check('boundary: 1s threshold also flags a 2s-old working session',
    tiny.rows.find((x) => x.id === 'sess-working')?.state, 'stuck');
}

/* 6. the window filter excludes sessions not touched recently */
{
  const narrow = scan({ minutes: 30, staleS: SANDBOX_STALE, now });
  check('window excludes the 600-min-old session', narrow.rows.some((x) => x.id === 'sess-idle-old'), false);
}

/* report */
console.log(`sandbox: ${ROOT}`);
console.log(`zstd frames written as independent frames; records: ${seq}`);
console.log(`\n${pass} assertion(s) passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
fs.rmSync(ROOT, { recursive: true, force: true });
