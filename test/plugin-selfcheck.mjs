#!/usr/bin/env node
'use strict';
/*
 * plugin-selfcheck.mjs - drive the plugin's real apply() against synthetic transcripts.
 *
 * WHY
 *   The host plugin carries its own copy of the verdict rule, because it must not depend on a
 *   workspace path. Two copies of a judgement drift, so this test exercises the PLUGIN's copy the
 *   same way test/selftest.mjs exercises the tools' copy: a throwaway DSH_HOME, transcripts in the
 *   real frame format, and the verdict read back out of the plugin's own web route.
 *
 *   It also proves the plugin needs no Host: a fake ctx with just the four members apply() uses
 *   (interval, webServer.register, emit, logger) is enough, which is exactly the contract the
 *   plugin docs describe.
 *
 * Usage: node test/plugin-selfcheck.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-plugin-check-'));
process.env.DSH_HOME = ROOT;
const plugin = await import('../plugin/index.js');

const WS = '--C-Users-test-project--';
let seq = 0;
const rec = (type, data, at) => ({ type, seq: ++seq, time: at, data });

function writeTranscript(id, records, mtime) {
  const dir = path.join(ROOT, 'sessions', WS, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat(records.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')))));
  const when = new Date(mtime);
  fs.utimesSync(file, when, when);
}

const now = Date.now();
const MIN = 60_000;

/* one idle session (closed turn) and one stuck session (open call, silent for an hour) */
writeTranscript('sess-idle', [
  rec('turn/start', { turn: 1 }, now - 20_000),
  rec('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }, now - 15_000),
  rec('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [] } }, now - 14_000),
  rec('turn/end', { turn: 1 }, now - 10_000),
], now - 10_000);

writeTranscript('sess-stuck', [
  rec('turn/start', { turn: 2 }, now - 61 * MIN),
  rec('tool/call', { turn: 2, step: 1, callId: 'c2', name: 'bash', arguments: '{}' }, now - 60 * MIN),
], now - 60 * MIN);

/* fake Host context: only what apply() actually uses */
const registered = {};
const emitted = [];
const logs = [];
const listeners = {};
const subscribed = [];
const timeouts = [];
let intervalCount = 0;
let intervalConfig = null;
const ctx = {
  interval: (fn, ms) => { intervalCount++; intervalConfig = { fn, ms }; return () => { }; },
  timeout: (fn, ms) => { timeouts.push({ fn, ms }); return () => { }; },
  webServer: { register: (route) => { registered[route.path] = route; return () => { }; } },
  emit: (name, payload) => { emitted.push({ name, payload }); },
  on: (name, listener) => { subscribed.push(name); listeners[name] = listener; return () => { }; },
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m) },
};

let pass = 0;
const failures = [];
const check = (label, actual, expected) => {
  if (actual === expected) { pass++; return; }
  failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/* 1. apply() must register a timer and a route, and touch nothing else */
plugin.apply(ctx, { intervalSeconds: 15, staleSeconds: 300, windowMinutes: 1440 });

/*
 * Route paths carry a per-load stamp, so they are found by shape. This is not cosmetic: with fixed
 * paths, reinstalling into a running Host threw `duplicate route "/session-watch/state"`, failed the
 * new activation, and left the previous instance orphaned but still serving. Matching by shape here
 * also means the test keeps passing when the plugin is loaded twice in one process.
 */
const stateKey = Object.keys(registered).find((k) => /^\/session-watch\/state-.*\.json$/.test(k));
const noticeKey = Object.keys(registered).find((k) => /^\/session-watch\/notice-.*\.js$/.test(k));
check('registered a state route', typeof stateKey, 'string');
check('state route is a GET', stateKey && registered[stateKey].method, 'GET');
check('registered an interval', intervalConfig?.ms, 15_000);
/*
 * This fake ctx has NO `agents` member - which the plugin now REPORTS instead of silently tolerating.
 * A watchdog that cannot deliver a diagnosis to anybody is indistinguishable from one with nothing to
 * say, so the warning is issued once at apply() and the same fact travels in the snapshot. The
 * assertion is therefore "it said so, exactly once", not "it stayed quiet".
 *
 * (Nothing else in apply() may warn; a warning here is how a broken activation would show up.)
 */
check('warns exactly once that it cannot deliver a diagnosis',
  logs.filter((l) => l.startsWith('WARN') && /ctx\.agents is unavailable/.test(l)).length, 1);
check('and no other warning during apply',
  logs.filter((l) => l.startsWith('WARN')).length, 1);

/* 2. the route must answer with the snapshot shape the UI consumes */
let served = null;
registered[stateKey].handler({ method: 'GET' }, {
  writeHead: () => { },
  end: (body) => { served = JSON.parse(body); },
});

check('snapshot has a timestamp', typeof served?.at, 'number');
check('snapshot reports the stale threshold it used', served?.staleSeconds, 300);
check('snapshot exposes counts', typeof served?.counts?.stuck, 'number');
check('snapshot lists sessions', Array.isArray(served?.sessions), true);

/* 3. the verdicts themselves */
const stateOf = (id) => served.sessions.find((s) => s.id === id)?.state;
check('closed turn -> idle', stateOf('sess-idle'), 'idle');
check('open call, silent 60min -> stuck', stateOf('sess-stuck'), 'stuck');
check('counts.stuck', served.counts.stuck, 1);
check('stuck entry carries the tool name', served.stuck[0]?.tail, 'tool/call(bash)');
check('stuck entry carries the quiet duration', served.stuck[0]?.quietSeconds >= 3500, true);

/* 4. a stuck-at-startup session must appear in the FIRST snapshot, not only after a transition */
check('first snapshot already flags the stuck session', served.stuck.length, 1);

/* 5. re-running the tick must be idempotent for an unchanged world (no event spam) */
emitted.length = 0;
registered[stateKey].handler({}, { writeHead: () => { }, end: () => { } });
const changeEvents = emitted.filter((e) => e.name === 'session-watch/changed');
check('no repeat event when nothing changed', changeEvents.length, 0);

/* 6. the zstd capability must be reported honestly in the snapshot when unavailable */
check('snapshot states whether reading is possible', typeof served.available, 'boolean');

/*
 * 7. event subscription, not only the timer.
 *    The objective asks for both, and they do different jobs: the timer is when a hang is FLAGGED
 *    (only silence reveals a hang), while events are how a session that starts moving again is
 *    noticed immediately instead of on the next tick. These assertions hold that split, including
 *    the deliberate narrowness - reacting to every tool result would make a watcher a busy loop.
 */
check('subscribed to session events', subscribed.includes('session/event'), true);
check('subscribed to session disposal', subscribed.includes('session/disposed'), true);
check('subscribed to agent status changes', subscribed.includes('agent/status'), true);
check('did not subscribe to the noisy per-tool firehose', subscribed.includes('tools/result'), false);
check('one periodic timer still runs', intervalCount, 1);

/* a transition out of "working" must schedule a coalesced rescan, not a scan per event */
const timeoutsBefore = timeouts.length;
listeners['session/event']({ id: 'sess-stuck' }, { type: 'turn/end' });
listeners['session/event']({ id: 'sess-stuck' }, { type: 'tool/result' });
listeners['agent/status']({ agent: { session: { id: 'sess-idle' } }, status: 'idle' });
check('events coalesce into one scheduled rescan', timeouts.length - timeoutsBefore, 1);
check('the rescan is debounced, not immediate', timeouts[timeouts.length - 1]?.ms, 250);

/* firing the coalesced rescan must not throw and must re-read the world */
let rescanThrew = null;
try { timeouts[timeouts.length - 1].fn(); } catch (error) { rescanThrew = String(error?.message ?? error); }
check('the coalesced rescan runs cleanly', rescanThrew, null);
check('a rescan does not stack another timer', intervalCount, 1);

/* an event listener must never break the Host, whatever shape it is handed */
let malformedThrew = null;
try {
  listeners['session/event'](null, null);
  listeners['agent/status']({});
  listeners['session/event'](undefined, { type: 'turn/end' });
} catch (error) { malformedThrew = String(error?.message ?? error); }
check('malformed events are swallowed, not rethrown', malformedThrew, null);

/*
 * 7. the UI path that does NOT need a restart.
 *    A `dsh.client` half is only served once the browser's module graph knows the package, and
 *    that graph is built at boot - so an installed-into-a-running-Host bundle 404s until a restart
 *    (verified against the live Host). The index-injection route sidesteps it: the plugin serves
 *    its own script and adds one <script> row to the served HTML. These assertions pin that path,
 *    because losing it silently would leave the plugin watching with no way to show anything.
 */
check('registered the notice script route', typeof noticeKey, 'string');

let servedScript = null;
let servedType = null;
registered[noticeKey].handler({}, {
  writeHead: (status, headers) => { servedType = headers['content-type']; },
  end: (body) => { servedScript = body; },
});
check('notice is served as javascript', String(servedType).startsWith('application/javascript'), true);
check('notice script is non-trivial', servedScript.length > 500, true);
/* it must be a plain browser script, not something that needs the module loader */
check('notice does not depend on the module loader', servedScript.includes('__ModuleLoader__'), false);
check('notice reads its state URL from its own tag', servedScript.includes('data-session-watch-state'), true);
check('notice renders nothing until a session is flagged', servedScript.includes('stuck.length === 0'), true);

/*
 * A watchdog that cannot read transcripts must SAY SO. Staying silent makes a broken monitor
 * indistinguishable from a healthy system - the exact failure mode this repo exists to prevent -
 * so the notice has to branch on the host's `available` flag rather than only on the stuck list.
 */
check('notice handles the host reporting it cannot read', servedScript.includes('available === false'), true);
check('notice names the failure instead of staying silent', servedScript.includes('没有在工作'), true);
check('notice explains why, from the host', servedScript.includes('state.reason'), true);

/* the index-injection listener must add exactly one script row that loads the notice */
check('subscribed to the index-injection event', subscribed.includes('webserver/index-inject'), true);
const injectionTable = [];
listeners['webserver/index-inject'](injectionTable);
check('injected exactly one row', injectionTable.length, 1);
check('the row is a script row', injectionTable[0]?.kind, 'script');
check('the row carries executable text', typeof injectionTable[0]?.text === 'string' && injectionTable[0].text.length > 0, true);
const injected = String(injectionTable[0]?.text);
check('the injected row points at the stamped notice route', injected.includes(noticeKey), true);
check('the injected row hands over the stamped state route', injected.includes(stateKey), true);
check('the injected row does not rewrite the document', injected.includes('document.write'), false);
/* the filename and the stamped path must agree, or the page loads a 404 */
check('notice fetch path matches the registered route', noticeKey.startsWith('/session-watch/notice-'), true);
check('state path matches the registered route', stateKey.startsWith('/session-watch/state-'), true);

console.log(`sandbox: ${ROOT}  (node ${process.versions.node}, zstd=${served.available ? 'available' : 'MISSING'})`);
console.log(`${pass} assertion(s) passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
fs.rmSync(ROOT, { recursive: true, force: true });
