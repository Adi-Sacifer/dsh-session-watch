#!/usr/bin/env node
'use strict';
/*
 * scan.mjs - the shared verdict logic for session-watch. No CLI, no output, just data.
 *
 * Every tool here must agree on what "stuck" means, so the rule lives in exactly one place.
 * probe-sessions.mjs renders it once; watch-sessions.mjs polls it in a loop; the host plugin
 * reuses the same rule. Two copies of this judgement would drift, and a drifted judgement is
 * how you get a watchdog that cries wolf.
 *
 * THE RULE: stuck == the transcript stopped growing AND its tail is an unmatched tool/call.
 * Quiet + `turn/end` is idle, which is normal and must never be reported as a problem.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

export const DSH = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
export const SESS_ROOT = path.join(DSH, 'sessions');
export const PROJ_CACHE = path.join(DSH, 'storages', 'session_projcache', 'sessions');

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/*
 * The ".zstd" transcript is an append-only log of INDEPENDENT zstd frames, not one stream.
 * zstdDecompressSync() returns only the first frame, which looks like an empty conversation.
 * Walk the frame magic instead, and merge forward when a frame body happens to contain it.
 * A trailing half frame is normal on a live session and is skipped.
 */
export function readRecords(file) {
  const buf = fs.readFileSync(file);
  const offs = [];
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i);
  }
  offs.push(buf.length);
  const parts = [];
  for (let k = 0; k < offs.length - 1; k++) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], offs[k + 1]))); continue; } catch { }
    for (let j = k + 2; j < offs.length; j++) {
      try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], offs[j]))); k = j - 1; break; } catch { }
    }
  }
  const out = [];
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { }
  }
  return out;
}

export function titleOf(id) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(PROJ_CACHE, id + '.json'), 'utf8'));
    const t = j?.record?.rows?.title;
    if (t && typeof t.val === 'string' && t.val.trim()) return t.val.trim();
  } catch { }
  return null;
}

export function sessions() {
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

/*
 * Tail analysis. The pairing id is the trap: tool/call carries data.callId, but tool/result
 * carries data.message.toolCallId. Using the wrong field marks every call unresolved, which
 * turns a healthy session into a false alarm (measured: 145/145 on a working session).
 */
export function tail(records) {
  let openTool = null;
  let openTurn = false;
  let lastAt = 0;
  let turnStarts = 0;
  let turnEnds = 0;
  const results = new Set();
  for (const r of records) {
    if (!r || !r.type) continue;
    if (r.time) lastAt = r.time;
    if (r.type === 'tool/call') openTool = { name: r.data?.name || '?', callId: r.data?.callId, at: r.time || 0, args: r.data?.arguments };
    else if (r.type === 'tool/result') {
      const id = r.data?.callId ?? r.data?.message?.toolCallId;
      results.add(id);
      if (openTool && openTool.callId === id) openTool = null;
    } else if (r.type === 'turn/start') { openTurn = true; turnStarts++; }
    else if (r.type === 'turn/end') { openTurn = false; openTool = null; turnEnds++; }
  }
  const lastType = records.length ? records[records.length - 1].type : null;
  return { openTool, openTurn, lastAt, lastType, toolResults: results.size, turnStarts, turnEnds };
}

/*
 * An open turn is NOT an open tool call, and treating them as the same evidence is the false alarm
 * that made two healthy conversations report each other as stuck. An unmatched `tool/call` means a
 * tool was invoked and never came back - at `stale` that is strong evidence. An open turn with NO
 * tool call is only "the model was asked something", and a model that is still streaming writes
 * nothing to the transcript either, so silence there is what hard work looks like.
 *
 * Measured against a real case: a session running its own end-to-end suite issued one `pwsh` call
 * with a 900s timeout and sat silent for 200s+. Reported as stuck at 180s - a false alarm, and the
 * same shape of false alarm the plugin had.
 *
 * This is the CLI half of a rule the host plugin applies at 4x (see plugin/index.js
 * OPEN_TURN_STALE_FACTOR). Keep the two in step: the numbers need not be identical, the DISTINCTION
 * must be.
 */
export const OPEN_TURN_STALE_FACTOR = 4;

/*
 * One session -> one verdict.
 *   'mine'     the caller's own session; it is always writing as it goes, so never a problem
 *   'stuck'    stopped writing while a call or turn is still open
 *   'working'  open work AND still writing
 *   'idle'     turn closed cleanly; this is the normal resting state
 *   'unreadable' the file exists but could not be parsed
 */
export function verdictOf(session, opts = {}) {
  const staleS = opts.staleS ?? 180;
  const now = opts.now ?? Date.now();
  const me = opts.me ?? process.env.DSH_SESSION_ID ?? null;
  const quietS = Math.round((now - session.mtime) / 1000);

  let t;
  try {
    t = tail(readRecords(session.file));
  } catch (e) {
    return { id: session.id, title: titleOf(session.id), size: session.size, mtime: session.mtime, quietS, state: 'unreadable', error: String(e && e.message || e) };
  }

  const open = Boolean(t.openTool || t.openTurn);
  const kind = t.openTool ? `tool/call(${t.openTool.name})` : t.openTurn ? 'open turn (waiting on model)' : `closed(${t.lastType})`;
  const waitS = t.openTool ? staleS : staleS * OPEN_TURN_STALE_FACTOR;

  let state;
  if (session.id === me) state = 'mine';
  else if (open && quietS > waitS) state = 'stuck';
  else if (open) state = 'working';
  else state = 'idle';

  return {
    id: session.id,
    title: titleOf(session.id) || '(untitled)',
    size: session.size,
    mtime: session.mtime,
    quietS,
    state,
    tail: kind,
    openTool: t.openTool ? t.openTool.name : null,
    lastType: t.lastType,
    turnStarts: t.turnStarts,
    turnEnds: t.turnEnds,
  };
}

/* Scan every session touched within the window and classify it. */
export function scan(opts = {}) {
  const windowMin = opts.minutes ?? 90;
  const now = opts.now ?? Date.now();
  const scope = sessions().filter((s) => now - s.mtime < windowMin * 60_000);
  const rows = scope.map((s) => verdictOf(s, { ...opts, now }));
  const by = (state) => rows.filter((r) => r.state === state);
  return {
    at: now,
    windowMin,
    staleS: opts.staleS ?? 180,
    total: sessions().length,
    checked: rows.length,
    stuck: by('stuck'),
    mine: by('mine'),
    working: by('working'),
    idle: by('idle'),
    unreadable: by('unreadable'),
    rows,
  };
}
