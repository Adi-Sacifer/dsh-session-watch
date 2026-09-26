#!/usr/bin/env node
'use strict';
/*
 * probe-sessions.mjs - is any OTHER agent session stuck? (READ-ONLY)
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
 *   - they are matched by id, and THE ID IS NOT WHERE YOU EXPECT IT:
 *       tool/call   carries data.callId
 *       tool/result carries data.message.toolCallId   <-- not data.callId
 *
 * So: stuck == the transcript stopped growing AND its tail is an unmatched tool/call.
 *     Quiet + `turn/end` is just idle, which is normal and must NOT be reported as a problem.
 *
 * TWO FALSE SIGNALS THIS DELIBERATELY AVOIDS  (both were observed in practice)
 *   1. Do not judge liveness by looking for a matching OS process. The host process command line
 *      does not name the session, so "no process found" is noise - it flagged a perfectly healthy
 *      session as stuck.
 *   2. Do not pair calls and results by data.callId alone. With the wrong field every single call
 *      looks unresolved (145/145 on a session that was working fine), which is a false alarm loud
 *      enough to make the whole report worthless.
 *
 * Usage: node probe-sessions.mjs [--minutes 90] [--stale 180]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const WINDOW_MIN = Number(arg('minutes', 90));   // only consider sessions touched this recently
const STALE_S = Number(arg('stale', 180));       // silent longer than this with an open call = stuck

const DSH = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESS_ROOT = path.join(DSH, 'sessions');
const PROJ_CACHE = path.join(DSH, 'storages', 'session_projcache', 'sessions');
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const ME = process.env.DSH_SESSION_ID || null;

/* the ".zstd" is an append-only log of independent frames - not one stream */
function readRecords(file) {
  const buf = fs.readFileSync(file);
  const offs = [];
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i);
  }
  offs.push(buf.length);
  const parts = [];
  for (let k = 0; k < offs.length - 1; k++) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], offs[k + 1]))); continue; } catch { }
    // a frame body can contain the magic bytes by chance: merge forward until it inflates
    for (let j = k + 2; j < offs.length; j++) {
      try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], offs[j]))); k = j - 1; break; } catch { }
    }
    // a trailing partial frame is normal while a session is live; skipping it is correct
  }
  const out = [];
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { }
  }
  return out;
}

function titleOf(id) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(PROJ_CACHE, id + '.json'), 'utf8'));
    const t = j?.record?.rows?.title;
    if (t && typeof t.val === 'string' && t.val.trim()) return t.val.trim();
  } catch { }
  return null;
}

function sessions() {
  const list = [];
  if (!fs.existsSync(SESS_ROOT)) return list;
  for (const ws of fs.readdirSync(SESS_ROOT)) {
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(SESS_ROOT, ws)); } catch { continue; }
    for (const dir of dirs) {
      const f = path.join(SESS_ROOT, ws, dir, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(f)) continue;
      const st = fs.statSync(f);
      list.push({ id: dir, ws, file: f, size: st.size, mtime: st.mtimeMs });
    }
  }
  return list.sort((a, b) => b.mtime - a.mtime);
}

/* tail analysis: is the newest durable state an open tool call, or a closed turn? */
export function tail(records) {
  let openTool = null;
  let openTurn = false;
  let lastAt = 0;
  const results = new Set();
  for (const r of records) {
    if (!r || !r.type) continue;
    if (r.time) lastAt = r.time;
    if (r.type === 'tool/call') openTool = { name: r.data?.name || '?', callId: r.data?.callId, at: r.time || 0 };
    else if (r.type === 'tool/result') {
      // the result's id lives under data.message.toolCallId, NOT data.callId
      const id = r.data?.callId ?? r.data?.message?.toolCallId;
      results.add(id);
      if (openTool && openTool.callId === id) openTool = null;
    } else if (r.type === 'turn/start') openTurn = true;
    else if (r.type === 'turn/end') { openTurn = false; openTool = null; }
  }
  const lastType = records.length ? records[records.length - 1].type : null;
  return { openTool, openTurn, lastAt, lastType, toolResults: results.size };
}

const hhmmss = (ms) => new Date(ms).toTimeString().slice(0, 8);
const now = Date.now();
const all = sessions();
const scope = all.filter((s) => now - s.mtime < WINDOW_MIN * 60_000);

console.log(`=== cross-session stuck check   ${new Date().toTimeString().slice(0, 8)}`);
console.log(`    window: touched within ${WINDOW_MIN} min   |   sessions on disk: ${all.length}`);
console.log(`    rule: silent > ${STALE_S}s with an unmatched tool/call  =>  stuck\n`);

const stuck = [];
const active = [];
const idle = [];

for (const s of scope) {
  const t = tail(readRecords(s.file));
  const quietS = Math.round((now - s.mtime) / 1000);
  const kind = t.openTool ? `open tool/call (${t.openTool.name})` : t.openTurn ? 'open turn (no turn/end)' : `closed (${t.lastType})`;
  const row = { s, t, quietS, kind, title: titleOf(s.id) || '(untitled)', mine: s.id === ME };

  // your own live session writes to disk as it goes, so it is always "working"
  if (row.mine) active.push(row);
  else if ((t.openTool || t.openTurn) && quietS > STALE_S) stuck.push(row);
  else if ((t.openTool || t.openTurn) || quietS < 120) active.push(row);
  else idle.push(row);
}

const show = (row) => {
  const { s, t, quietS, kind } = row;
  console.log(`${row.mine ? '*' : ' '} ${s.id}`);
  console.log(`    ${row.title}`);
  console.log(`    ${(s.size / 1024).toFixed(1)} KB · last write ${hhmmss(s.mtime)} · quiet ${quietS}s · record ${t.lastType}`);
  console.log(`    tail: ${kind}`);
};

if (stuck.length) {
  console.log('-- possibly STUCK ------------------------------');
  for (const r of stuck) show(r);
  console.log('');
}
if (active.length) {
  console.log('-- working -------------------------------------');
  for (const r of active) show(r);
  console.log('');
}
if (idle.length) {
  console.log('-- idle (turn closed cleanly) ------------------');
  for (const r of idle) console.log(`    ${r.s.id.slice(0, 46).padEnd(46)} quiet ${String(r.quietS).padStart(5)}s  ${r.title}`);
  console.log('');
}

console.log(stuck.length
  ? `>>> ${stuck.length} session(s) look stuck: the transcript stopped but the turn never closed.`
  : `>>> all clear: no session is parked on an unmatched tool call. Checked ${scope.length} session(s) touched in the last ${WINDOW_MIN} min.`);
