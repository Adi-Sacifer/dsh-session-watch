#!/usr/bin/env node
'use strict';
/*
 * client-route-test.mjs - the client half must never poll a route that does not exist.
 *
 * WHY THIS EXISTS
 *   client.js shipped with `const ROUTE = '/session-watch/state'` and polled it every 5 seconds.
 *   That route has never existed - the host registers `/session-watch/state-<load-stamp>.json`,
 *   stamped so a reinstalled plugin cannot collide with the previous generation's routes. So the
 *   poll 404'd forever, the page console collected >1000 errors, and the user reported it as
 *   "DevTools 一直在触发"; the notice it was meant to draw never appeared at all.
 *
 *   Three things are pinned here, because any one of them silently brings the flood back:
 *     1. the source contains no hard-coded state route;
 *     2. when the injected notice owns the UI, this half does not fetch at all;
 *     3. with no injected tag there is no URL, so it still does not fetch.
 *   The one case where it MAY fetch is the tagged-URL case, and it must use that exact URL.
 *
 * HOW
 *   client.js is a module-loader script: it calls window.__ModuleLoader__.load(...) and builds
 *   elements with React.createElement. Both are faked just enough to drive the component's effect,
 *   which is where the fetching lives. No browser needed, so this runs in the normal suite.
 *
 * Usage: node test/client-route-test.mjs [path/to/client.js]
 *   The optional argument exists so the INSTALLED copy can be checked with the same assertions -
 *   the installed bytes are what a restart loads, and they are not always in sync with the repo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(here, '..', 'plugin', 'client.js');

let pass = 0;
const failures = [];
const check = (label, actual, expected) => {
  if (actual === expected) { pass++; return; }
  failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/* ------------------------------------------------------------------ 1. static guard */

const source = fs.readFileSync(CLIENT, 'utf8');
check('no hard-coded state route in the source', /['"]\/session-watch\/state['"]/.test(source), false);

/* ------------------------------------------------------------------ 2. drive the component */

/** Load client.js against fake DOM/loader globals and drive one render + its effect. */
async function run({ loaderTagUrl = null, injectedNoticeRunning = false, hostNoticeInDom = false } = {}) {
  const fetches = [];
  const timers = [];
  const cleanups = [];
  const elements = new Map();

  const tag = loaderTagUrl === null ? null : {
    getAttribute: (name) => (name === 'data-session-watch-state' ? loaderTagUrl : null),
  };
  if (tag) elements.set('session-watch-notice-loader', tag);
  if (hostNoticeInDom) elements.set('session-watch-notice', { id: 'session-watch-notice' });

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };

  let captured = null;
  globalThis.window = {
    __ModuleLoader__: { load: (def) => { captured = def; } },
  };
  if (injectedNoticeRunning) globalThis.window.__sessionWatchNotice = true;
  globalThis.document = { getElementById: (id) => elements.get(id) ?? null };
  globalThis.fetch = async (url) => { fetches.push(String(url)); return { ok: false }; };
  globalThis.setInterval = (fn) => { timers.push(fn); return timers.length; };
  globalThis.clearInterval = () => { };

  try {
    await import(`${pathToFileURL(CLIENT).href}?case=${Math.random()}`);
    const react = {
      createElement: (...args) => ({ __el: args }),
      useState: (init) => [init, () => { }],
      useEffect: (fn) => { cleanups.push(fn); },
    };
    const plugin = captured.factory((name) => {
      if (name !== 'react') throw new Error(`unexpected require(${name})`);
      return react;
    });

    let component = null;
    plugin.apply({
      slots: {
        /* inject(slot, cb) - the callback is what registers; a fake that ignores it captures nothing */
        inject: (_slot, cb) => cb(),
        register: (_opts, fn) => { component = fn; },
      },
    });
    check('the plugin registers a component', typeof component, 'function');

    component();
    for (const fn of cleanups) fn();
    /* the effect calls read() synchronously before scheduling the interval; let its promise settle */
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.setInterval = previous.setInterval;
    globalThis.clearInterval = previous.clearInterval;
  }

  return { fetches, timers };
}

{
  const { fetches } = await run({ injectedNoticeRunning: true, loaderTagUrl: '/session-watch/state-9.json' });
  check('★ injected notice running -> not a single fetch (this was the 404 flood)', fetches.length, 0);
}

{
  const { fetches } = await run({ loaderTagUrl: '/session-watch/state-9.json', hostNoticeInDom: true });
  check('host notice already in the DOM -> no fetch (one notice, not two)', fetches.length, 0);
}

{
  const { fetches } = await run({});
  check('no injected tag -> no URL, so no fetch at all', fetches.length, 0);
}

{
  const { fetches, timers } = await run({ loaderTagUrl: '/session-watch/state-9.json' });
  check('tagged URL is used verbatim, once per read', fetches.length, 1);
  check('and it is the stamped route, not a bare one', fetches[0], '/session-watch/state-9.json');
  check('the poll keeps running', timers.length, 1);
}

console.log('client-route-test: dsh-session-watch client half');
console.log(`${pass} assertion(s) passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
