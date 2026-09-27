#!/usr/bin/env node
'use strict';
/*
 * pending.mjs - WHAT is that session actually waiting on?
 *
 * WHY THIS EXISTS
 *   probe-sessions.mjs tells you a session looks stuck: silent, with an unmatched tool/call. That is
 *   the right answer to "should I worry", and the wrong answer to "why". The two are very different
 *   situations and they read identically from the outside:
 *
 *     a tool that will never return        -> the session is dead in the water
 *     a tool with a 15-minute timeout      -> the session is fine, it is just running a test suite
 *
 *   The first version of this repo reported the second case as stuck - at 180s, against a `pwsh`
 *   call whose own timeout was 900s. So this script exists to print the ONE fact that separates
 *   them: the arguments of the call that has not come back. A command with a long timeout in it
 *   answers the question by itself.
 *
 * SCOPE - the same line this repo draws everywhere
 *   This reads the transcript's STRUCTURE plus the pending tool call's own arguments (a command
 *   line, a file path). It does not print assistant replies, user messages, or reasoning. Reading
 *   what a conversation is SAYING is `peek-text.mjs`, and that one needs the user to ask.
 *
 * Usage:
 *   node scripts/pending.mjs <id|fragment|title> [more fragments...]
 *
 * Exit code is 0 whether or not anything is pending; this is a look, not a verdict.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SESS_ROOT, sessions, titleOf, readRecords, tail } from './lib/scan.mjs';

/** Resolve an id fragment or a title fragment to exactly one session, or explain the ambiguity. */
function resolve(fragment) {
  const all = sessions();
  const byId = all.filter((s) => s.id.includes(fragment));
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) return { error: `"${fragment}" matches ${byId.length} session ids: ${byId.map((s) => s.id).join(', ')}` };
  const byTitle = all.filter((s) => String(titleOf(s.id) || '').includes(fragment));
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) return { error: `"${fragment}" matches ${byTitle.length} titles: ${byTitle.map((s) => titleOf(s.id)).join(' | ')}` };
  return { error: `nothing matches "${fragment}" (${all.length} sessions on disk under ${SESS_ROOT})` };
}

const fragments = process.argv.slice(2);
if (fragments.length === 0) {
  console.error('usage: node scripts/pending.mjs <id|fragment|title> [more...]');
  process.exit(2);
}

let pendingCount = 0;

for (const fragment of fragments) {
  const found = resolve(fragment);
  if (found.error) { console.log(`--- ${fragment} ---\n  ${found.error}\n`); continue; }

  const st = fs.statSync(found.file);
  const records = readRecords(found.file);
  /* tail() already pairs tool/call with tool/result using the nested data.message.toolCallId field,
   * and now carries the pending call's arguments too - no need to re-derive that rule here */
  const t = tail(records);
  const pending = t.openTool;

  const quietS = Math.round((Date.now() - st.mtimeMs) / 1000);
  const title = titleOf(found.id) || '(untitled)';
  console.log(`--- ${title} ---`);
  console.log(`  ${found.id}`);
  console.log(`  quiet ${quietS}s   last write ${new Date(st.mtimeMs).toLocaleTimeString()}   records ${records.length}`);

  if (pending) {
    pendingCount++;
    const ageS = pending.at ? Math.round((Date.now() - pending.at) / 1000) : null;
    console.log(`  >>> WAITING ON A TOOL: ${pending.name}${ageS === null ? '' : `  (started ${ageS}s ago)`}`);
    let args = pending.args;
    try { args = JSON.stringify(JSON.parse(args), null, 2); } catch { /* keep the raw string */ }
    for (const line of String(args ?? '(no arguments)').split('\n')) console.log(`      ${line}`);
    /* the single most useful inference this script can make, stated as an inference */
    const m = /timeoutMs"?\s*[:=]\s*(\d+)/.exec(String(pending.args ?? ''));
    if (m) {
      const budget = Math.round(Number(m[1]) / 1000);
      console.log(`      -> that call allowed itself ${budget}s; it has used ${ageS}s`);
      console.log(`      -> ${ageS !== null && ageS < budget ? 'STILL WITHIN ITS OWN BUDGET: this is patience, not a hang' : 'past its own budget: investigate'}`);
    }
  } else if (t.openTurn) {
    console.log('  >>> no tool in flight: it is waiting on the MODEL (streaming or thinking).');
    console.log('      A slow model looks exactly like this; only the quiet duration separates them.');
  } else {
    console.log(`  >>> nothing pending: the turn closed on ${t.lastType}. This session is idle, not stuck.`);
  }
  console.log('');
}

console.log(`${fragments.length} session(s) checked, ${pendingCount} waiting on a tool.`);
