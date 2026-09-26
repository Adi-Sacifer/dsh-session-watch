/**
 * diagnose.js - WHY is a session stuck? Read-only, and it never touches the live session.
 *
 * WHAT IT IS FOR
 *   The verdict pass answers "is something stuck". This answers "stuck on WHAT", so a notice can
 *   carry a cause instead of just an alarm. It is a pure function over a transcript file plus
 *   metadata: it opens no handle on the running session, sends it nothing, and cannot affect it in
 *   any way. Diagnosing is not interfering.
 *
 * TWO LAYERS, AND THE SECOND IS AUTHORIZED CONTENT READING
 *   Layer 1 is structure only: which record the transcript died on, how long ago, and what the
 *   pending tool call was, including its arguments. Reading a tool call's arguments is where the
 *   single most useful fact comes from - "it is stuck on THIS command" - and it needs no permission
 *   because it is the same metadata the verdict already reads.
 *
 *   Layer 2 reads conversation CONTENT - the last assistant sentence, the last human instruction,
 *   an error result. That crosses from metadata into what was actually said, so it happens only
 *   when the caller explicitly passes a diagnosis budget. The caller is responsible for having the
 *   user's authorization; this module never decides that for itself, and it reports back exactly
 *   how much it read so the answer can be audited.
 *
 * A DELIBERATE LIMIT
 *   No reasoning blocks are read, ever. They sit in the same content array as visible text, and
 *   pulling them in would leak private thinking for no diagnostic value. Filtering by
 *   `type === 'text'` is what keeps that boundary.
 */
import { readRecords, hasZstd, unavailableReason } from './archive.js';

const TOOL_ARG_KEYS = ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'name', 'text'];

function clip(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Pull the one field of a tool call's arguments that says what it was actually doing. */
function describeArgs(raw, max = 200) {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      for (const k of TOOL_ARG_KEYS) {
        if (typeof o[k] === 'string' && o[k].trim() !== '') return `${k}: ${clip(o[k], max)}`;
      }
      return clip(JSON.stringify(o), max);
    }
  } catch { /* not JSON: fall through to the raw text */ }
  return clip(raw, max);
}

/**
 * Walk the transcript once and work out what the tail is waiting on.
 * Returns structure only - no message text.
 */
function analyze(records) {
  let pendingCall = null;
  let lastToolResult = null;
  let lastTurnEnd = null;
  let lastUserAt = null;
  let openTurn = false;
  let turnStarts = 0;
  let turnEnds = 0;
  const resultIds = new Set();

  for (const r of records) {
    if (!r || !r.type) continue;
    switch (r.type) {
      case 'tool/call':
        pendingCall = { name: r.data?.name ?? '?', callId: r.data?.callId, args: r.data?.arguments, at: r.time ?? 0 };
        break;
      case 'tool/result': {
        const id = r.data?.callId ?? r.data?.message?.toolCallId;
        resultIds.add(id);
        lastToolResult = { at: r.time ?? 0, error: r.data?.error ?? null, isError: Boolean(r.data?.message?.isError) };
        if (pendingCall && pendingCall.callId === id) pendingCall = null;
        break;
      }
      case 'turn/start':
        openTurn = true; turnStarts++; break;
      case 'turn/end':
        openTurn = false; pendingCall = null; lastTurnEnd = r.time ?? 0; turnEnds++; break;
      case 'user/message':
        if (r.data?.source?.kind === 'user') lastUserAt = r.time ?? 0;
        break;
      default:
        break;
    }
  }
  return { pendingCall, lastToolResult, lastTurnEnd, lastUserAt, openTurn, turnStarts, turnEnds, resultIds };
}

/**
 * Turn the tail structure into a named cause plus a human line and honest confidence.
 *
 * Confidence is deliberately conservative. A transcript that stopped mid-tool-call is strong
 * evidence; "the result arrived but the model never answered" is weaker, because a slow model looks
 * identical until the stale threshold passes - and saying "stuck" about a model that is merely
 * thinking is exactly the false alarm that makes a watchdog worthless.
 */
function classify(info, opts) {
  const { pendingCall, lastToolResult, openTurn } = info;
  const now = opts.now;

  if (pendingCall) {
    const ageS = Math.round((now - (pendingCall.at || now)) / 1000);
    const detail = describeArgs(pendingCall.args);
    const long = ageS > (opts.staleSeconds ?? 300) * 2;
    return {
      cause: 'tool-call-hung',
      confidence: long ? 'high' : 'medium',
      summary: `卡在工具 ${pendingCall.name} 上，已经 ${ageS} 秒没有返回`,
      detail,
      tool: pendingCall.name,
      since: pendingCall.at,
      ageSeconds: ageS,
    };
  }

  if (openTurn) {
    const ageS = Math.round((now - (opts.transcriptMtime ?? now)) / 1000);
    if (lastToolResult) {
      return {
        cause: 'model-waiting-after-tool-result',
        confidence: 'low',
        summary: `工具结果已返回，但模型 ${ageS} 秒没有回应（也可能只是很慢）`,
        detail: lastToolResult.error ? `上一个工具结果带错误：${clip(lastToolResult.error.message ?? lastToolResult.error.code ?? '', 200)}` : null,
        since: lastToolResult.at,
        ageSeconds: ageS,
      };
    }
    return {
      cause: 'model-not-responding',
      confidence: 'low',
      summary: `回合开着但没有任何工具调用，模型 ${ageS} 秒没有回应（也可能只是很慢）`,
      detail: null,
      since: opts.transcriptMtime ?? now,
      ageSeconds: ageS,
    };
  }

  return {
    cause: 'not-stuck',
    confidence: 'high',
    summary: '转录尾部的回合已经收尾，这个会话不该被报成卡住',
    detail: null,
  };
}

/**
 * Read the last few conversation facts, within an explicit budget.
 * Text blocks only - reasoning blocks are skipped by design.
 */
function readContext(records, budget) {
  const assistantTexts = [];
  const userTexts = [];
  let lastErrorResult = null;

  for (const r of records) {
    if (!r || !r.type) continue;
    if (r.type === 'assistant/message') {
      const blocks = r.data?.message?.content;
      if (!Array.isArray(blocks)) continue;
      const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
      if (text) assistantTexts.push({ at: r.time ?? 0, text });
    } else if (r.type === 'user/message') {
      if (r.data?.source?.kind !== 'user') continue;   // skip host-injected boilerplate
      const blocks = r.data?.content;
      if (!Array.isArray(blocks)) continue;
      const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
      if (text) userTexts.push({ at: r.time ?? 0, text });
    } else if (r.type === 'tool/result') {
      const failed = r.data?.error || r.data?.message?.isError;
      if (!failed) continue;
      const blocks = r.data?.message?.content;
      const text = Array.isArray(blocks)
        ? blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
        : '';
      lastErrorResult = { at: r.time ?? 0, text: text || clip(r.data?.error?.message ?? '', 300) };
    }
  }

  const read = [];
  const out = {};
  const take = (list, key, label) => {
    if (list.length === 0) return;
    const chosen = list.slice(-budget);
    out[key] = chosen.map((x) => ({ at: x.at, text: clip(x.text, 400) }));
    read.push(`${label}×${chosen.length}`);
  };
  take(assistantTexts, 'lastAssistant', '助手消息');
  take(userTexts, 'lastUser', '你的指令');
  if (lastErrorResult && budget > 0) {
    out.lastErrorResult = { at: lastErrorResult.at, text: clip(lastErrorResult.text, 300) };
    read.push('错误结果×1');
  }

  return { context: out, readBudget: budget, read: read };
}

/**
 * @param {object} input
 * @param {string} input.file            transcript path
 * @param {number} input.mtime           its mtime (ms)
 * @param {number} [input.now]
 * @param {number} [input.staleSeconds]  the same threshold the verdict uses
 * @param {number} [input.contentBudget] how many recent messages may be read. 0 = structure only.
 *                                       Non-zero must be authorized by the caller.
 * @param {string} [input.authorizedBy]  free text recorded in the result, so an audit can see who
 *                                       allowed the content read and when.
 */
export function diagnose(input) {
  const now = input.now ?? Date.now();
  const base = {
    at: now,
    quietSeconds: Math.round((now - input.mtime) / 1000),
    contentBudget: input.contentBudget ?? 0,
    authorizedBy: input.authorizedBy ?? null,
  };

  if (!hasZstd) {
    return { ...base, cause: 'cannot-read', confidence: 'high', summary: unavailableReason, detail: null, read: [] };
  }

  let records;
  try {
    records = readRecords(input.file);
  } catch (error) {
    return { ...base, cause: 'unreadable', confidence: 'high', summary: `转录读不出来：${error?.message ?? error}`, detail: null, read: [] };
  }

  const info = analyze(records);
  const verdict = classify(info, { now, staleSeconds: input.staleSeconds, transcriptMtime: input.mtime });

  const budget = Math.max(0, Math.floor(input.contentBudget ?? 0));
  const content = budget > 0
    ? readContext(records, budget)
    /* structure-only runs still report what they touched, so "we read nothing" is visible */
    : {
      context: {
        lastToolCall: info.pendingCall
          ? { name: info.pendingCall.name, at: info.pendingCall.at, arguments: describeArgs(info.pendingCall.args, 300) }
          : null,
      },
      readBudget: 0,
      read: [],
    };

  return {
    ...base,
    ...verdict,
    /* flattened on purpose: callers read diagnosis.lastAssistant, not diagnosis.context.lastAssistant */
    ...content.context,
    readBudget: content.readBudget,
    read: content.read,
    /* a structure-only run discloses what it DID look at, so the boundary is never implicit */
    structureRead: info.pendingCall
      ? `tool/call(${info.pendingCall.name}) 的参数`
      : `尾部记录类型（回合${info.openTurn ? '未收尾' : '已收尾'}）`,
  };
}
