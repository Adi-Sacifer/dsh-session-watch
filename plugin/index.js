/**
 * Host half of dsh-session-watch (mode 3: always-on).
 *
 * WHAT IT DOES
 *   Watches every conversation for the one condition a file timestamp cannot express: the
 *   transcript stopped being written while a turn or tool call is still open. On every change it
 *   emits `session-watch/changed`, and it keeps a small JSON snapshot on a web route that the
 *   Web UI polls. Unlike the on-demand probe and the turn-scoped loop, this runs for as long as
 *   the Host runs, whether or not any conversation is active.
 *
 * WHY THE LOGIC IS INLINED HERE
 *   The tools in this repo keep the verdict in `scripts/lib/scan.mjs`, but a plugin must not
 *   depend on a workspace path - the plugin is installed into the profile, and the workspace may
 *   be moved or missing. So this file carries its own copy. That is a real tradeoff: two copies of
 *   a judgement can drift, which is why both copies are covered by the same 20-assertion test
 *   (`test/selftest.mjs` for the tools, `test/plugin-selfcheck.mjs` for this half).
 *
 * ENVIRONMENT HONESTY
 *   Reading the transcript needs zstd. Node 24 has `zlib.zstdDecompressSync`; Electron's bundled
 *   Node may not. If it is missing this plugin does not throw and does not silently report "all
 *   clear" - it records the reason and reports `unavailable`, so a broken watchdog is visible
 *   instead of looking like a healthy system.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readRecords, hasZstd, unavailableReason } from './archive.js';
import { diagnose } from './diagnose.js';

export const name = 'session-watch';

/*
 * `timer` provides ctx.interval and ctx.timeout; `webServer` carries the routes; `agents` is how a
 * diagnosis reaches a live conversation as a real message rather than a log line.
 */
export const inject = ['timer', 'webServer', 'agents'];

/*
 * RELOAD SAFETY - this plugin must survive being applied more than once in one process.
 *
 * Learned against the running Host, not in theory. With fixed web route paths, reinstalling the
 * bundle tripped
 *   webserver: duplicate undefined route
 * which failed the new activation AND left the previous instance orphaned but still serving - the
 * plugin ended up broken and impossible to replace without a restart.
 *
 * Two defences, and `test/reload-safety.mjs` holds both:
 *
 *   1. Every generation derives a stamp from its own file mtime, so its route paths differ from any
 *      previous generation's. Two live copies cannot collide.
 *   2. Each stamp has one owner. A second apply() of the SAME generation finds the stamp already
 *      registered and does nothing at all - it does not register a second timer, a second set of
 *      routes, or a second injection row. Checking first is what makes this safe rather than merely
 *      lucky: swallowing a duplicate-route throw would leave a half-registered generation behind.
 */
const LOAD_STAMP = (() => {
  try { return String(Math.floor(fs.statSync(new URL('./index.js', import.meta.url)).mtimeMs)); }
  catch { return String(Date.now()); }
})();

/** Stamps already mounted by this module instance. */
const MOUNTED = new Set();

const ROUTE = `/session-watch/state-${LOAD_STAMP}.json`;
const NOTICE_ROUTE = `/session-watch/notice-${LOAD_STAMP}.js`;
const WATCHER_ROUTE = `/session-watch/watcher-${LOAD_STAMP}.json`;

const DSH = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESS_ROOT = path.join(DSH, 'sessions');
const PROJ_CACHE = path.join(DSH, 'storages', 'session_projcache', 'sessions');

/* transcript reading, zstd availability and the frame-magic rule all live in archive.js */

function titleOf(id) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(PROJ_CACHE, id + '.json'), 'utf8'));
    const t = j?.record?.rows?.title;
    if (t && typeof t.val === 'string' && t.val.trim()) return t.val.trim();
  } catch { }
  return null;
}

function sessionFiles() {
  const list = [];
  if (!fs.existsSync(SESS_ROOT)) return list;
  for (const ws of fs.readdirSync(SESS_ROOT)) {
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(SESS_ROOT, ws)); } catch { continue; }
    for (const dir of dirs) {
      const f = path.join(SESS_ROOT, ws, dir, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(f)) continue;
      const st = fs.statSync(f);
      list.push({ id: dir, file: f, size: st.size, mtime: st.mtimeMs });
    }
  }
  return list.sort((a, b) => b.mtime - a.mtime);
}

/*
 * Tail analysis. The pairing id is the trap: tool/call carries data.callId, while tool/result
 * carries data.message.toolCallId. Using the wrong field marks every call unresolved and turns a
 * healthy session into a false alarm.
 */
function tail(records) {
  let openTool = null;
  let openTurn = false;
  const results = new Set();
  for (const r of records) {
    if (!r || !r.type) continue;
    if (r.type === 'tool/call') openTool = { name: r.data?.name || '?', callId: r.data?.callId };
    else if (r.type === 'tool/result') {
      const id = r.data?.callId ?? r.data?.message?.toolCallId;
      results.add(id);
      if (openTool && openTool.callId === id) openTool = null;
    } else if (r.type === 'turn/start') openTurn = true;
    else if (r.type === 'turn/end') { openTurn = false; openTool = null; }
  }
  return { openTool, openTurn, lastType: records.length ? records[records.length - 1].type : null };
}

/** One session -> one verdict. Returns the exact shape the UI and events consume. */
function verdictOf(s, opts) {
  const quietS = Math.round((opts.now - s.mtime) / 1000);
  let t;
  try {
    t = tail(readRecords(s.file));
  } catch (error) {
    return { id: s.id, title: titleOf(s.id) || '(untitled)', state: 'unreadable', quietSeconds: quietS, tail: String(error?.message ?? error) };
  }
  const open = Boolean(t.openTool || t.openTurn);
  const kind = t.openTool ? `tool/call(${t.openTool.name})` : t.openTurn ? 'open turn (waiting on model)' : `closed(${t.lastType})`;
  const state = open && quietS > opts.staleS ? 'stuck' : open ? 'working' : 'idle';
  return { id: s.id, title: titleOf(s.id) || '(untitled)', state, quietSeconds: quietS, tail: kind };
}

export function apply(ctx, config) {
  /*
   * Already mounted by this module instance: do nothing. This is what keeps a re-apply from
   * throwing on the routes, stacking a second timer, or adding a second notice script to the page.
   */
  if (MOUNTED.has(LOAD_STAMP)) {
    ctx.logger?.info?.(`session-watch: generation ${LOAD_STAMP} already mounted, skipping re-apply`);
    return;
  }
  MOUNTED.add(LOAD_STAMP);

  const intervalMs = Math.max(5, Number(config?.intervalSeconds ?? 15)) * 1000;
  const staleS = Math.max(30, Number(config?.staleSeconds ?? 300));
  const windowMin = Math.max(10, Number(config?.windowMinutes ?? 1440));

  /*
   * Diagnosis configuration.
   *
   * The user authorized, in their own words, that a stuck session may be inspected automatically
   * so the cause can be reported: "就要第二个" - the option that explicitly includes reading the
   * stuck session's recent messages. That authorization is why contentBudget is non-zero by
   * default, and it is recorded in every result so the reading can be audited rather than assumed.
   * Setting contentBudget to 0 leaves diagnosis structure-only; nothing else needs to change.
   */
  const contentBudget = Math.max(0, Number(config?.diagnosisMessages ?? 3));
  const diagnosisEnabled = config?.diagnose !== false;
  const authorizedBy = String(config?.diagnosisAuthorizedBy ?? 'user authorized automatic read of the stuck session');
  const notifyEnabled = config?.notifyOnStuck !== false;
  const notifySessionId = config?.notifySessionId ? String(config.notifySessionId) : null;

  /* Which live conversation should hear about a diagnosis. The browser reports its own session id;
   * config can pin one as a fallback. Nothing is hardcoded, because a session id is not stable. */
  let watcherSessionId = null;
  const notified = new Map();   // session id -> last diagnosis cause we already reported

  let snapshot = {
    at: Date.now(),
    staleSeconds: staleS,
    available: hasZstd,
    reason: unavailableReason,
    diagnosis: { enabled: diagnosisEnabled, contentBudget, authorizedBy },
    counts: { stuck: 0, working: 0, idle: 0, unreadable: 0 },
    stuck: [],
    sessions: [],
    notifications: [],
  };

  /**
   * Tell a live conversation about a stuck session, as a real message.
   *
   * `agent.followup(text)` queues the message AND wakes the driver, so this actually reaches a
   * person instead of sitting in a log. Verified in the agent loop source:
   *   followup(input) { this.send(input, "next-turn", true); }   // true = wake
   *
   * Deliberately NOT steer() or inject(): those act inside a turn that is already running, and the
   * whole point is to leave a working conversation alone.
   *
   * WHO GETS IT, and why not "everyone": recipients are the ROOTS - top-level conversations - which
   * is where a person sits. Subagents and team members are workers; waking them to report on a peer
   * would be noise at best and a feedback loop at worst, since they could be the stuck one.
   *
   * The target is never hardcoded, because a session id is not stable. The page cannot supply its
   * own id either (no session id is exposed to the browser), so the roots ARE the mechanism, with
   * `notifySessionId` available as an override.
   */
  const notify = (diagnosis, title) => {
    if (!notifyEnabled || !diagnosisEnabled) return { delivered: false, reason: '通知已关闭' };

    const recipients = [];
    const wanted = watcherSessionId ?? notifySessionId;
    try {
      if (wanted) {
        const agent = ctx.agents?.get?.(wanted);
        if (agent) recipients.push(agent);
        else return { delivered: false, reason: `指定的通知目标 ${wanted} 当前不是活的` };
      } else {
        for (const agent of ctx.agents?.roots?.() ?? []) {
          if (agent && typeof agent.followup === 'function') recipients.push(agent);
        }
      }
    } catch (error) {
      return { delivered: false, reason: `无法枚举会话：${error?.message ?? error}` };
    }

    if (recipients.length === 0) return { delivered: false, reason: '当前没有可通知的顶层会话' };

    const lines = [
      `【会话监视】另一个对话卡住了，原因如下。我没有碰它，它仍然停在那里。`,
      ``,
      `· 会话：${title ?? diagnosis.id}（${diagnosis.id}）`,
      `· 原因：${diagnosis.summary}`,
      diagnosis.detail ? `· 细节：${diagnosis.detail}` : null,
      `· 置信度：${diagnosis.confidence}　静默：${diagnosis.quietSeconds}s`,
      diagnosis.read?.length
        ? `· 读了什么：${diagnosis.read.join('、')}（授权：${diagnosis.authorizedBy}）`
        : `· 读了什么：只看了结构信息（${diagnosis.structureRead ?? '尾部记录'}），没有读对话内容`,
      diagnosis.lastAssistant?.length ? `· 它最后一句话：${diagnosis.lastAssistant[diagnosis.lastAssistant.length - 1].text}` : null,
      diagnosis.lastUser?.length ? `· 你最后对它说的：${diagnosis.lastUser[diagnosis.lastUser.length - 1].text}` : null,
      diagnosis.lastErrorResult ? `· 最近的错误结果：${diagnosis.lastErrorResult.text}` : null,
      ``,
      `要我：① 去看一眼现状 ② 什么都不做让它继续 ③ 试试把它打断？`,
    ].filter((x) => x !== null);
    const body = lines.join('\n');

    /*
     * The inbox wants a MESSAGE OBJECT, not a string.
     *
     * `followup(input)` hands `input` straight to `send()`, which stores it without normalizing,
     * and the loop later appends it as a `user/message` event. So a bare string would be appended
     * as an invalid event. The minimal valid shape comes from the llm package's own helpers:
     *   createUserMessage(input) -> createMessage({ ...input, role: 'user' })
     *   createMessage(input)     -> structuredClone({ ...input, id: randomUUID() })
     * i.e. { id, role: 'user', content: [{ type: 'text', text }], source: { kind: … } }.
     *
     * `source.kind` is set explicitly and is NOT 'user': the goal tool's own documentation says an
     * omitted source resolves to `user`, and that non-human producers must supply their own rather
     * than inherit the authority of something a human typed. A watchdog is not the human.
     */
    const makeMessage = (text) => ({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'session-watch' },
    });

    const delivered = [];
    const failed = [];
    for (const agent of recipients) {
      if (agent.id === diagnosis.id) continue;   // never report a session to itself
      try {
        agent.followup(makeMessage(body));
        delivered.push(agent.id);
      } catch (error) {
        failed.push(`${agent.id}: ${error?.message ?? error}`);
      }
    }
    if (delivered.length > 0) {
      ctx.logger?.info?.(`session-watch: reported ${diagnosis.id} (${diagnosis.cause}) to ${delivered.join(', ')}`);
      return { delivered: true, to: delivered };
    }
    return { delivered: false, reason: failed.length ? failed.join('; ') : '没有可用的接收方（被诊断的会话可能就是唯一顶层会话）' };
  };

  const tick = () => {
    if (!hasZstd) return;   // keep reporting `unavailable` rather than pretending everything is fine
    try {
      const now = Date.now();
      const scope = sessionFiles().filter((s) => now - s.mtime < windowMin * 60_000);
      const rows = scope.map((s) => verdictOf(s, { now, staleS }));
      const pick = (state) => rows.filter((r) => r.state === state);

      /* diagnose only what the verdict flagged, and only once per cause per session */
      const stuck = pick('stuck').map((r) => {
        const source = scope.find((s) => s.id === r.id);
        let d = null;
        if (diagnosisEnabled && source) {
          d = diagnose({
            file: source.file,
            mtime: source.mtime,
            now,
            staleSeconds: staleS,
            contentBudget,
            authorizedBy,
          });
        }
        return { ...r, diagnosis: d };
      });

      const next = {
        at: now,
        staleSeconds: staleS,
        available: true,
        reason: null,
        diagnosis: { enabled: diagnosisEnabled, contentBudget, authorizedBy },
        counts: { stuck: stuck.length, working: pick('working').length, idle: pick('idle').length, unreadable: pick('unreadable').length },
        stuck: stuck.map((r) => ({
          id: r.id,
          title: r.title,
          quietSeconds: r.quietSeconds,
          tail: r.tail,
          cause: r.diagnosis?.cause ?? null,
          summary: r.diagnosis?.summary ?? null,
          detail: r.diagnosis?.detail ?? null,
          confidence: r.diagnosis?.confidence ?? null,
          read: r.diagnosis?.read ?? [],
        })),
        sessions: rows.map((r) => ({ id: r.id, state: r.state, quietSeconds: r.quietSeconds, tail: r.tail })),
        notifications: snapshot.notifications ?? [],
      };

      /* announce transitions so a consumer can react without polling */
      const before = new Map(snapshot.sessions.map((s) => [s.id, s.state]));
      for (const s of next.sessions) {
        const was = before.get(s.id);
        if (was !== s.state && (s.state === 'stuck' || was === 'stuck')) {
          ctx.emit('session-watch/changed', { id: s.id, title: s.title, from: was ?? null, to: s.state, quietSeconds: s.quietSeconds, tail: s.tail });
          ctx.logger?.info?.(`session-watch: ${was ?? 'new'} -> ${s.state}  ${s.id}  quiet ${s.quietSeconds}s`);

          /* a new arrival in the stuck state gets a diagnosis and, if possible, a message */
          const row = stuck.find((r) => r.id === s.id);
          if (s.state === 'stuck' && row?.diagnosis) {
            if (notified.get(s.id) !== row.diagnosis.cause) {
              const result = notify(row.diagnosis, row.title);
              notified.set(s.id, row.diagnosis.cause);
              next.notifications = [...(snapshot.notifications ?? []), {
                at: now, id: s.id, title: row.title, cause: row.diagnosis.cause,
                summary: row.diagnosis.summary, delivered: Boolean(result?.delivered), reason: result?.reason ?? null,
              }].slice(-20);
            }
            ctx.logger?.info?.(`session-watch diagnosis ${s.id}: ${row.diagnosis.cause} — ${row.diagnosis.summary}`);
          }
        }
        if (was === 'stuck' && s.state !== 'stuck') notified.delete(s.id);   // re-arm after recovery
      }
      snapshot = next;
    } catch (error) {
      snapshot = { ...snapshot, at: Date.now(), reason: String(error?.message ?? error) };
      ctx.logger?.warn?.(`session-watch scan failed: ${error?.message ?? error}`);
    }
  };

  tick();
  ctx.interval(tick, intervalMs);

  /*
   * EVENT SUBSCRIPTION, not just the timer.
   *
   * A timer alone means a session is noticed only on the next tick. These listeners close that gap:
   * a transcript that was write-busy and then closes its turn is precisely what "finished" looks
   * like, and resolving it the moment it happens keeps a stale "stuck" from sitting on screen.
   *
   * Deliberately narrow. Re-scanning on EVERY tool result would turn a watcher into a busy loop and
   * would still not be able to see a hang any sooner - a hung session by definition emits nothing.
   * So this reacts only to a transition out of "writing" for one session, coalesced over a short
   * window, while the timer stays the source of truth for flagging.
   *
   * The host half therefore uses both halves of the injected surface: `timer` for the periodic
   * verdict and `webServer` for delivery.
   */
  const lastKnownState = new Map(snapshot.sessions.map((s) => [s.id, s.state]));
  let coalesced = null;

  const scheduleRescan = () => {
    if (coalesced !== null) return;
    coalesced = ctx.timeout(() => {
      coalesced = null;
      lastKnownState.clear();
      for (const s of snapshot.sessions) lastKnownState.set(s.id, s.state);
      tick();
    }, 250);
  };

  for (const name of ['session/event', 'session/disposed', 'agent/status']) {
    ctx.on(name, (...args) => {
      try {
        /* positional for session/*: (session, event). Object payload for agent/status: { agent, status }. */
        const session = args[0] && args[0].id ? args[0] : args[0]?.agent?.session;
        const id = session?.id ?? args[0]?.id ?? null;
        if (id === null) return;

        const was = lastKnownState.get(id);
        if (was === undefined || was === 'working' || was === 'stuck') scheduleRescan();
      } catch { /* an event listener must never break the Host */ }
    });
  }

  ctx.webServer.register({
    method: 'GET',
    path: ROUTE,
    handler: (req, res) => {
      const body = JSON.stringify(snapshot);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    },
  });

  /*
   * The page tells us which conversation it is showing.
   *
   * A session id is not stable and must never be hardcoded, so the notice posts its own id and this
   * becomes the notification target. Self-selecting this way means the person looking at the GUI is
   * the person who gets told, without any configuration.
   */
  ctx.webServer.register({
    method: 'POST',
    path: WATCHER_ROUTE,
    handler: (req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; if (raw.length > 4096) req.destroy(); });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw || '{}');
          const id = typeof body.sessionId === 'string' && body.sessionId.trim() !== '' ? body.sessionId.trim() : null;
          if (id !== null && id !== watcherSessionId) {
            watcherSessionId = id;
            ctx.logger?.info?.(`session-watch: will report stuck sessions to ${id}`);
          } else if (id !== null) {
            watcherSessionId = id;   // keep it live: the page may move between conversations
          }
        } catch { /* a malformed body is ignored; this route only ever sets one field */ }
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
      });
    },
  });

  /*
   * The UI.
   *
   * A normal client half (`dsh.client` + `exports["./client"]`) is served only if the browser's
   * module graph already knows the package, and that graph is built at boot and then kept fresh by
   * an HMR watch registered per package. A bundle installed into a running Host is therefore never
   * picked up, and /plugins/<id>/client.js answers 404 until a restart. That was verified, not
   * assumed.
   *
   * The index-injection route avoids the whole problem: this plugin serves its own script and adds
   * one <script> row to the served index.html, so the notice comes alive on the next page load with
   * no restart and no module-graph involvement. The module-loader form is kept as client.js for
   * installs that do restart.
   */
  let noticeSource = null;
  try {
    noticeSource = fs.readFileSync(new URL('./notice.js', import.meta.url), 'utf8');
  } catch (error) {
    ctx.logger?.warn?.(`session-watch: notice script unreadable, UI will not appear: ${error?.message ?? error}`);
  }

  if (noticeSource !== null) {
    ctx.webServer.register({
      method: 'GET',
      path: NOTICE_ROUTE,
      handler: (req, res) => {
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(noticeSource),
        });
        res.end(noticeSource);
      },
    });

    ctx.on('webserver/index-inject', (table) => {
      /* the state URL and the watcher URL travel on the script tag, so the notice never guesses a
       * path that a reload would stale */
      const tag = `<script src="${NOTICE_ROUTE}" data-session-watch-state="${ROUTE}" data-session-watch-watcher="${WATCHER_ROUTE}" defer></script>`;
      table.push({ kind: 'script', placement: 'body', text: `document.write(${JSON.stringify(tag)})` });
    });
  }

  ctx.logger?.info?.(`session-watch ready: every ${intervalMs / 1000}s, stuck after ${staleS}s of silence, zstd=${hasZstd ? 'yes' : 'NO'}`);
}
