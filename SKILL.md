---
name: session-watch
description: Check whether another agent conversation is stuck or simply idle, and read what it is currently saying, without loading its transcript into context. Use when several conversations are open, when one has gone quiet and you need to know whether to wait or intervene, or when the user asks what another session is doing. When the user asks to enable or start this skill, ask which of the three monitoring modes they want before doing anything else - on-demand, in-turn polling, or the always-on plugin.
---
# Session watch (is that other conversation stuck?)

> **Public release note.** Session ids and titles used as examples come from real runs and have
> been truncated. The measured findings are kept as recorded.

When several conversations run at once, one going quiet is ambiguous: **finished and hung look
identical on disk.** This skill resolves that, and can show what the other session is saying.

## FIRST: if the user asks to enable / start / turn on this skill, ASK WHICH MODE

Do not pick for them and do not start monitoring on your own initiative. Call
`ask_user_question` with these three options and wait for the answer **before running anything**:

| option | what it actually does | when it ends |
|---|---|---|
| **1. On-demand (按需看)** | one snapshot now; nothing runs afterwards | immediately |
| **2. In-turn watch (本轮盯)** | a background loop that reports state changes for the rest of this turn | when this turn ends |
| **3. Always-on plugin (常驻盯)** | a host plugin that runs independently of any conversation and marks stuck sessions in the web UI | until the user disables it |

Say plainly what each one costs, because the honest differences are what the choice is about:

- Mode 2 **cannot outlive the turn**. A session cannot schedule its own wake-up, so when the turn
  ends the loop dies with it. It still writes a transition log to disk so the next turn can read
  what happened meanwhile.
- Mode 3 is the only one that survives, and it is the only one that needs installing something
  into the user's profile. Its current state is described under "Mode 3" below - read that before
  promising the user anything about the on-screen notice.

If the user does not choose, default to **mode 1** and say so — it reads metadata only and changes
nothing.

## Mode 3 (the plugin): how to install, run, and check it

The plugin lives in `plugin/` and is installed into the profile as the bundle
`@local/dsh-session-watch`.

Install or update it:

```
plugin_manager install_bundle   target: file:<repo>/plugin
```

The host half starts a timer (default every 15s) and subscribes to `session/event`,
`session/disposed` and `agent/status`. Both are needed and they do different jobs: **the timer is
when a hang gets flagged**, because only silence reveals one — a hung session emits nothing, so no
event can announce it — while **the events are how a session that starts moving again is noticed at
once** instead of leaving a stale notice on screen until the next tick. The listeners are
deliberately narrow (a transition out of write-busy, coalesced over 250ms); rescanning on every
tool result would make the watcher a busy loop while still not detecting a hang any sooner.

Check it is alive, without touching a conversation:

```powershell
# the route path carries the plugin's load stamp, so read it off the page or the log line
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-session-watch"
```

| part | state | evidence |
|---|---|---|
| host half: timer + events + the state route | **running** | the route returned HTTP 200 with live counts from the Host |
| host half: verdict rules | covered by test | `test/plugin-selfcheck.mjs` — 43 assertions, incl. a stuck session flagged in the first snapshot |
| host half: survives re-application | covered by test | `test/reload-safety.mjs` — 13 assertions; the duplicate-route crash is reproduced there and fixed |
| UI: the on-screen notice | **NOT yet seen on screen** | needs a Host restart; see below |

### Why the UI needs a restart, and what was tried

A `dsh.client` half is served only once the browser's module graph knows the package, and that graph
is built at boot: `/plugins/<id>/client.js` answers 404 for a bundle installed into a running Host.
So the plugin also serves its own `notice.js` and adds an index-injection row to load it, which needs
only a page load.

Even that does not take effect in the already-running process. Node caches ES modules by resolved
URL, and pnpm resolves a package by NAME to a fixed location, so the running Host keeps executing
the generation it loaded first — a stale generation was left serving while the new one failed to
activate. Verified three independent ways: the failing error named a route string absent from the
file on disk (0 occurrences), the new stamped route returned 404, and the old fixed route kept
answering 200. A **fresh process registers both stamped routes correctly**, so a Host restart makes
it live. Until someone confirms the notice on screen, **do not tell the user the notice works**.

### Two things worth not rediscovering

1. **The installed plugin is a HARDLINK to the repo.** Editing the repo *is* editing the installed
   bytes; there is no sync step, and overwriting reports "cannot overwrite with itself".
2. **A plugin whose route registration can throw is a plugin you cannot reload.** A failed
   activation left the previous instance orphaned but still serving, beyond the loader's reach.
   That is why routes carry a per-load stamp and why a repeated `apply()` checks before registering
   instead of catching the duplicate error — catching it would leave a half-registered generation.

Honest caveat that must travel with any future claim: `plugin/index.js` carries its own copy of the
verdict rule because a plugin must not depend on a workspace path, so the rule exists in two places.
Both copies are pinned by tests (`test/selftest.mjs` for the tools, `test/plugin-selfcheck.mjs` for
the plugin) - keep them in step, or one of them will drift and the watchdog will start crying wolf.

## The scope rule — read this before reading anyone's conversation

Two different privacy levels. Do not blur them.

| | reads | needs the user to ask? |
|---|---|---|
| `probe-sessions.mjs`, `watch-sessions.mjs` | metadata only: size, timestamps, tail record type | **no** — no conversation content is read |
| `peek-text.mjs` | another conversation's **assistant replies** | **yes**, in that turn |

`peek-text` reads someone else's conversation. Run it only when the user asks. Say which
conversation you are about to read, before reading it, and never do it to "get context".

## Running it

```powershell
node scripts/probe-sessions.mjs                        # who is stuck? (one shot)
node scripts/probe-sessions.mjs --minutes 240 --stale 300
node scripts/probe-sessions.mjs --json                 # same data, machine-readable
node scripts/watch-sessions.mjs --interval 60 --stale 300   # mode 2 loop
node scripts/peek-text.mjs <id|fragment|title> [count] [--chars 900]
node scripts/dump-types.mjs <session-file>             # recalibrate if the host format changed
node test/selftest.mjs                                 # verdict rules: 20 assertions
node test/plugin-selfcheck.mjs                         # plugin host half: 43 assertions
node test/reload-safety.mjs                            # survives re-application: 13 assertions
```

Installing or updating mode 3 (host half goes live immediately; the client half needs a restart):

```
plugin_manager install_bundle  target: file:<repo>/plugin
node <repo>/tools/asar-read2.mjs solve "<DSH>/resources/app.asar"   # only if you must read the archive
```

Any **Node 22+** works; there are no packages to install. On Windows, `check-sessions.cmd` in the
repo is a double-clickable wrapper that also falls back to a bundled DSH runtime.

### If this skill will not load at all

An unloadable skill is usually an inactive provider, not a bad file. The filesystem skill provider
is `@deepseek-ai/dsh-skill-filesystem`, and it can sit in the composed tree as `inactive`:

```
plugin_manager  set_plugin  target: include:skill-filesystem  enabled: true
```

**Do not install it from the registry.** The registry copy can demand a different API generation
than the running Host (seen here: `0.0.1-rc.3` requiring peers at `^0.0.1-rc.3` while the runtime
was `0.1.7-rc.2` - a major-version gap the installer refuses, correctly, with a data-loss warning).
The bundled copy that ships inside the installation already matches the runtime exactly, and
activating that row applies with no warnings. Check what is bundled before reaching for a download.

## How to read the verdict — do not skip this

| transcript tail | still growing? | verdict | what to do |
|---|---|---|---|
| ends on `turn/end` | — | idle | nothing; go read its output |
| open `tool/call` or open turn | yes | working | nothing; wait |
| open `tool/call` or open turn | silent past `--stale` | **stuck** | investigate that session |

**"Quiet" alone is never evidence of a hang.** Report the verdict from the tail state, not from the
quiet duration. A session that closed its turn cleanly is *supposed* to be silent.

**Pick `--stale` like an adult.** Too small and every slow model response becomes an alarm — in
testing, a 25-second threshold flagged a working session within 10 minutes. The default 300s is
deliberate.

## Two false signals — the most valuable part of this skill

Both were hit for real, and both produced a **confident wrong answer**. If you extend these
scripts, do not reintroduce them.

1. **Do not judge liveness by looking for a matching OS process.** The host process command line
   does not name the session, so "no process found" is noise. It once flagged a healthy session as
   stuck. Use whether the **transcript stopped**, not whether a process exists.
2. **Do not pair calls and results by `data.callId` alone.** The result's id is nested:
   `tool/call → data.callId`, `tool/result → data.message.toolCallId`. Using the wrong field made
   **all 145** tool calls on a working session look unresolved — a report that says the exact
   opposite of the truth.

If a check ever reports that *everything* is unresolved, suspect the pairing rule before believing
the alarm.

## Reading the files directly

The `.zstd` transcript is **an append-only log of independent zstd frames**, not one stream.
`zstdDecompressSync()` and the streaming API both return only the first frame, which looks like an
empty conversation. Walk the magic `28 B5 2F FD`, inflate frame by frame, merge forward when a
frame fails, and skip a trailing half frame on a live session.

Keep the JSONL rules in mind: filter `content[]` items by `type === "text"`, because reasoning
blocks live in the same array; and use `data.source.kind` on user messages to tell what the human
typed from host-injected boilerplate.

When the host changes format, `dump-types.mjs` reports the record-type histogram and whether the
two pairing fields still exist. Update `tail()` in `scripts/lib/scan.mjs` and re-run
`test/selftest.mjs` — the test is what tells you the change actually took effect.

## Blind spots to state honestly

- A **pure model-streaming hang** is now detected (an open turn with a silent transcript is
  reported), but note that a genuinely slow model response looks the same until `--stale` passes.
  That is the tradeoff `--stale` buys.
- Only sessions still on disk are visible.
- Modes 1 and 2 are **snapshots and turn-scoped loops, not daemons**: nothing runs in the
  background after the turn, because a session cannot schedule its own wake-up. Only mode 3 (the
  host plugin) keeps watching.
