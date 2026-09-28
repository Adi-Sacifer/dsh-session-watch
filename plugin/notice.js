/**
 * The on-screen notice, served by the host half at /session-watch/notice.js and pulled in by the
 * index-injection row.
 *
 * WHY PLAIN DOM AND NOT A MODULE-LOADER CLIENT
 *   A normal `dsh.client` half only loads if the browser's module graph already knows the package,
 *   and that graph is built at boot. A bundle installed into a running Host never appears, so
 *   /plugins/<id>/client.js 404s until a restart. This file needs nothing from that graph: it is
 *   an ordinary script that builds its own element. `client.js` still exists for installs that do
 *   restart; both render the same notice.
 *
 * IT STAYS QUIET WHEN NOTHING IS WRONG
 *   No element is created at all unless a session is flagged, and the element is removed once the
 *   last one recovers. A watchdog that permanently occupies the screen gets ignored.
 */
(function () {
  'use strict';

  /*
   * The state route is unique per plugin load (it carries the plugin file's own mtime stamp), so
   * this script reads it off its own tag rather than hard-coding a path that a reload would stale.
   * `document.currentScript` is only valid while the tag executes, so capture it first.
   */
  var HERE = document.currentScript;
  var STATE_URL = (HERE && HERE.getAttribute('data-session-watch-state')) || null;
  var WATCHER_URL = (HERE && HERE.getAttribute('data-session-watch-watcher')) || null;
  var POLL_MS = 5000;
  var ID = 'session-watch-notice';

  function ensureStyles() {
    if (document.getElementById(ID + '-style')) return;
    var style = document.createElement('style');
    style.id = ID + '-style';
    /* theme tokens with literal fallbacks, so this also renders if a token is renamed */
    style.textContent =
      '#' + ID + '{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483000;' +
      'max-width:min(680px,92vw);display:flex;gap:10px;align-items:flex-start;padding:9px 12px;' +
      'border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);' +
      'font:12.5px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;' +
      'background:var(--dsw-alias-bg-overlay,rgba(28,28,30,.96));color:var(--dsw-alias-fg-primary,#fff);' +
      'border:1px solid var(--dsw-alias-border-strong,rgba(255,255,255,.22))}' +
      '#' + ID + ' .sw-dot{width:8px;height:8px;margin-top:5px;border-radius:50%;flex:0 0 auto;' +
      'background:var(--dsw-alias-status-warning,#e8a33d)}' +
      '#' + ID + ' .sw-head{font-weight:600;margin-bottom:3px}' +
      '#' + ID + ' .sw-row{opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:58ch}' +
      '#' + ID + ' .sw-dim{opacity:.62}' +
      '#' + ID + ' .sw-x{margin-left:auto;cursor:pointer;opacity:.6;background:none;border:none;' +
      'color:inherit;font:inherit;padding:0 2px}';
    document.head.appendChild(style);
  }

  var dismissed = false;

  function remove() {
    var el = document.getElementById(ID);
    if (el) el.remove();
  }

  /*
   * A watchdog that cannot read transcripts is INDISTINGUISHABLE from a healthy system if it stays
   * silent - both look like "all clear". That is the worst failure mode this whole repo warns
   * about, so when the host reports `available: false` this says so out loud instead of rendering
   * nothing. It is a distinct, dismissible line, not the stuck-session notice.
   */
  function renderUnavailable(state) {
    if (dismissed) { remove(); return; }
    ensureStyles();
    var el = document.getElementById(ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ID;
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.style.background = 'var(--dsw-alias-bg-overlay, rgba(60,20,20,.96))';
    el.textContent = '';

    var dot = document.createElement('span');
    dot.className = 'sw-dot';
    dot.style.background = 'var(--dsw-alias-status-danger, #d9534f)';
    dot.setAttribute('aria-hidden', 'true');
    el.appendChild(dot);

    var box = document.createElement('div');
    var head = document.createElement('div');
    head.className = 'sw-head';
    head.textContent = '会话监视没有在工作';
    box.appendChild(head);
    var why = document.createElement('div');
    why.className = 'sw-row';
    why.textContent = state.reason || '宿主报告无法读取转录';
    box.appendChild(why);
    el.appendChild(box);

    var close = document.createElement('button');
    close.className = 'sw-x';
    close.textContent = '×';
    close.title = '本次页面内不再提示（刷新后恢复）';
    close.onclick = function () { dismissed = true; remove(); };
    el.appendChild(close);
  }

  function render(state) {
    if (state && state.available === false) { renderUnavailable(state); return; }
    var stuck = state && state.stuck ? state.stuck : [];
    var sessions = state && state.sessions ? state.sessions : [];
    /*
     * A session waiting on ask_user_question is NOT stuck, but it is the one thing a person most wants
     * to be told: it explains why a conversation has gone quiet without anything being wrong. So it is
     * shown, and it must be able to show WITHOUT any stuck session - otherwise the "nothing is wrong"
     * gate below would hide the only useful line.
     */
    var waitingOnMe = sessions.filter(function (s) { return s.state === 'waiting-for-human'; });
    if (dismissed || (stuck.length === 0 && waitingOnMe.length === 0)) { remove(); return; }

    ensureStyles();
    var el = document.getElementById(ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ID;
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    /* the unavailable path sets an inline background; clear it so recovery restores the stylesheet */
    el.style.background = '';
    el.textContent = '';

    var dot = document.createElement('span');
    dot.className = 'sw-dot';
    dot.setAttribute('aria-hidden', 'true');
    el.appendChild(dot);

    var box = document.createElement('div');

    var head = document.createElement('div');
    head.className = 'sw-head';
    /*
     * "Stuck" and "waiting for you" are different claims and must not share a headline.
     *
     * A session parked on ask_user_question is not in trouble - it is waiting for a decision that only
     * a person can make. Reporting it as possibly-stuck is doubly wrong: it is false, and the remedy
     * suggested by these notices ("go look") is the very thing that would answer it. So they get their
     * own line, with a note that the wait is the intended state.
     */
    head.textContent = stuck.length === 0
      ? (waitingOnMe.length === 1 ? '1 个会话在等你回答' : waitingOnMe.length + ' 个会话在等你回答')
      : (stuck.length === 1 ? '1 个会话可能卡住了' : stuck.length + ' 个会话可能卡住了');
    box.appendChild(head);

    stuck.slice(0, 4).forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'sw-row';
      /* `summary` is the diagnosis: the notice names the cause, not just the symptom */
      row.textContent = (s.title || s.id) + ' · 静默 ' + s.quietSeconds + 's · '
        + (s.summary || s.tail);
      box.appendChild(row);
      if (s.detail) {
        var detail = document.createElement('div');
        detail.className = 'sw-row sw-dim';
        detail.style.paddingLeft = '10px';
        detail.textContent = '↳ ' + s.detail;
        box.appendChild(detail);
      }
    });

    waitingOnMe.slice(0, 2).forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'sw-row';
      row.textContent = (s.title || s.id) + ' · 在等你回答 · 已等 ' + s.quietSeconds + 's';
      box.appendChild(row);
    });

    if (stuck.length > 4) {
      var more = document.createElement('div');
      more.className = 'sw-dim';
      more.textContent = '还有 ' + (stuck.length - 4) + ' 个…';
      box.appendChild(more);
    }

    var why = document.createElement('div');
    why.className = 'sw-dim';
    why.style.marginTop = '3px';
    /* say how much was read, so the content boundary is visible rather than assumed */
    var readNote = stuck[0] && stuck[0].read && stuck[0].read.length
      ? '已读取：' + stuck[0].read.join('、')
      : '只看了结构信息';
    /*
     * The rule comes from the host, not from a string baked in here. The host now applies two
     * different windows - a tool call that never returned is evidence, an open turn with no tool
     * call is merely "the model may still be thinking" - and a page that printed one old number for
     * both would be lying about the weaker row.
     */
    var strong = (state.staleSeconds || '?') + 's';
    var weak = (state.weakStaleSeconds || state.staleSeconds || '?') + 's';
    var rule = stuck[0] && stuck[0].signal === 'open-turn'
      ? '回合开着但没有工具调用，且转录静默超过 ' + weak
      : '转录停止增长超过 ' + strong + ' 且工具调用没回来';
    why.textContent = '判据：' + rule + '　·　' + readNote + '　·　只读，没有动它';
    box.appendChild(why);

    el.appendChild(box);

    var close = document.createElement('button');
    close.className = 'sw-x';
    close.textContent = '×';
    close.title = '本次页面内不再提示（刷新后恢复）';
    close.onclick = function () { dismissed = true; remove(); };
    el.appendChild(close);
  }

  var inFlight = false;
  var failures = 0;
  var nextReadAt = 0;
  function read() {
    if (!STATE_URL || inFlight || Date.now() < nextReadAt) return;
    inFlight = true;
    fetch(STATE_URL, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (state) { failures = 0; nextReadAt = 0; render(state); })
      .catch(function () {
        failures++;
        nextReadAt = Date.now() + Math.min(300000, POLL_MS * Math.pow(2, Math.min(failures, 6)));
        renderUnavailable({ reason: '暂时无法连接会话监视服务，正在自动重试' });
      })
      .finally(function () { inFlight = false; });
  }

  /*
   * Introduce this page to the host, so a diagnosis has somewhere to be delivered.
   *
   * The browser is not told which session it is showing (no session id is exposed to the page), so
   * this reports whatever identity IS available and lets the host fall back to notifying top-level
   * conversations. It is best-effort on purpose: a failure here must not break the notice.
   */
  function identify() {
    if (!WATCHER_URL) return;
    var payload = { sessionId: null, href: String(location.href || '') };
    try {
      var m = /(?:session|s)=([0-9a-f-]{8,})/i.exec(payload.href);
      if (m) payload.sessionId = m[1];
    } catch { /* ignore */ }
    try {
      fetch(WATCHER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(function () { });
    } catch { /* ignore */ }
  }

  function start() {
    if (!STATE_URL || window.__sessionWatchNotice) return;
    window.__sessionWatchNotice = true;
    identify();
    read();
    setInterval(read, POLL_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
