#!/usr/bin/env node
'use strict';
/*
 * peek-text.mjs - what is that OTHER session actually saying? (READ-ONLY)
 *
 * WHY THIS EXISTS
 *   The companion tool (session-recall) pins itself to the CURRENT conversation: its `turns`
 *   command always resolves to "me", by design. Its `timeline` command only prints user turns.
 *   So when you want the thing you actually care about - what the other agent is *saying* and
 *   how far it thinks it has got - neither command reaches it. This one does.
 *
 * WHAT IT PRINTS
 *   - the last N assistant TEXT blocks of the target session, so you can read its own account of
 *     where it is
 *   - the unresolved tool-call count at the tail, which is the honest "still working vs parked"
 *     signal (see probe-sessions.mjs for why pairing must use data.message.toolCallId)
 *
 * Reasoning blocks live in the SAME content array as visible text, so they are filtered by
 * `type === 'text'`. Reading them out would leak private thinking and bloat the output.
 *
 * Usage: node peek-text.mjs <id | id-fragment | title-fragment> [count] [--chars 900]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CHARS = Number(flag('chars', 900));
const COUNT = Number(pos[1] || 2);
const TARGET = pos[0];

const DSH = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESS_ROOT = path.join(DSH, 'sessions');
const PROJ_CACHE = path.join(DSH, 'storages', 'session_projcache', 'sessions');
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

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

function titleOf(id) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(PROJ_CACHE, id + '.json'), 'utf8'));
    const t = j?.record?.rows?.title;
    if (t && typeof t.val === 'string') return t.val.trim();
  } catch { }
  return null;
}

function allSessions() {
  const list = [];
  if (!fs.existsSync(SESS_ROOT)) return list;
  for (const ws of fs.readdirSync(SESS_ROOT)) {
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(SESS_ROOT, ws)); } catch { continue; }
    for (const dir of dirs) {
      const f = path.join(SESS_ROOT, ws, dir, 'session.v4.jsonl.zstd');
      if (fs.existsSync(f)) list.push({ id: dir, file: f, mtime: fs.statSync(f).mtimeMs });
    }
  }
  return list.sort((a, b) => b.mtime - a.mtime);
}

if (!TARGET) { console.error('usage: peek-text.mjs <id|id-fragment|title-fragment> [count] [--chars N]'); process.exit(2); }

const all = allSessions();
let m = all.filter((x) => x.id === TARGET);
if (!m.length) m = all.filter((x) => x.id.includes(TARGET));
if (!m.length) m = all.filter((x) => (titleOf(x.id) || '').toLowerCase().includes(TARGET.toLowerCase()));
if (!m.length) { console.error(`no session matches "${TARGET}"`); process.exit(1); }
if (m.length > 1) {
  console.error('ambiguous target, matches:\n' + m.map((x) => `  ${x.id}  ${titleOf(x.id) || ''}`).join('\n'));
  process.exit(1);
}

const s = m[0];
const recs = readRecords(s.file);
const hhmm = (ms) => (ms ? new Date(ms).toTimeString().slice(0, 8) : '--:--:--');

console.log(`=== ${titleOf(s.id) || s.id}   [${s.id}]`);
console.log(`records=${recs.length}  lastWrite=${hhmm(s.mtime)}\n`);

const texts = [];
for (const r of recs) {
  if (r?.type !== 'assistant/message') continue;
  const blocks = r.data?.message?.content;
  if (!Array.isArray(blocks)) continue;
  const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
  if (text) texts.push({ at: r.time, text });
}

for (const t of texts.slice(-COUNT)) {
  console.log(`--- assistant ${hhmm(t.at)} ---`);
  console.log(t.text.length > CHARS ? t.text.slice(-CHARS) + '  ...[truncated, showing the tail]' : t.text);
  console.log('');
}

// An unmatched tool call is the "still working / possibly parked" tail marker.
const openCalls = [];
const done = new Set();
for (const r of recs) {
  if (r?.type === 'tool/call') openCalls.push({ name: r.data?.name, callId: r.data?.callId, at: r.time });
  else if (r?.type === 'tool/result') done.add(r.data?.callId ?? r.data?.message?.toolCallId);
}
const stillOpen = openCalls.filter((c) => !done.has(c.callId));
console.log(`tool calls=${openCalls.length}  unresolved=${stillOpen.length}`);
if (stillOpen.length) {
  const o = stillOpen[stillOpen.length - 1];
  console.log(`  tail: ${o.name} (${hhmm(o.at)}) still in flight${stillOpen.length > 1 ? ` +${stillOpen.length - 1} earlier` : ''}`);
}
