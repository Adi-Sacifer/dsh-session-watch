---
name: session-watch
description: Check whether another agent conversation is stuck or simply idle, and read what it is currently saying, without loading its transcript into context. Use when several conversations are open, when one has gone quiet and you need to know whether to wait or intervene, or when the user asks what another session is doing. Reads metadata freely; reading another conversation's actual replies requires the user to ask for it in that turn.
---
# Session watch (is that other conversation stuck?)

> **Public release note.** Paths, session ids and titles used as examples come from real runs and
> have been genericised or truncated. The measured findings are kept as recorded.

When several conversations run at once, one going quiet is ambiguous: **finished and hung look
identical on disk.** This skill resolves that, and can show what the other session is saying.

## The rule about scope — read this first

Two scripts, two different privacy levels. Do not blur them.

| | reads | needs the user to ask? |
|---|---|---|
| `probe-sessions.mjs` | metadata only: size, timestamps, tail record type | **no** — it reads no conversation content |
| `peek-text.mjs` | another conversation's **assistant replies** | **yes** |

- `probe-sessions` may be run whenever a stuck check is useful, including on your own initiative.
- `peek-text` reads someone else's conversation. Run it **only when the user asks in that turn**
  ("看看那个会话在干嘛"). Say which conversation you are about to read before reading it, and never
  do it to "get context" — that is exactly what this boundary exists to prevent.

## Running it

```powershell
node scripts/probe-sessions.mjs                       # who is stuck?
node scripts/probe-sessions.mjs --minutes 240 --stale 300
node scripts/peek-text.mjs <id|fragment|title> [count] [--chars 900]
node scripts/dump-types.mjs <session-file>            # recalibrate
```

Any **Node 22+** works; there are no packages to install. On Windows, `check-sessions.cmd` is a
double-clickable wrapper that also falls back to a bundled DSH runtime.

## How to read the verdict — do not skip this

| transcript tail | still growing? | verdict | what to do |
|---|---|---|---|
| ends on `turn/end` | — | idle | nothing; go read its output |
| unmatched `tool/call` | yes | working | nothing; wait |
| unmatched `tool/call` | silent past `--stale` | **stuck** | investigate that session |

**"Quiet" alone is never evidence of a hang.** Report the verdict from the tail state, not from the
quiet duration.

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
two pairing fields still exist. Update `tail()` in `probe-sessions.mjs`, the unresolved count in
`peek-text.mjs`, and `dump-types.mjs` together.

## Blind spots to state honestly

- A **pure model-streaming hang** (turn open, no tool call, bytes never arriving) is **not**
  detected and is reported as working.
- Only sessions still on disk are visible.
- It is a **snapshot, not a daemon**: nothing runs in the background, and a session cannot schedule
  its own wake-up. Always-on watching requires a host plugin, which is out of scope here.
