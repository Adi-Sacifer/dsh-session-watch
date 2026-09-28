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
 *   be moved or missing. So this file carries its own copy. That is a real tradeoff, and it has
 *   now actually bitten: the fix for the mutual-watch loop below (an open turn and an open tool
 *   call are different evidence) exists ONLY here, so the CLI copy still reports a model that is
 *   merely thinking as `stuck`. That copy has no notification path, so it cannot start the loop -
 *   but the two files no longer agree, and that is a debt, not a design.
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
import { keepPluginEventsAlive } from './event-keepalive.js';

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

/** One owner per host; disposal or failed activation releases ownership. */
const MOUNTED = new WeakMap();

const ROUTE = `/session-watch/state-${LOAD_STAMP}.json`;
const NOTICE_ROUTE = `/session-watch/notice-${LOAD_STAMP}.js`;
const WATCHER_ROUTE = `/session-watch/watcher-${LOAD_STAMP}.json`;

export function makeNoticeInjection(noticeRoute, stateRoute, watcherRoute) {
  /* The notice runs after parsing, so it cannot disturb the shell's startup document. */
  const script = `(() => {
    const load = () => {
      if (document.getElementById('session-watch-notice-loader')) return;
      const el = document.createElement('script');
      el.id = 'session-watch-notice-loader';
      el.src = ${JSON.stringify(noticeRoute)};
      el.setAttribute('data-session-watch-state', ${JSON.stringify(stateRoute)});
      el.setAttribute('data-session-watch-watcher', ${JSON.stringify(watcherRoute)});
      document.body.appendChild(el);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', load, { once: true });
    } else {
      load();
    }
  })()`;
  return { kind: 'script', placement: 'body', text: script };
}

/*
 * AN OPEN TURN IS NOT AN OPEN TOOL CALL, and treating them the same is the false alarm that started
 * this. An unmatched `tool/call` means a tool was invoked and never came back: at `staleSeconds` that
 * is strong evidence. An open turn with NO tool call is just "the model has been asked something" -
 * and a model that is still streaming its answer writes nothing to the transcript either, so silence
 * there is exactly what a hard-working session looks like. Applying one threshold to both is what
 * made two busy conversations report each other as stuck.
 *
 * So the weak signal gets a much longer window AND it must not wake anyone. A genuinely hung model
 * stream still shows up in the UI snapshot, where a person can act on it.
 */
const OPEN_TURN_STALE_FACTOR = 4;

/*
 * A TOOL THAT DECLARED ITS OWN TIMEOUT GETS TO USE IT - up to a point.
 *
 * Measured, twice, against a real session: a `pwsh` call that declared `timeoutMs: 900000` (15 min)
 * and then `timeoutMs: 1500000` (25 min) was reported as stuck at 302s of silence while it was
 * working perfectly. The watchdog was reading "how long has this been quiet" and ignoring the one
 * piece of evidence sitting right there in the transcript: the call had told everyone how long it
 * intended to take.
 *
 * So the threshold now defers to the declaration. But not blindly - the user's objection is exactly
 * right: "要是他给自己定2h我就白白看着吗" - if a call declares two hours, honouring it means the
 * watchdog says nothing for two hours, which is how a watchdog becomes furniture.
 *
 * Three tiers, in this order:
 *   1. no declaration      -> staleSeconds (the default). Unchanged behaviour, most calls land here.
 *   2. declared, sane      -> the declaration (plus a margin), because a long test suite is work.
 *   3. declared, absurd    -> capped at MAX_BUDGET_SECONDS. The watchdog stops being patient here
 *                             and flags anyway, so "I gave myself two hours" cannot silence it.
 */
const BUDGET_GRACE = 1.5;
const MAX_BUDGET_SECONDS = 1200;

/** The `timeoutMs` a pending call declared for itself, in seconds, or null when it declared none. */
function declaredBudgetS(records) {
  let open = null;
  const done = new Set();
  for (const r of records) {
    if (!r || !r.type) continue;
    if (r.type === 'tool/call') open = r;
    else if (r.type === 'tool/result') {
      const id = r.data?.callId ?? r.data?.message?.toolCallId;
      done.add(id);
      if (open && open.data?.callId === id) open = null;
    } else if (r.type === 'turn/end') open = null;
  }
  if (!open) return null;
  const m = /"timeoutMs"\s*:\s*(\d+)/.exec(String(open.data?.arguments ?? ''));
  if (!m) return null;
  const seconds = Math.round(Number(m[1]) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

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

/**
 * Tools that BLOCK ON A HUMAN, not on the machine.
 *
 * `ask_user_question` parks the turn until a person picks an option, and a person is allowed to think
 * for ten minutes. Measured: a session was reported stuck at 313s while what it was actually doing was
 * sitting on a question to its user - and the watch notice's own suggested remedy is "① 去看一眼",
 * which is exactly the thing that would have answered it. A watchdog that alarms about the user's own
 * pending decision, and whose advice is "go look", is asking to be clicked and then clicked again.
 *
 * This is a different case from a long-running tool. There the budget is knowable and the tool
 * declares it (see declaredBudgetS / thresholdFor). Here there is no budget and no honest upper bound:
 * silence is not evidence of trouble, it is evidence that nobody has answered yet.
 */
const HUMAN_WAIT_TOOLS = new Set(['ask_user_question', 'askuserquestion', 'ask_user']);

/** One session -> one verdict. Returns the exact shape the UI and events consume. */
function verdictOf(s, opts) {
  const quietS = Math.round((opts.now - s.mtime) / 1000);
  let t;
  let budgetS = null;
  try {
    const records = readRecords(s.file);
    t = tail(records);
    budgetS = declaredBudgetS(records);
  } catch (error) {
    return { id: s.id, title: titleOf(s.id) || '(untitled)', state: 'unreadable', quietSeconds: quietS, tail: String(error?.message ?? error) };
  }
  const open = Boolean(t.openTool || t.openTurn);
  const kind = t.openTool ? `tool/call(${t.openTool.name})` : t.openTurn ? 'open turn (waiting on model)' : `closed(${t.lastType})`;
  const strong = Boolean(t.openTool);            // a tool call that never returned
  /* waiting for a person is not a hang and must never be reported as one */
  const awaitingHuman = Boolean(t.openTool && HUMAN_WAIT_TOOLS.has(String(t.openTool.name).toLowerCase()));
  const strongS = opts.staleS;
  const weakS = opts.staleS * OPEN_TURN_STALE_FACTOR;
  const state = !open ? 'idle'
    : awaitingHuman ? 'waiting-for-human'
      : quietS > (strong ? strongS : weakS) ? 'stuck' : 'working';

  return {
    id: s.id,
    title: titleOf(s.id) || '(untitled)',
    state,
    quietSeconds: quietS,
    tail: kind,
    /* the transcript's own mtime travels with the verdict: the busy/liveness bookkeeping reads it,
     * and a caller that had to re-stat the file to get it would be a second source of truth */
    mtime: s.mtime,
    /* how this verdict earned the word "stuck", so a consumer never has to re-derive it:
     * 'tool-call' is evidence; 'open-turn' is weak and deliberately never wakes anyone;
     * 'awaiting-human' means a person owes this session an answer. */
    signal: !open ? null : awaitingHuman ? 'awaiting-human' : strong ? 'tool-call' : 'open-turn',
    thresholdSeconds: open && !awaitingHuman ? (strong ? strongS : weakS) : null,
    /* what the pending call asked for itself, so the tick can decide whether silence is still
     * patience. Only meaningful for the strong signal. */
    declaredBudgetSeconds: strong && !awaitingHuman ? budgetS : null,
  };
}

export function apply(ctx, config) {
  /*
   * Already mounted by this module instance: do nothing. This is what keeps a re-apply from
   * throwing on the routes, stacking a second timer, or adding a second notice script to the page.
   */
  const server = ctx.webServer;
  if (MOUNTED.has(server)) {
    ctx.logger?.info?.(`session-watch: generation ${LOAD_STAMP} already mounted, skipping re-apply`);
    return;
  }
  const routes = [];
  const owner = {};
  MOUNTED.set(server, owner);
  const cleanup = () => {
    for (const dispose of routes.splice(0).reverse()) dispose();
    if (MOUNTED.get(server) === owner) MOUNTED.delete(server);
  };
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup);
  else ctx.on('dispose', cleanup);
  const register = (route) => routes.push(server.register({ kind: 'exact', ...route }));
  try {
  routes.push(keepPluginEventsAlive(ctx));

  const intervalMs = Math.max(5, Number(config?.intervalSeconds ?? 15)) * 1000;
  const staleS = Math.max(30, Number(config?.staleSeconds ?? 300));
  /* The ceiling on honouring a tool's self-declared timeout. See the three tiers above
   * MAX_BUDGET_SECONDS: past this the watchdog stops being patient, because "I gave myself two hours"
   * must not be able to buy two hours of silence. */
  const maxBudgetS = Math.max(staleS, Number(config?.maxBudgetSeconds ?? MAX_BUDGET_SECONDS));
  const windowMin = Math.max(10, Number(config?.windowMinutes ?? 1440));

  /**
   * How long may THIS session be silent before silence means trouble?
   *
   * tier 1 - nothing declared: staleSeconds. Most calls land here.
   * tier 2 - declared and sane: the declaration, plus a margin (a tool that said 900s and has been
   *          quiet 950s is finishing, not hanging).
   * tier 3 - declared beyond the ceiling: the ceiling, plus the same margin. The declaration is
   *          capped rather than obeyed, so an absurd budget cannot silence the watchdog.
   */
  const thresholdFor = (row) => {
    const declared = row.declaredBudgetSeconds;
    if (!Number.isFinite(declared) || declared === null) return staleS;
    const honoured = Math.min(declared, maxBudgetS);
    return Math.max(staleS, Math.round(honoured * BUDGET_GRACE));
  };

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

  /*
   * Who already knows. Keyed `${diagnosed id} -> ${recipient id}`, and checked BEFORE the message is
   * sent, not after: the first version consulted it after followup() had already gone out, which
   * meant it could trim a log line but never actually prevent a second message.
   *
   * Released when the diagnosed session stops being stuck, so a session that recovers and genuinely
   * hangs again later is reported again.
   */
  /*
   * Sessions already announced, so ONE incident produces ONE message no matter how many ticks pass.
   *
   * This replaced a per-PAIR key (`session -> recipient`), and the difference is the whole point. With
   * a pair key, excluding the already-woken recipient did not stop the alert - it MOVED it: the
   * candidate list lost alice (now a monitor), so the next tick's "best" choice became bob, then
   * carol, and one hang woke three conversations one per tick. That is precisely the user's report,
   * "一次性还是会唤起一堆监工", surviving the loop fix.
   *
   * The incident is the unit of work: once somebody has been told, nobody else needs to be. It is
   * released when the session stops being stuck, so a genuine second hang is reported again.
   */
  const announced = new Set();

  /*
   * Stuck sessions that have not been heard yet, and why. A notification that could not be delivered
   * (nobody eligible, or every candidate was mid-turn) is NOT dropped - it waits here and is retried
   * on later ticks. The first version only ever tried once, at the moment of transition, so a single
   * busy recipient meant the alert vanished for good.
   */
  const pending = new Map();

  /*
   * Conversations this watchdog has woken. They are monitors, not suspects.
   *
   * This is the heart of the fix for the mutual-watch loop: A is flagged, so the plugin wakes B to
   * look at A; B is busy, so it writes nothing, so it too gets flagged, so A is woken to look at B,
   * and the two of them sit there watching each other forever - and each wake-up makes the other one
   * look silent again.
   *
   * So: once this plugin has made a conversation part of the watching, it is not a suspect any more.
   * It is excluded from the recipient list AND filtered out of the stuck list (both, because a
   * same-tick race otherwise still lets one wake-up through - see the transition loop), and
   * `session/event` arrival is what decides the window, not a bare timer, because a stuck-but-silent
   * run reaches a tick with no transition at all.
   *
   * TIME-BOUNDED on purpose. A permanent ban is a silencing bug of its own: a conversation that was
   * woken once could hang a week later and never be reported by anything. HOOK_WINDOW_MS is long
   * enough to outlast the flapping (a slow model plus a rescan cycle) and short enough that a later,
   * unrelated hang is still seen.
   */
  /*
   * TIME-BOUNDED on purpose. A permanent ban is a silencing bug of its own: a conversation that was
   * woken once could hang a week later and never be reported by anything. The window is long enough
   * to outlast the flapping (a slow model plus a rescan cycle) and short enough that a later,
   * unrelated hang is still seen.
   *
   * It is wall-clock, which is why it is also configurable: a test cannot age 30 real minutes, and an
   * operator may have a reason to move it. The floor is derived from the interval rather than fixed,
   * because a window shorter than a few ticks would let the loop back in; the default is 30 minutes.
   */
  const HOOK_WINDOW_MS = Math.max(1000, Number(config?.hookWindowSeconds ?? 1800) * 1000);
  const GRACE_MS = 60_000;   // how long an evidence-of-life stamp survives without being refreshed
  /*
   * How long a "working" verdict stays authoritative. It has to outlive one tick - the guard is
   * built from the previous pass and read during the next - so it is derived from the interval rather
   * than fixed, with a floor so a very fast interval cannot make the guard evaporate instantly.
   */
  const verdictGraceMs = Math.max(30_000, intervalMs * 3);
  const workingAt = new Map();   // session id -> when the verdict last called it 'working'
  const monitors = new Map();   // session id -> when it was made a monitor

  const isMonitor = (id, now) => {
    const since = monitors.get(id);
    if (since === undefined) return false;
    if (now - since > HOOK_WINDOW_MS) { monitors.delete(id); return false; }
    return true;
  };

  /*
   * A Host with no agent registry cannot deliver a diagnosis to anybody. That is not the same as
   * "everyone is busy", and a watchdog that cannot report must say so rather than look healthy -
   * exactly the failure mode `available: false` already covers for transcripts, applied to delivery.
   *
   * Said ONCE, at load, instead of on every tick: a permanent condition repeated every 15 seconds is
   * log spam, and spam is how a real warning stops being read. The snapshot carries the same fact for
   * the page.
   */
  let notifyUnavailable = null;
  const warnNoAgents = () => {
    if (notifyUnavailable !== null) return;
    notifyUnavailable = 'ctx.agents is unavailable, so a stuck session can be shown but never reported';
    ctx.logger?.warn?.(`session-watch: ${notifyUnavailable}`);
  };
  if (!ctx.agents || typeof ctx.agents.roots !== 'function') warnNoAgents();

  /*
   * "Busy" must live at apply() scope, not inside tick().
   *
   * The first version of this fix declared it inside tick() and read it from notify() - an
   * out-of-scope read that throws ReferenceError, which notify()'s own try/catch then swallowed into
   * `{delivered: false}`. Every genuine alert was silently eaten while the snapshot still looked
   * healthy. That is the worst failure this whole repo exists to prevent, and it is why the guard is
   * a module-level Set updated by whichever caller knows something.
   *
   * The guard answers exactly one question - "did the last VERDICT call this conversation working?" -
   * and it is deliberately time-bounded twice:
   *
   *   verdictGraceMs  the freshness of that verdict. A working verdict expires on its own, so a
   *                   conversation that was working when we looked and went stuck since does not
   *                   stay un-wakeable for long. (Measured the hard way: a monotonic "evidence of
   *                   life" stamp instead made a session that had merely been BUSY EARLIER look
   *                   permanently busy, so every report to it was deferred forever.)
   *   lastSeen        evidence of life from events, which is what tells a genuinely streaming
   *                   conversation (still mid-turn, still emitting) apart from one that has parked.
   *
   * Two sources feed it, because neither is sufficient alone: the verdict pass knows "open work that
   * is still being written", and session/event knows "it did something just now", including writes
   * the mtime has not caught up with yet.
   */
  const busyRoots = new Set();
  const markBusy = (id) => { if (id) busyRoots.add(id); };

  /*
   * Conversations that are waiting for their own user to answer something.
   *
   * This is a separate rule from "busy", and the separation is the point. `isBusyRoot` is deliberately
   * short-lived - it only holds while the TRANSCRIPT IS MOVING - because a session that stopped moving
   * must stay wakeable. But a session parked on `ask_user_question` has stopped moving BY DEFINITION,
   * so the busy guard can never protect it, and it would be woken with a report about somebody else
   * while its own question sits unanswered. Piling a second question on top of the first is the
   * precise noise a watchdog should not make.
   *
   * So: waiting on a human means "do not nudge me about anything else", independent of liveness.
   */
  const awaitingHumanRoots = new Set();
  const isBusyRoot = (id, now) => {
    if (!busyRoots.has(id)) return false;
    const verdict = workingAt.get(id);
    /*
     * The verdict is authoritative, and BOTH stamps must be fresh.
     *
     * An earlier version refreshed only the verdict pass and let the flag persist, so a conversation
     * that was mid-turn when we looked and had gone stuck by the next pass kept being skipped as
     * "busy" - and because a retry is only attempted while the session is still stuck, the alert was
     * deferred for exactly as long as the situation lasted. A guard that makes the watchdog mute
     * precisely when it is needed is worse than no guard.
     */
    if (verdict === undefined || now - verdict > verdictGraceMs) { busyRoots.delete(id); return false; }
    const alive = lastSeen.get(id);
    /* `at` - what the evidence said - so a genuinely parked transcript stops counting as alive */
    if (alive === undefined || now - alive.at > verdictGraceMs) { busyRoots.delete(id); return false; }
    return true;
  };

  /*
   * Evidence of life, kept monotonic on purpose. An event stamps "alive now", and the next verdict
   * pass would otherwise overwrite that with the transcript's older mtime and expire the stamp one
   * line later - exactly how the guard would go missing in the tick right after the risky one.
   */
  /*
   * Evidence of life, and the distinction that matters: WHEN WE OBSERVED IT is not the same as WHAT IT
   * SAID. An event is "alive right now"; a verdict is "this file was last written at mtime", which for
   * a quiet session is old by definition.
   *
   * Mixing the two cost a real bug: `markSeen(id, r.mtime)` stored the transcript's mtime, so a session
   * that had been silent for 30 minutes recorded an `alive` stamp 30 minutes in the past - and the
   * freshness check below then measured the QUIET DURATION against a 45s grace window and concluded
   * the session was not busy. Everything downstream depended on that flag.
   *
   *   at        what the evidence says (the mtime, or now for an event)
   *   observed  when we saw it (monotonic: never goes backwards, so a verdict cannot un-see an event)
   *
   * `at` is what the grace window compares against; `observed` is what proves an event has not been
   * overwritten by a later, staler read.
   */
  const lastSeen = new Map();   // session id -> { at, observed, source }
  const markSeen = (id, at, source = 'verdict') => {
    if (!id || typeof at !== 'number') return;
    const prev = lastSeen.get(id);
    /* an event always wins over a verdict; otherwise the newest evidence wins */
    if (prev === undefined || source === 'event' || at > prev.at) {
      lastSeen.set(id, { at, observed: Date.now(), source });
    } else {
      prev.observed = Date.now();
    }
    if (lastSeen.size > 512) {
      const cutoff = Date.now() - GRACE_MS * 5;
      for (const [k, v] of lastSeen) if (v.observed < cutoff) { lastSeen.delete(k); busyRoots.delete(k); workingAt.delete(k); }
    }
  };

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
  const notify = (diagnosis, title, recipients) => {
    if (!notifyEnabled || !diagnosisEnabled) return { delivered: false, reason: '通知已关闭' };
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return { delivered: false, reason: '当前没有可以叫醒的对话（其他会话可能正在干活）' };
    }

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

    const sent = [];
    const failed = [];
    for (const agent of recipients) {
      if (agent.id === diagnosis.id) continue;   // never report a session to itself
      try {
        agent.followup(makeMessage(body));
        sent.push(agent.id);
      } catch (error) {
        failed.push(`${agent.id}: ${error?.message ?? error}`);
      }
    }
    if (sent.length > 0) {
      ctx.logger?.info?.(`session-watch: reported ${diagnosis.id} (${diagnosis.cause}) to ${sent.join(', ')}`);
      return { delivered: true, to: sent };
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

      /*
       * A tool that declared a long timeout is STILL WORKING until its own budget runs out.
       *
       * verdictOf() only knows the flat rule, so a call that said `timeoutMs: 1500000` (25 min) is
       * flagged at staleSeconds like any other. This is where the declaration is honoured: a strong
       * signal inside its (capped) budget is demoted back to working, with the reason recorded so the
       * snapshot explains itself instead of silently dropping a candidate.
       *
       * Only demotion happens here. Everything past its budget keeps the verdict it already had, so
       * the ceiling in thresholdFor() is what stops an absurd declaration from silencing the watchdog.
       */
      for (const r of rows) {
        if (r.state !== 'stuck' || r.signal !== 'tool-call') continue;
        const limit = thresholdFor(r);
        if (limit <= r.thresholdSeconds) continue;      // no declaration worth honouring
        if (r.quietSeconds <= limit) {
          r.budgetHold = { declaredSeconds: r.declaredBudgetSeconds, limitSeconds: limit };
          r.state = 'working';
        }
      }

      /*
       * Expire monitor records explicitly, before anything reads them.
       *
       * When a monitor NEVER expires, the stuck list shows a conversation we deliberately chose not to
       * act on. That is not harmless: the list is what a person reads, and a row nobody can explain
       * ("I was told about this and told not to worry") trains them to ignore the whole notice.
       */
      for (const [id, since] of monitors) {
        if (now - since > HOOK_WINDOW_MS) monitors.delete(id);
      }

      /*
       * Who is mid-turn right now, refreshed from this pass - and CLEARED for everyone else.
       *
       * `notify()` never wakes a conversation that is working: a followup lands inside work in
       * progress, and the woken conversation then looks silent (and therefore stuck) to the next
       * tick. But the flag has to be re-decided every pass. Leaving it set for a session the new
       * verdict calls stuck is the bug that made the deferred-report path dead: the guard kept saying
       * "busy" about a session that had already been flagged, so the retry it was waiting for could
       * never fire.
       */
      for (const r of rows) {
        markSeen(r.id, r.mtime);
        /*
         * A session waiting on its user is BUSY, not idle and not stuck: the turn is very much open
         * and the next move is a person's. Treating it as working also keeps it out of the recipient
         * list, which matters - waking a conversation that is already waiting for you to answer is
         * noise on top of the question you have not answered yet.
         */
        if (r.state === 'working' || r.state === 'waiting-for-human') { markBusy(r.id); workingAt.set(r.id, now); } else { workingAt.delete(r.id); }
        /* ...and the human-wait flag is remembered regardless of how stale the transcript is */
        if (r.state === 'waiting-for-human') awaitingHumanRoots.add(r.id); else awaitingHumanRoots.delete(r.id);
      }

      /* diagnose only what the verdict flagged, and only once per cause per session */
      const stuck = pick('stuck')
        /* A conversation this watchdog already woke is a monitor, not a suspect. Dropping it here
         * (not just from the recipient list) is what actually breaks the loop: it leaves the stuck
         * list AND stops the diagnosis, so it can neither be re-reported nor cascade. */
        .filter((r) => !monitors.has(r.id))
        .map((r) => {
          const source = scope.find((s) => s.id === r.id);
          let d = null;
          if (diagnosisEnabled && source) {
            d = diagnose({
              file: source.file,
              mtime: source.mtime,
              now,
              staleSeconds: r.thresholdSeconds ?? staleS,
              contentBudget,
              authorizedBy,
            });
          }
          return { ...r, diagnosis: d };
        });

      const next = {
        at: now,
        staleSeconds: staleS,
        /* An open turn with no tool call is the weak signal and gets its own, longer window. The
         * page shows this so the notice never has to hardcode a rule the host has already changed. */
        weakStaleSeconds: staleS * OPEN_TURN_STALE_FACTOR,
        available: true,
        reason: null,
        diagnosis: { enabled: diagnosisEnabled, contentBudget, authorizedBy },
        counts: { stuck: stuck.length, working: pick('working').length, idle: pick('idle').length, unreadable: pick('unreadable').length },
        stuck: stuck.map((r) => ({
          id: r.id,
          title: r.title,
          quietSeconds: r.quietSeconds,
          tail: r.tail,
          signal: r.signal ?? null,
          thresholdSeconds: r.thresholdSeconds ?? null,
          cause: r.diagnosis?.cause ?? null,
          summary: r.diagnosis?.summary ?? null,
          detail: r.diagnosis?.detail ?? null,
          confidence: r.diagnosis?.confidence ?? null,
          read: r.diagnosis?.read ?? [],
        })),
        sessions: rows.map((r) => ({
          id: r.id,
          state: r.state,
          quietSeconds: r.quietSeconds,
          tail: r.tail,
          /* why a strong-looking signal is not in the stuck list: it told us how long it needs */
          budgetHold: r.budgetHold ?? null,
        })),
        notifications: snapshot.notifications ?? [],
      };

      /*
       * Disclose what is being suppressed. A watchdog that silently drops candidates is
       * indistinguishable from one that has nothing to say - the failure mode this whole repo exists
       * to prevent - so the reason a session is NOT in `stuck` travels with the snapshot instead of
       * being invisible. It also lets a test assert the suppression itself rather than a coincidence
       * of file timestamps.
       */
      next.suppressed = rows
        .filter((r) => isMonitor(r.id, now))
        .map((r) => ({ id: r.id, verdict: r.state, reason: 'woken by session-watch: treated as a monitor, not a suspect' }));

      /* the same disclosure for delivery: a snapshot that can never reach anyone must not look like
       * one that simply has nothing to say */
      next.notifyUnavailable = notifyUnavailable;

      /*
       * Aggregate the state the counts were silently missing. `waiting-for-human` was not in any
       * bucket, which would have made a session vanish from the summary while still appearing in
       * `sessions` - the kind of arithmetic gap that makes a snapshot contradict itself.
       */
      next.waitingForHuman = next.sessions.filter((s) => s.state === 'waiting-for-human').length;

      /*
       * Expose which conversation the PAGE is showing.
       *
       * The notice already knows (the page posts its own id), and any other surface that wants to say
       * "this one is asking" needs the same answer - otherwise each consumer re-derives it, and they
       * drift. It is also how the badge distinguishes "the window in front of you is asking" from
       * "somewhere else needs you", which the user asked to be able to tell apart.
       */
      next.selfSessionId = watcherSessionId ?? notifySessionId;

      /* announce transitions so a consumer can react without polling */
      const before = new Map(snapshot.sessions.map((s) => [s.id, s.state]));

      /*
       * Who may be woken about a given stuck session. Three rules, all applied at one place so no
       * call path can quietly skip them (the first version guarded only the roots branch, so the
       * pinned-target branch walked straight past both the monitor and the busy rule):
       *
       *   1. never the stuck session itself
       *   2. never a conversation this watchdog has already made a monitor
       *   3. never a conversation that is mid-turn
       *
       * Returning [] is NOT a failure to report - it means "nobody to tell right now", and the
       * caller leaves the session in `pending` for a later tick instead of dropping the alert.
       */
      /*
       * Who has already been made a monitor DURING THIS TICK.
       *
       * `monitors` is only written after a successful delivery, so an ordering that marks the id any
       * earlier would leave `stuck` (built before this loop) stale. Keeping a tick-local view and
       * consulting it first means the second half of a simultaneous pair is skipped no matter what
       * happened to the first delivery - including a followup() that threw for every candidate.
       */
      const monitorsThisTick = new Set();

      /*
       * Pick the ONE conversation to wake, or none.
       *
       * `eligible` is the whole rule for "is this conversation a legal recipient right now", and it
       * lives here rather than in notify() so that every path - pinned or not - is filtered by the
       * same test. The first version checked some of these rules in notify() and the pinned branch
       * walked straight past the rest.
       */
      const eligible = (agent, diagnosedId) => Boolean(
        agent
        && typeof agent.followup === 'function'
        && agent.id !== diagnosedId
        && !monitorsThisTick.has(agent.id)
        && !isMonitor(agent.id, now)
        && !awaitingHumanRoots.has(agent.id)     // never stack a second question on a pending one
        && !isBusyRoot(agent.id, now));

      const eligibleRecipients = (diagnosedId) => {
        /* No registry at all is not the same as "everyone is busy": it means a diagnosis can never
         * reach a person. Guarded explicitly, because optional chaining would turn this into a silent
         * empty list - which is what made the first version of this fix unable to tell "nobody to
         * tell" apart from "nothing wrong". */
        if (!ctx.agents || typeof ctx.agents.roots !== 'function') { warnNoAgents(); return []; }

        const wanted = watcherSessionId ?? notifySessionId;
        if (wanted) {
          let pinned;
          try { pinned = ctx.agents?.get?.(wanted); } catch { pinned = undefined; }
          /*
           * A pin falls back to the roots ONLY when the pinned conversation is GONE.
           *
           * Falling back whenever the pin was merely ineligible defeated the pin itself: pinning
           * "report only to X" quietly reported to somebody else the moment X was busy, which is the
           * behaviour a pin exists to prevent. Gone means the host no longer has it at all.
           */
          if (pinned) return eligible(pinned, diagnosedId) ? [pinned] : [];
        }

        let roster;
        try {
          roster = ctx.agents?.roots?.() ?? [];
        } catch (error) {
          ctx.logger?.warn?.(`session-watch: cannot enumerate conversations: ${error?.message ?? error}`);
          return [];
        }

        const candidates = roster.filter((agent) => eligible(agent, diagnosedId));
        if (candidates.length <= 1) return candidates;

        /*
         * Most recently active wins. `lastSeen.observed` is when we last saw anything from it, which
         * is present for every session the verdict pass has looked at; a root with no record at all
         * sorts last rather than being excluded, because "we have never looked at it" is not evidence
         * that it is a bad choice.
         */
        const rank = (agent) => lastSeen.get(agent.id)?.observed ?? 0;
        candidates.sort((a, b) => rank(b) - rank(a));
        return [candidates[0]];
      };


      const recordNotification = (row, to) => {
        next.notifications = [...next.notifications, {
          at: now, id: row.id, title: row.title, cause: row.diagnosis.cause, signal: row.signal,
          summary: row.diagnosis.summary, delivered: true, to,
        }].slice(-20);
      };

      for (const s of next.sessions) {
        const was = before.get(s.id);
        if (was !== s.state && (s.state === 'stuck' || was === 'stuck')) {
          ctx.emit('session-watch/changed', { id: s.id, title: s.title, from: was ?? null, to: s.state, quietSeconds: s.quietSeconds, tail: s.tail });
          ctx.logger?.info?.(`session-watch: ${was ?? 'new'} -> ${s.state}  ${s.id}  quiet ${s.quietSeconds}s`);
        }

        /* recovery releases the incident, so a later, unrelated hang is reportable again */
        if (was === 'stuck' && s.state !== 'stuck') {
          announced.delete(s.id);
          pending.delete(s.id);
        }
      }

      /*
       * REPORTING, deliberately after the transition loop and deliberately retried.
       *
       * The first version called notify() from inside the transition branch and forgot the result.
       * Two consequences, both bad: a same-tick pair of stuck sessions still woke each other (the
       * `stuck` array was built before `monitors` was updated, so both looked like legal recipients),
       * and an alert whose only recipient happened to be busy was gone for good.
       *
       * Every stuck, wakeable, diagnosed, not-yet-delivered session is a candidate - whether it
       * arrived this tick or ten ticks ago.
       */
      const stuckNow = new Set(stuck.map((r) => r.id));
      for (const id of [...pending.keys()]) {
        if (!stuckNow.has(id)) pending.delete(id);   // it recovered while we were waiting
      }

      for (const row of stuck) {
        if (row.signal !== 'tool-call') continue;    // weak signal: on screen only, never wakes anyone
        if (!row.diagnosis) continue;
        if (isMonitor(row.id, now)) continue;        // no self-referential politeness: a monitor is out

        /* The transition loop above runs in the snapshot's order, so by the time we get here every
         * session woken earlier in THIS tick is already flagged and skipped. That ordering is what
         * closes the same-tick race. */
        /* already announced: this incident is done, however the candidate list has changed since */
        if (announced.has(row.id)) continue;

        const candidates = eligibleRecipients(row.id);

        if (candidates.length === 0) {
          /* record the diagnosis, keep it for retry, and do NOT log a delivery */
          const noise = (snapshot.notifications ?? []).some((n) => n.id === row.id && n.cause === row.diagnosis.cause);
          pending.set(row.id, { diagnosis: row.diagnosis, title: row.title, signal: row.signal, since: now });
          if (!noise) {
            ctx.logger?.info?.(`session-watch: ${row.id} (${row.diagnosis.cause}) has nobody to report to yet; will retry`);
          }
          continue;
        }

        /* `diagnose()` is a pure function over a transcript and has no idea which session it was
         * handed, so the id is attached here - otherwise the delivery log says "reported undefined",
         * which is how a watchdog's own audit trail becomes useless. */
        const result = notify({ ...row.diagnosis, id: row.id }, row.title, candidates);
        if (!result?.delivered) {
          pending.set(row.id, { diagnosis: row.diagnosis, title: row.title, signal: row.signal, since: now });
          continue;
        }
        for (const target of result.to) {
          announced.add(row.id);
          monitors.set(target, now);   // it is part of the watching now; not a suspect any more
          monitorsThisTick.add(target);
        }
        pending.delete(row.id);
        recordNotification(row, result.to);
        ctx.logger?.info?.(`session-watch diagnosis ${row.id}: ${row.diagnosis.cause} (${row.signal}) — ${row.diagnosis.summary}`);
      }

      /*
       * Withhold the monitors from the stuck list LAST, because this tick is when some of them became
       * monitors.
       *
       * `stuck` was filtered before any delivery, so a conversation woken a few lines above is still
       * in it - and the notice would list a row the plugin has decided not to act on. A person cannot
       * act on "I was told about this and told not to worry" either; the row teaches them to ignore
       * the notice. Re-filtering here, once the monitor set is final for this tick, closes that gap.
       *
       * The count has to move with it: `counts.stuck` is what the UI summarises, and letting it keep
       * counting withheld rows would make the snapshot contradict its own list.
       */
      next.stuck = next.stuck.filter((r) => !isMonitor(r.id, now));
      next.counts.stuck = next.stuck.length;

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

        /*
         * An event IS evidence of life. This is the second, independent busy signal: the mtime has
         * not necessarily caught up with a session that has just started writing, and a session that
         * is mid-turn must not be woken. Without this the guard can be one tick stale, which is
         * precisely the window the mutual-watch loop used to slip through.
         */
        markBusy(id);
        markSeen(id, Date.now(), 'event');
        const was = lastKnownState.get(id);
        if (was === undefined || was === 'working' || was === 'stuck') scheduleRescan();
      } catch { /* an event listener must never break the Host */ }
    });
  }

  register({
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
  register({
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
    register({
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
      table.push(makeNoticeInjection(NOTICE_ROUTE, ROUTE, WATCHER_ROUTE));
    });
  }

  ctx.logger?.info?.(`session-watch ready: every ${intervalMs / 1000}s, stuck after ${staleS}s of silence, zstd=${hasZstd ? 'yes' : 'NO'}`);
  } catch (error) {
    cleanup();
    throw error;
  }
}
