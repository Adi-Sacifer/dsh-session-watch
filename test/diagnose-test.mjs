#!/usr/bin/env node
'use strict';
/*
 * diagnose-test.mjs - does the plugin work out WHY a session is stuck, and does it respect the
 * content boundary while doing it?
 *
 * WHY THIS NEEDS ITS OWN TEST
 *   The diagnosis is the part that reads conversation content, so two things can go wrong and both
 *   are silent:
 *     1. it can classify the wrong cause, which sends the user looking in the wrong place;
 *     2. it can read more than it disclosed, which breaks the boundary the user authorized.
 *   Neither shows up as a crash. Synthetic transcripts with known shapes are the only way to pin
 *   them down.
 *
 * Usage: node test/diagnose-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-diagnose-'));
process.env.DSH_HOME = ROOT;

const { diagnose } = await import('../plugin/diagnose.js');

const WS = '--C-Users-test-project--';
let seq = 0;
const rec = (type, data, at) => ({ type, seq: ++seq, time: at, data });

function write(id, records, mtime) {
  const dir = path.join(ROOT, 'sessions', WS, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat(records.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')))));
  const when = new Date(mtime);
  fs.utimesSync(file, when, when);
  return { file, mtime };
}

const now = Date.now();
const MIN = 60_000;

let pass = 0;
const failures = [];
const check = (label, actual, expected) => {
  if (actual === expected) { pass++; return; }
  failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/* ---- fixtures, one per cause ---- */

/* stuck on a tool call: the single most useful case, because the arguments name the command */
const toolHung = write('sess-tool', [
  rec('turn/start', { turn: 1 }, now - 40 * MIN),
  rec('step/start', { turn: 1, step: 1 }, now - 39 * MIN),
  rec('assistant/message', { message: { content: [{ type: 'text', text: '我先跑一下测试' }] } }, now - 35 * MIN),
  rec('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test -- --watch', description: 'run tests' }) }, now - 30 * MIN),
], now - 30 * MIN);

/* open turn with no tool call: the model owes a response */
const modelWaiting = write('sess-model', [
  rec('turn/start', { turn: 2 }, now - 20 * MIN),
  rec('step/start', { turn: 2, step: 1 }, now - 19 * MIN),
  rec('user/message', { content: [{ type: 'text', text: '帮我看看这个 bug' }], source: { kind: 'user' } }, now - 18 * MIN),
], now - 10 * MIN);

/* a tool result arrived, then nothing: the model may just be slow */
const afterResult = write('sess-after', [
  rec('turn/start', { turn: 3 }, now - 30 * MIN),
  rec('tool/call', { turn: 3, step: 1, callId: 'c2', name: 'read', arguments: '{}' }, now - 29 * MIN),
  rec('tool/result', { turn: 3, step: 1, message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'file contents' }] } }, now - 25 * MIN),
], now - 12 * MIN);

/* a cleanly finished turn: must NOT be diagnosed as stuck */
const finished = write('sess-done', [
  rec('turn/start', { turn: 4 }, now - 10 * MIN),
  rec('turn/end', { turn: 4, reason: { kind: 'completed' } }, now - 9 * MIN),
], now - 9 * MIN);

/* an error result, for the content layer */
const withError = write('sess-err', [
  rec('turn/start', { turn: 5 }, now - 40 * MIN),
  rec('user/message', { content: [{ type: 'text', text: '部署一下' }], source: { kind: 'user' } }, now - 39 * MIN),
  rec('tool/call', { turn: 5, step: 1, callId: 'c3', name: 'pwsh', arguments: JSON.stringify({ command: 'deploy.sh' }) }, now - 38 * MIN),
  rec('tool/result', { turn: 5, step: 1, message: { role: 'tool', toolCallId: 'c3', content: [{ type: 'text', text: 'Error: connection refused' }] }, error: { name: 'ToolError', code: 'ECONNREFUSED', reason: 'connection refused' } }, now - 37 * MIN),
  rec('tool/call', { turn: 5, step: 1, callId: 'c4', name: 'pwsh', arguments: JSON.stringify({ command: 'deploy.sh --retry' }) }, now - 36 * MIN),
], now - 36 * MIN);

/* 1. structure-only: the default when no content budget is given */
{
  const d = diagnose({ file: toolHung.file, mtime: toolHung.mtime, now, staleSeconds: 300 });
  check('default budget is zero', d.contentBudget, 0);
  check('cause is the hung tool call', d.cause, 'tool-call-hung');
  check('names the tool', d.tool, 'pwsh');
  check('reports how long it has been silent', d.quietSeconds >= 1700, true);
  check('structure-only reads no messages', d.read.length, 0);
  check('structure-only still says what it looked at', typeof d.structureRead, 'string');
  check('structure-only exposes no assistant text', d.lastAssistant, undefined);
}

/* 2. the single most useful fact: WHICH command it died on */
{
  const d = diagnose({ file: toolHung.file, mtime: toolHung.mtime, now, staleSeconds: 300 });
  check('detail names the command', /npm test/.test(String(d.detail)), true);
  check('confidence rises past twice the threshold', d.confidence, 'high');
}

/* 3. an open turn with no tool call is a different cause */
{
  const d = diagnose({ file: modelWaiting.file, mtime: modelWaiting.mtime, now, staleSeconds: 300 });
  check('cause is the model not responding', d.cause, 'model-not-responding');
  check('confidence stays low: a slow model looks identical', d.confidence, 'low');
  check('the summary admits it may just be slow', /也可能只是很慢/.test(d.summary), true);
}

/* 4. a returned result with no follow-up is its own, weaker case */
{
  const d = diagnose({ file: afterResult.file, mtime: afterResult.mtime, now, staleSeconds: 300 });
  check('cause is waiting after a result', d.cause, 'model-waiting-after-tool-result');
  check('that case is also low confidence', d.confidence, 'low');
}

/* 5. a finished turn must never be dressed up as a cause */
{
  const d = diagnose({ file: finished.file, mtime: finished.mtime, now, staleSeconds: 300 });
  check('a closed turn is not stuck', d.cause, 'not-stuck');
  check('and it says so plainly', /不该被报成卡住/.test(d.summary), true);
}

/* 6. the content layer, when a budget IS authorized */
{
  const d = diagnose({ file: withError.file, mtime: withError.mtime, now, staleSeconds: 300, contentBudget: 3, authorizedBy: 'test' });
  check('authorised read reports the budget', d.contentBudget, 3);
  check('authorised read records who allowed it', d.authorizedBy, 'test');
  check('it read the last human instruction', d.lastUser?.length, 1);
  check('the human text is what was typed', d.lastUser[0].text, '部署一下');
  check('it surfaced the error result', /connection refused/.test(String(d.lastErrorResult?.text)), true);
  check('it discloses what it read', d.read.length > 0, true);
  check('the disclosure names the categories', d.read.join(',').includes('你的指令'), true);
}

/* 7. reasoning blocks must never be read, budget or not */
{
  const withReasoning = write('sess-reason', [
    rec('turn/start', { turn: 6 }, now - 20 * MIN),
    rec('assistant/message', { message: { content: [
      { type: 'reasoning', text: 'PRIVATE-CHAIN-OF-THOUGHT-MARKER' },
      { type: 'text', text: 'visible answer' },
    ] } }, now - 19 * MIN),
    rec('tool/call', { turn: 6, step: 1, callId: 'c9', name: 'pwsh', arguments: JSON.stringify({ command: 'x' }) }, now - 18 * MIN),
  ], now - 18 * MIN);
  const d = diagnose({ file: withReasoning.file, mtime: withReasoning.mtime, now, staleSeconds: 300, contentBudget: 3, authorizedBy: 'test' });
  const dumped = JSON.stringify(d);
  check('reasoning text never appears in the result', dumped.includes('PRIVATE-CHAIN-OF-THOUGHT-MARKER'), false);
  check('visible text still does', dumped.includes('visible answer'), true);
}

/* 8. a missing file must be reported, not thrown */
{
  const d = diagnose({ file: path.join(ROOT, 'nope.jsonl.zstd'), mtime: now, now, staleSeconds: 300 });
  check('a missing transcript yields a cause, not an exception', d.cause, 'unreadable');
}

console.log(`sandbox: ${ROOT}`);
console.log(`${pass} assertion(s) passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
fs.rmSync(ROOT, { recursive: true, force: true });
