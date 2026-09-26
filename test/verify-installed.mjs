#!/usr/bin/env node
'use strict';
/*
 * verify-installed.mjs - prove the INSTALLED plugin loads and applies, before anyone restarts.
 *
 * WHY THIS EXISTS AS A SEPARATE STEP
 *   The installed copy under the profile's node_modules is what a restart will load, and it is NOT
 *   always in sync with the repo: an earlier round found the installed copy missing two files the
 *   new index.js imports, which would have crashed the plugin on startup. Checking that the
 *   installed bytes actually run is different from checking that the repo's tests pass.
 *
 * Usage: node test/verify-installed.mjs [install-dir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2] ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@local', 'dsh-session-watch');

if (!fs.existsSync(path.join(dir, 'index.js'))) {
  console.log(`verify-installed: nothing installed at ${dir} - skipping`);
  process.exit(0);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-installed-'));
process.env.DSH_HOME = ROOT;
fs.mkdirSync(path.join(ROOT, 'sessions'), { recursive: true });

let pass = 0;
const failures = [];
const check = (label, actual, expected) => {
  if (actual === expected) { pass++; return; }
  failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/* every file index.js depends on must be present in the installed copy */
for (const dep of ['index.js', 'notice.js', 'diagnose.js', 'archive.js']) {
  check(`installed copy ships ${dep}`, fs.existsSync(path.join(dir, dep)), true);
}

const plugin = await import(pathToFileURL(path.join(dir, 'index.js')).href);

check('exports apply', typeof plugin.apply, 'function');
check('declares its dependencies', Array.isArray(plugin.inject), true);
check('injects agents (needed to notify)', plugin.inject.includes('agents'), true);

const routes = {};
const events = [];
let timers = 0;
let warned = null;
const ctx = {
  interval: () => { timers++; return () => { }; },
  timeout: () => () => { },
  webServer: { register: (r) => { routes[r.path] = r; return () => { }; } },
  emit: () => { },
  on: (n) => { events.push(n); return () => { }; },
  agents: { roots: () => [], get: () => undefined },
  logger: { info: () => { }, warn: (m) => { warned = m; } },
};

let threw = null;
try {
  plugin.apply(ctx, { intervalSeconds: 15, staleSeconds: 300, windowMinutes: 1440 });
} catch (error) { threw = String(error?.message ?? error); }

check('apply() does not throw', threw, null);
check('started exactly one timer', timers, 1);
check('registered three routes', Object.keys(routes).length, 3);
check('subscribed to session events', events.includes('session/event'), true);
check('subscribed to the injection event', events.includes('webserver/index-inject'), true);
check('logged no warning', warned, null);

console.log(`verify-installed: ${dir}`);
console.log(`${pass} assertion(s) passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
fs.rmSync(ROOT, { recursive: true, force: true });
