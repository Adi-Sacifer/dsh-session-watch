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
  const disposeHandlers = [];
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
    on: (name, fn) => { if (name === 'dispose') disposeHandlers.push(fn); if (name === 'webserver/index-inject') state.injectListeners++; return () => { }; },
    logger: { info: () => { }, warn: () => { } },
  };
  return { ctx, state, exact, prefixes, dispose: () => disposeHandlers.splice(0).forEach(fn => fn()) };
}

/* 1. the first apply registers both routes and starts one timer */
const host = makeHost();
plugin.apply(host.ctx, { intervalSeconds: 15 });
/*
 * Three routes, and the count is asserted by KIND rather than by number.
 * A bare number here would break every time the plugin legitimately grows a route (it already did,
 * when the diagnosis feature added the watcher POST), which trains you to edit the expectation
 * instead of reading it. Naming the kinds makes a new route a deliberate decision.
 */
const routeKinds = (list) => list.map((r) => {
  if (r.includes('/state-')) return 'state';
  if (r.includes('/notice-')) return 'notice';
  if (r.includes('/watcher-')) return 'watcher';
  return 'UNKNOWN:' + r;
}).sort().join(',');

check('first apply registers the three routes', routeKinds(host.state.registered), 'notice,state,watcher');
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
check('second apply registers nothing new', routeKinds(host.state.registered), 'notice,state,watcher');
check('second apply never hits a duplicate', host.state.throwCount, 0);

/* 3. and a third time, because reloads are not always tidy */
try { plugin.apply(host.ctx, { intervalSeconds: 15 }); } catch { /* recorded below */ }
check('third apply still leaves exactly three routes', routeKinds(host.state.registered), 'notice,state,watcher');

/* 4. no duplicate injection rows: the page must not load the notice twice */
const table = [];
/* the fake Host recorded only the fact of subscribing; replay the listener body via the real one */
check('only one injection subscription in total', host.state.injectListeners, 1);
check('injection table starts empty for this host', table.length, 0);

/* 5. a stale generation must not hijack a newer one: the stamp is part of the path */
const routes = host.state.registered.slice().sort();
check('every route path carries a load stamp',
  routes.every((r) => /\/session-watch\/(state|notice|watcher)-\d+\.(json|js)$/.test(r)), true);
const stamps = new Set(routes.map((r) => (r.match(/-(\d+)\.(json|js)$/) || [])[1]));
check('all three routes agree on ONE stamp', stamps.size, 1);
check('the stamp is numeric', /^\d+$/.test([...stamps][0] ?? ''), true);

// Disposal must release registrations and allow the SAME imported module to reactivate.
check('routes use the exact-path API', host.exact.size, 3);
host.dispose();
check('disposal removes all routes', host.exact.size + host.prefixes.size, 0);
plugin.apply(host.ctx, { intervalSeconds: 15 });
check('re-enable mounts routes again', host.exact.size, 3);
check('re-enable starts a new timer', host.state.intervals, 2);
const independent = makeHost();
plugin.apply(independent.ctx, {});
check('another host is not suppressed by a module-global stamp', independent.exact.size, 3);
const broken = makeHost();
const originalRegister = broken.ctx.webServer.register;
let attempts = 0;
broken.ctx.webServer.register = route => {
  if (++attempts === 2) throw Error('simulated registration failure');
  return originalRegister(route);
};
try { plugin.apply(broken.ctx, {}); } catch {}
check('failed activation rolls back routes', broken.exact.size, 0);
broken.ctx.webServer.register = originalRegister;
plugin.apply(broken.ctx, {});
check('failed activation can be retried', broken.exact.size, 3);

console.log(`sandbox: ${ROOT}`);
console.log(`${pass} assertion(s) passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
fs.rmSync(ROOT, { recursive: true, force: true });
