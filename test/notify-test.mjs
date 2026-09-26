#!/usr/bin/env node
'use strict';
/*
 * notify-test.mjs - when a session is stuck, does the plugin actually TELL someone, with a cause?
 *
 * WHY THIS IS THE IMPORTANT ONE
 *   The user's question was "if it finds a problem, will it work out why and notify me". A detector
 *   that reports into a log nobody reads answers "no". So the contract worth pinning is: a stuck
 *   session produces a real message to a live conversation, that message names the cause, and it is
 *   delivered exactly once per cause rather than every tick.
 *
 *   Everything here runs against synthetic transcripts and a fake agent registry, so no live
 *   conversation is touched.
 *
 * Usage: node test/notify-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-notify-'));
process.env.DSH_HOME = ROOT;

/*
 * Each scenario needs its OWN module instance.
 *
 * apply() is guarded so that one generation is only ever mounted once per process - that guard is
 * what keeps a re-apply from throwing on the routes or stacking a second timer, and it is pinned by
 * test/reload-safety.mjs. The consequence here is deliberate: to test several configurations in one
 * process, each gets a fresh instance via a distinct specifier.
 */
let instance = 0;
const freshPlugin = () => import(`../plugin/index.js?scenario=${++instance}`);

const WS = '--C-Users-test-project--';
let seq = 0;
const rec = (type, data, at) => ({ type, seq: ++seq, time: at, data });

function writeStuck(id, mtime) {
  const dir = path.join(ROOT, 'sessions', WS, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat([
    rec('turn/start', { turn: 1 }, mtime - 60_000),
    rec('assistant/message', { message: { content: [{ type: 'text', text: '我来跑一下部署脚本' }] } }, mtime - 50_000),
    rec('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'deploy.sh --apply' }) }, mtime),
  ].map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')))));
  const when = new Date(mtime);
  fs.utimesSync(file, when, when);
}

const now = Date.now();
const MIN = 60_000;
writeStuck('sess-victim', now - 45 * MIN);

let pass = 0;
const failures = [];
const check = (label, actual, expected) => {
  if (actual === expected) { pass++; return; }
  failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/*
 * A fake Host: the plugin's real apply() runs against it, and the timer is captured so the test
 * drives the tick itself instead of waiting.
 */
function makeHost({ roots = [], withAgents = true } = {}) {
  const state = { routes: {}, ticks: [], delivered: [], logged: [], emitted: [] };
  const makeAgent = (id) => ({
    id,
    followup(message) { state.delivered.push({ to: id, message }); },
  });
  const registry = roots.map(makeAgent);
  const ctx = {
    interval: (fn, ms) => { state.tick = fn; state.intervalMs = ms; return () => { }; },
    timeout: () => () => { },
    webServer: { register: (route) => { state.routes[`${route.method} ${route.path}`] = route; return () => { }; } },
    emit: (name, payload) => { state.emitted.push({ name, payload }); },
    on: () => () => { },
    logger: { info: (m) => state.logged.push(m), warn: (m) => state.logged.push('WARN ' + m) },
  };
  if (withAgents) ctx.agents = { roots: () => registry, get: (id) => registry.find((a) => a.id === id) };
  state.registry = registry;
  return { ctx, state };
}

/* 1. a stuck session produces one message, naming the cause and the command */
{
  const host = makeHost({ roots: ['watcher-1', 'watcher-2'] });
  const plugin = await freshPlugin();
  plugin.apply(host.ctx, { intervalSeconds: 15, staleSeconds: 300, windowMinutes: 1440 });
  host.state.tick();

  check('a message was delivered', host.state.delivered.length >= 1, true);

  /*
   * The SHAPE matters as much as the words. `followup` stores its argument unnormalized and the
   * loop later appends it as a `user/message` event, so a bare string would be appended as invalid
   * data. These assertions are what stop that regression, and they were written because the first
   * implementation did pass a string.
   */
  const message = host.state.delivered[0]?.message;
  check('the payload is a message object, not a string', typeof message, 'object');
  check('it carries a role', message?.role, 'user');
  check('it carries a fresh id', typeof message?.id === 'string' && message.id.length >= 32, true);
  check('its content is a text block array', Array.isArray(message?.content) && message.content[0]?.type, 'text');
  check('it declares its own source', message?.source?.kind, 'session-watch');
  check('it does NOT claim to be the human', message?.source?.kind === 'user', false);

  const text = message?.content?.[0]?.text ?? '';
  check('it says a session is stuck', /卡住了/.test(text), true);
  check('it names the cause', /工具 pwsh/.test(text), true);
  check('it names the exact command', /deploy\.sh --apply/.test(text), true);
  check('it states it did not touch the session', /没有碰它|仍然停在那里/.test(text), true);
  check('it discloses what was read', /读了什么/.test(text), true);
  check('it offers next actions', /要我/.test(text), true);

  /* both roots hear about it, and neither is the victim */
  const targets = host.state.delivered.map((d) => d.to);
  check('every root conversation is told', targets.sort().join(','), 'watcher-1,watcher-2');
  check('the stuck session is never told about itself', targets.includes('sess-victim'), false);

  /* the same diagnosis must also be visible in the state the UI polls */
  const stateRoute = Object.keys(host.state.routes).find((k) => /^GET \/session-watch\/state-.*\.json$/.test(k));
  let served = null;
  host.state.routes[stateRoute].handler({}, { writeHead: () => { }, end: (b) => { served = JSON.parse(b); } });
  check('state exposes the cause', Boolean(served.stuck[0]?.cause), true);
  check('state exposes the summary', /pwsh/.test(String(served.stuck[0]?.summary)), true);
  check('state records what was read', Array.isArray(served.stuck[0]?.read), true);
  check('state carries the notification log', Array.isArray(served.notifications), true);
}

/* 2. it must not repeat itself every tick */
{
  const host = makeHost({ roots: ['watcher-1'] });
  const plugin = await freshPlugin();
  plugin.apply(host.ctx, { intervalSeconds: 15, staleSeconds: 300, windowMinutes: 1440 });
  host.state.tick();
  host.state.tick();
  host.state.tick();
  check('reported once per cause, not per tick', host.state.delivered.length, 1);
}

/* 3. diagnosis can be turned off, and then no message is sent */
{
  const host = makeHost({ roots: ['watcher-1'] });
  const plugin = await freshPlugin();
  plugin.apply(host.ctx, { intervalSeconds: 15, staleSeconds: 300, windowMinutes: 1440, diagnose: false });
  host.state.tick();
  check('diagnosis off means no message', host.state.delivered.length, 0);
}

/* 4. notification can be turned off while diagnosis stays on */
{
  const host = makeHost({ roots: ['watcher-1'] });
  const plugin = await freshPlugin();
  plugin.apply(host.ctx, { intervalSeconds: 15, staleSeconds: 300, windowMinutes: 1440, notifyOnStuck: false });
  host.state.tick();
  check('notifications off means no message', host.state.delivered.length, 0);
}

/* 5. a Host with no agent registry must not crash the plugin */
{
  const host = makeHost({ withAgents: false });
  const plugin = await freshPlugin();
  let threw = null;
  try {
    plugin.apply(host.ctx, { intervalSeconds: 15, staleSeconds: 300, windowMinutes: 1440 });
    host.state.tick();
  } catch (error) { threw = String(error?.message ?? error); }
  check('works without ctx.agents', threw, null);
  check('and logs no warning', host.state.logged.some((l) => l.startsWith('WARN')), false);
}

/* 6. contentBudget 0 keeps the diagnosis structure-only, even though notification still happens */
{
  const host = makeHost({ roots: ['watcher-1'] });
  const plugin = await freshPlugin();
  plugin.apply(host.ctx, { intervalSeconds: 15, staleSeconds: 300, windowMinutes: 1440, diagnosisMessages: 0 });
  host.state.tick();
  const text = host.state.delivered[0]?.message?.content?.[0]?.text ?? '';
  check('structure-only still notifies', host.state.delivered.length, 1);
  check('structure-only says it read no content', /只看了结构信息/.test(text), true);
  check('structure-only leaks no assistant sentence', /我来跑一下部署脚本/.test(text), false);
}

/* 7. an explicitly pinned target is used instead of every root */
{
  const host = makeHost({ roots: ['watcher-1', 'watcher-2'] });
  const plugin = await freshPlugin();
  plugin.apply(host.ctx, { intervalSeconds: 15, staleSeconds: 300, windowMinutes: 1440, notifySessionId: 'watcher-2' });
  host.state.tick();
  check('only the pinned target is told', host.state.delivered.map((d) => d.to).join(','), 'watcher-2');
}

/* 8. a pinned target that wants tuning must not silently report itself */
{
  const host = makeHost({ roots: ['watcher-1'] });
  const plugin = await freshPlugin();
  plugin.apply(host.ctx, { intervalSeconds: 15, staleSeconds: 300, windowMinutes: 1440, notifySessionId: 'sess-victim' });
  host.state.tick();
  check('a pinned target equal to the victim yields no self-report', host.state.delivered.length, 0);
}

console.log(`sandbox: ${ROOT}`);
console.log(`${pass} assertion(s) passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
fs.rmSync(ROOT, { recursive: true, force: true });

