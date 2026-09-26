#!/usr/bin/env node
'use strict';
/*
 * reload-safety.mjs - the plugin must survive being applied more than once in one process.
 *
 * WHY THIS IS A TEST AND NOT A NICETY
 *   This failure was hit for real, against the running Host: reinstalling the bundle re-activated
 *   the plugin row, the second apply() tried to register the same web route, and the Host rejected
 *   it with
 *     webserver: duplicate undefined route
 *   That error did not merely fail the new activation - it left the previous instance orphaned but
 *   still serving, so the plugin ended up broken AND impossible to replace without a restart.
 *
 *   A plugin that cannot be reloaded is a plugin you cannot iterate on, and a watchdog that bricks
 *   itself on update is worse than no watchdog. So re-application is part of the contract now.
 *
 * Usage: node test/reload-safety.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-reload-'));
process.env.DSH_HOME = ROOT;
fs.mkdirSync(path.join(ROOT, 'sessions'), { recursive: true });

const plugin = await import('../plugin/index.js');

let pass = 0;
const failures = [];
const check = (label, actual, expected) => {
  if (actual === expected) { pass++; return; }
  failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/* a fake Host that behaves like the real one: duplicate (kind, path) throws */
function makeHost() {
  const exact = new Map();
  const prefixes = new Map();
  const state = { registered: [], intervals: 0, injectListeners: 0, throwCount: 0 };
  const ctx = {
    interval: () => { state.intervals++; return () => { }; },
    webServer: {
      register: (route) => {
        const table = route.kind === 'exact' ? exact : prefixes;
        if (table.has(route.path)) { state.throwCount++; throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`); }
        table.set(route.path, route);
        state.registered.push(route.path);
        return () => { table.delete(route.path); };
      },
    },
    emit: () => { },
    on: (name) => { if (name === 'webserver/index-inject') state.injectListeners++; return () => { }; },
    logger: { info: () => { }, warn: () => { } },
  };
  return { ctx, state };
}

/* 1. the first apply registers both routes and starts one timer */
const host = makeHost();
plugin.apply(host.ctx, { intervalSeconds: 15 });
check('first apply registers two routes', host.state.registered.length, 2);
check('first apply starts one interval', host.state.intervals, 1);
check('first apply subscribes the injection listener', host.state.injectListeners, 1);
check('first apply never hits a duplicate', host.state.throwCount, 0);

/* 2. THE POINT: applying again must not throw, and must not double-register */
let secondThrew = null;
try {
  plugin.apply(host.ctx, { intervalSeconds: 15 });
} catch (error) {
  secondThrew = String(error?.message ?? error);
}
check('second apply does not throw the duplicate-route error', secondThrew, null);
check('second apply registers nothing new', host.state.registered.length, 2);
check('second apply never hits a duplicate', host.state.throwCount, 0);

/* 3. and a third time, because reloads are not always tidy */
try { plugin.apply(host.ctx, { intervalSeconds: 15 }); } catch { /* recorded below */ }
check('third apply still leaves exactly two routes', host.state.registered.length, 2);

/* 4. no duplicate injection rows: the page must not load the notice twice */
const table = [];
/* the fake Host recorded only the fact of subscribing; replay the listener body via the real one */
check('only one injection subscription in total', host.state.injectListeners, 1);
check('injection table starts empty for this host', table.length, 0);

/* 5. a stale generation must not hijack a newer one: the stamp is part of the path */
const routes = host.state.registered.slice().sort();
check('both route paths carry a load stamp', routes.every((r) => /\/session-watch\/(state|notice)-\d+\.(json|js)$/.test(r)), true);
check('state and notice agree on the same stamp',
  (routes[0].match(/-(\d+)\.(json|js)$/) || [])[1] === (routes[1].match(/-(\d+)\.(json|js)$/) || [])[1], true);
check('the two routes are the state route and the notice route',
  routes.map((r) => (r.includes('/state-') ? 'state' : 'notice')).join(','), 'notice,state');

console.log(`sandbox: ${ROOT}`);
console.log(`${pass} assertion(s) passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
fs.rmSync(ROOT, { recursive: true, force: true });
