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
import zlib from 'node:zlib';

export const name = 'session-watch';

/* `timer` provides ctx.interval; `webServer` is where the UI gets its data. */
export const inject = ['timer', 'webServer'];

const ROUTE = '/session-watch/state';
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

const DSH = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESS_ROOT = path.join(DSH, 'sessions');
const PROJ_CACHE = path.join(DSH, 'storages', 'session_projcache', 'sessions');

const hasZstd = typeof zlib.zstdDecompressSync === 'function';

/*
 * The transcript is an append-only log of INDEPENDENT zstd frames. A plain decompress returns
 * only the first frame and looks like an empty conversation, so walk the frame magic instead.
 */
function readRecords(file) {
  const buf = fs.readFileSync(file);
  const offs = [];
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i);
  }
  offs.push(buf.length);
  const parts = [];
  for (let k = 0; k < offs.length - 1; k++) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], offs[k + 1]))); continue; } catch { }
    for (let j = k + 2; j < offs.length; j++) {
      try { parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], offs[j]))); k = j - 1; break; } catch { }
    }
  }
  const out = [];
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { }
  }
  return out;
}

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
  const intervalMs = Math.max(5, Number(config?.intervalSeconds ?? 15)) * 1000;
  const staleS = Math.max(30, Number(config?.staleSeconds ?? 300));
  const windowMin = Math.max(10, Number(config?.windowMinutes ?? 1440));

  let snapshot = {
    at: Date.now(),
    staleSeconds: staleS,
    available: hasZstd,
    reason: hasZstd ? null : `zstd decompression unavailable in this runtime (node ${process.versions.node}); the plugin cannot read transcripts`,
    counts: { stuck: 0, working: 0, idle: 0, unreadable: 0 },
    stuck: [],
    sessions: [],
  };

  const tick = () => {
    if (!hasZstd) return;   // keep reporting `unavailable` rather than pretending everything is fine
    try {
      const now = Date.now();
      const scope = sessionFiles().filter((s) => now - s.mtime < windowMin * 60_000);
      const rows = scope.map((s) => verdictOf(s, { now, staleS }));
      const pick = (state) => rows.filter((r) => r.state === state);

      const next = {
        at: now,
        staleSeconds: staleS,
        available: true,
        reason: null,
        counts: { stuck: pick('stuck').length, working: pick('working').length, idle: pick('idle').length, unreadable: pick('unreadable').length },
        stuck: pick('stuck').map((r) => ({ id: r.id, title: r.title, quietSeconds: r.quietSeconds, tail: r.tail })),
        sessions: rows.map((r) => ({ id: r.id, state: r.state, quietSeconds: r.quietSeconds, tail: r.tail })),
      };

      /* announce transitions so a consumer can react without polling */
      const before = new Map(snapshot.sessions.map((s) => [s.id, s.state]));
      for (const s of next.sessions) {
        const was = before.get(s.id);
        if (was !== s.state && (s.state === 'stuck' || was === 'stuck')) {
          ctx.emit('session-watch/changed', { id: s.id, title: s.title, from: was ?? null, to: s.state, quietSeconds: s.quietSeconds, tail: s.tail });
          ctx.logger?.info?.(`session-watch: ${was ?? 'new'} -> ${s.state}  ${s.id}  quiet ${s.quietSeconds}s`);
        }
      }
      snapshot = next;
    } catch (error) {
      snapshot = { ...snapshot, at: Date.now(), reason: String(error?.message ?? error) };
      ctx.logger?.warn?.(`session-watch scan failed: ${error?.message ?? error}`);
    }
  };

  tick();
  ctx.interval(tick, intervalMs);

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

  ctx.logger?.info?.(`session-watch ready: every ${intervalMs / 1000}s, stuck after ${staleS}s of silence, zstd=${hasZstd ? 'yes' : 'NO'}`);
}
