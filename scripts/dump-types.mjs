#!/usr/bin/env node
'use strict';
/*
 * dump-types.mjs - calibrate against the host's CURRENT transcript format (READ-ONLY)
 *
 * WHY YOU WOULD RUN THIS
 *   Every rule in this repo is derived from the record shape the host writes today:
 *   the record-type names, the magic-byte framing, and where the tool call/result ids live.
 *   If the host changes that format, the other scripts break in a quiet way - they still run,
 *   they just report nonsense. This tool is how you find out, in five seconds, instead of
 *   debugging a false report.
 *
 *   It prints:
 *     - the frame count and byte size (is the framing still magic-delimited?)
 *     - a histogram of record types (did the names change?)
 *     - the last 12 types in order (does a healthy turn still END on turn/end?)
 *     - the raw shape of one tool/call and one tool/result (where is the id, really?)
 *     - the resolved/unresolved call count under the documented rule
 *
 * Usage: node dump-types.mjs <session.v4.jsonl.zstd>
 *   Tip: pick one by running probe-sessions.mjs first - it prints full session ids.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
if (!file) { console.error('usage: node dump-types.mjs <session.v4.jsonl.zstd>'); process.exit(2); }

const buf = fs.readFileSync(file);
const M = [0x28, 0xb5, 0x2f, 0xfd];
const offs = [];
for (let i = 0; i < buf.length - 3; i++) {
  if (buf[i] === M[0] && buf[i + 1] === M[1] && buf[i + 2] === M[2] && buf[i + 3] === M[3]) offs.push(i);
}
const parts = [];
offs.push(buf.length);
for (let k = 0; k < offs.length - 1; k++) {
  try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], offs[k + 1]))); continue; } catch { }
  for (let j = k + 2; j < offs.length; j++) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], offs[j]))); k = j - 1; break; } catch { }
  }
}
console.log(`bytes=${buf.length}  frames=${offs.length - 1}`);

const types = {};
const last = [];
let nCall = 0; let nResult = 0; let firstCall = null; let firstResult = null;
const open = []; const done = new Set();
for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch { continue; }
  types[r.type] = (types[r.type] || 0) + 1;
  last.push(r.type);
  if (r.type === 'tool/call') {
    nCall++; if (!firstCall) firstCall = r;
    open.push({ callId: r.data?.callId, name: r.data?.name });
  } else if (r.type === 'tool/result') {
    nResult++; if (!firstResult) firstResult = r;
    // documented rule: the result's id is nested under data.message.toolCallId
    done.add(r.data?.callId ?? r.data?.message?.toolCallId);
  }
}
const unresolved = open.filter((c) => !done.has(c.callId));

console.log('\nRECORD TYPES:', JSON.stringify(types, null, 1));
console.log('\nLAST 12:', last.slice(-12).join(' | '));
console.log(`\ntool/call=${nCall}  tool/result=${nResult}  unresolved=${unresolved.length}`);
if (unresolved.length) console.log('  in flight:', JSON.stringify(unresolved.slice(-3)));

console.log('\n--- one tool/call (truncated) ---');
console.log(JSON.stringify(firstCall, null, 1)?.slice(0, 700) ?? '(none)');
console.log('\n--- one tool/result (truncated) ---');
console.log(JSON.stringify(firstResult, null, 1)?.slice(0, 700) ?? '(none)');

console.log('\n--- what the pairing rule needs ---');
console.log(`data.callId present on tool/call      : ${Boolean(firstCall?.data?.callId)}`);
console.log(`data.message.toolCallId on tool/result: ${Boolean(firstResult?.data?.message?.toolCallId)}`);
console.log('If either is false, the host changed the record shape: update tail() in probe-sessions.mjs,');
console.log('the unresolved count in peek-text.mjs, and this file together.');
