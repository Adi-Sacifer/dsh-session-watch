#!/usr/bin/env node
'use strict';
/*
 * peek-text.mjs - what is that OTHER session actually saying? (READ-ONLY)
 *
 * WHY THIS EXISTS
 *   The companion tool session-recall pins itself to the CURRENT conversation: its `turns`
 *   command always resolves to "me", by design. Its `timeline` command only prints user turns.
 *   So when you want the thing you actually care about - what the other agent is *saying* and
 *   how far it thinks it has got - neither command reaches it. This one does.
 *
 * WHAT IT PRINTS
 *   - the last N assistant TEXT blocks of the target session, so you can read its own account of
 *     where it is
 *   - the unresolved tool-call count at the tail, which is the honest "still working vs parked"
 *     signal (see lib/scan.mjs for why pairing must use data.message.toolCallId)
 *
 * Reasoning blocks live in the SAME content array as visible text, so they are filtered by
 * `type === 'text'`. Reading them out would leak private thinking and bloat the output.
 *
 * Reads another conversation's words, so it follows the same scope rule as session-recall:
 * only when the user asks for it in that turn.
 *
 * Usage: node peek-text.mjs <id | id-fragment | title-fragment> [count] [--chars 900]
 */
import fs from 'node:fs';
import { sessions, readRecords, titleOf } from './lib/scan.mjs';

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CHARS = Number(flag('chars', 900));
const COUNT = Number(pos[1] || 2);
const TARGET = pos[0];

if (!TARGET) {
  console.error('usage: peek-text.mjs <id|id-fragment|title-fragment> [count] [--chars N]');
  process.exit(2);
}

const all = sessions();
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

/* An unmatched tool call is the "still working / possibly parked" tail marker. */
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
