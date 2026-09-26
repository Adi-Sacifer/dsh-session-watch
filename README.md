# dsh-session-watch — is that other session stuck, or just done?

A small read-only toolkit that answers a question a file timestamp cannot:

> Another conversation has been quiet for ten minutes — **did it finish, or is it hung?**

```
scripts/probe-sessions.mjs   is any session stuck?          ~7 KB
scripts/peek-text.mjs        what is that session saying?   ~5 KB
scripts/dump-types.mjs       recalibrate if the host changes ~3 KB
```

Pure Node, **zero dependencies**.

**[中文说明](README.zh-CN.md)**

---

## The problem

You have several agent conversations open. One stops moving. All you can see is "it stopped" —
because **a session that finished its work and a session that hung look exactly the same in a
file timestamp**.

The difference matters a lot:

| | Finished | Hung |
|---|---|---|
| What you should do | go read its output | go rescue it |
| If you wait | you waste time | you waste time forever |

This toolkit separates the two using **the shape of the transcript itself**.

## The rule: a healthy turn has a shape

This is not a guess — it was counted out of real transcripts. A healthy turn looks like:

```
turn/start → step/start → assistant/message → tool/call → tool/result → turn/end
                                                              ↑ only turn/end means "closed"
```

So one rule is enough:

| transcript tail | still growing? | verdict |
|---|---|---|
| ends on `turn/end` | — | **idle** — it finished |
| unmatched `tool/call` | yes | **working** |
| unmatched `tool/call` | **silent past the threshold** | **stuck** ⚠️ |

## Usage

```powershell
node scripts/probe-sessions.mjs                 # default: sessions touched in the last 90 min
node scripts/probe-sessions.mjs --minutes 240 --stale 300
```

On Windows you can just double-click `check-sessions.cmd`.

Real output (measured):

```
=== cross-session stuck check   22:08:38
    window: touched within 120 min   |   sessions on disk: 25
    rule: silent > 180s with an unmatched tool/call  =>  stuck

-- working -------------------------------------
* session-dbeaf1b0-...   checking the stuck-session feature
    340.2 KB · last write 22:08:38 · quiet 0s · record tool/call
    tail: open tool/call (pwsh)

-- idle (turn closed cleanly) ------------------
    session-281088bf-...   quiet   520s  AI-lover feasibility

>>> all clear: no session is parked on an unmatched tool call.
    Checked 5 session(s) touched in the last 120 min.
```

To read what another session is **saying** (its own account of where it got to):

```powershell
node scripts/peek-text.mjs session-551a5c44 3 --chars 800
# the target may be a full id, an id fragment, or a title fragment
```

```
--- assistant 22:06:18 ---
`setContextLimit` exists — the page had a stale bundle at that moment.
Let me now fix the script's remaining real bugs: the 8-vs-9 message mismatch and the leaking selectors.

tool calls=147  unresolved=0
```

## Two false signals that ruin the answer (both were hit for real)

This section is worth more than the scripts. **A false alarm is worse than no report at all** —
it sends you to rescue a session that was never in trouble.

### False signal 1: judging liveness by looking for a matching process

The first version did this, and it **flagged a perfectly healthy session as stuck**. Reason: the
host process command line **does not name the session**, so "no process found" is pure noise.

Looking at whether **the transcript itself stopped** is the correct signal.

### False signal 2: pairing calls and results by `data.callId`

**The result's id is not on `data.callId`.** It is nested:

```js
tool/call    →  data.callId
tool/result  →  data.message.toolCallId     // ← note the nesting
```

Consequence of using the wrong field: a session that was working fine reported **all 145** of its
tool calls as unresolved.

```
wrong field:  tool calls=145  unresolved=145   ← everything hung? impossible - false alarm
right field:  tool calls=145  unresolved=0     ← the truth
```

**Had that bug not been caught, the report would have flipped from "it is healthy" to "all 145
calls are hung" — exactly backwards.**

## What the transcript file actually is

If you want to read these files yourself, this saves you an afternoon.

```
~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd   the transcript
~/.dsh/storages/session_projcache/sessions/<session-id>.json      titles and usage totals
```

**That `.zstd` is not one compressed stream.** It is an append-only log of roughly **1500
independent zstd frames**, one per flush. Therefore:

```js
zstdDecompressSync(buf)          // ❌ reads the first frame only
createZstdDecompress()           // ❌ same - first frame only
```

Both hand you **only the first frame**, which looks like "this conversation is empty" — and off
you go debugging in entirely the wrong direction.

The way in is to walk the frame magic `28 B5 2F FD`, inflate each frame between boundaries, and
concatenate. Measured on a real session: **5184 frames, 8104 records, 0 failures**. A frame body
can contain those bytes by chance, so a frame that fails to inflate must be **merged forward**
until it decodes. While a session is live, **a trailing half frame is normal** — skip it.

Records are JSONL. The ones worth knowing:

| record | where the text is |
|---|---|
| `user/message` | items in `data.content[]` with `type === "text"`; `data.source.kind` separates what the human typed (`user`) from host-injected boilerplate (`runtime-context`, …) |
| `assistant/message` | items in `data.message.content[]` with `type === "text"` — **reasoning blocks sit in the same array**, so you must filter by `type` |
| `tool/call` | `data.name` + `data.arguments` (a JSON string) |
| `tool/result` | `data.message.toolCallId` (pairs with `tool/call`'s `data.callId`) |

If the host changes the format, `scripts/dump-types.mjs` tells you in five seconds:

```powershell
node scripts/dump-types.mjs <session-file>
```

It prints the record-type histogram, the type order of the last 12 records, and **whether the two
fields the pairing rule depends on are still there**.

## Scope and privacy — this part matters most

This repo is a companion to
[`dsh-session-recall`](https://github.com/Adi-Sacifer/dsh-session-recall), but they **read
different things**:

| | what it reads | does the user have to ask? |
|---|---|---|
| `probe-sessions` | session **metadata**: size, timestamps, tail record type | no — it reads no content |
| `peek-text` | another session's **assistant replies** | **yes.** The user must ask |

`peek-text` reads someone else's conversation, so it follows **the same rule** as session-recall:
**default scope is the current conversation, and cross-conversation reading happens only when the
user asks for it in that turn.** Do not browse the user's other chats to "get context" — that is
exactly what these tools are designed not to turn into.

A lesson already learned: having the host Agent read other sessions on its own initiative,
justified as "automatic health checks", is **precisely what that rule exists to prevent**. That is
why `probe-sessions` deliberately touches metadata only.

## Known blind spots

1. **A pure model-streaming hang is not caught.** If a session is stuck waiting on a model request
   (TCP connected, no bytes), its transcript looks like "turn open, no tool call" and is currently
   classified as working. Catching it requires inspecting that session's SSE idle timeout.
2. **Only sessions still on disk.** A deleted session is gone.
3. **A live session's last half frame may not be flushed yet**, so a record or two may be missing.
   This does not affect the verdict, which reads tail state rather than message counts.
4. **It is a read-only snapshot, not a daemon.** It will not "wake up later and take a look" —
   there is no persistent loop. You run it when you want to look.

## Why this is not an always-on watchdog

It was asked for and explicitly declined. The honest reason:

An Agent running inside a session **cannot set an alarm for itself**. It stops when a turn ends;
there is no "wake up later" mechanism. Real periodic scheduling belongs to a **host plugin**
(timers plus session events), which is a much larger thing with its own risk — **automatically
reading other sessions' content** runs straight into the privacy rule above.

So: **the tools look when you ask, and nothing reads in the background.**

## Requirements

**Node 22+.** That is all — `zlib` ships zstd, so there is nothing to install and nothing to build.

`check-sessions.cmd` looks for `node` on `PATH` first, then falls back to the bundled DSH runtime
on Windows.

## License

MIT, see [LICENSE](LICENSE).
