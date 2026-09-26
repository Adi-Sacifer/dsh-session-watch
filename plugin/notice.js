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
  var STATE_URL = (HERE && HERE.getAttribute('data-session-watch-state')) || '/session-watch/state.json';
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
    if (dismissed || stuck.length === 0) { remove(); return; }

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
    head.textContent = stuck.length === 1 ? '1 个会话可能卡住了' : stuck.length + ' 个会话可能卡住了';
    box.appendChild(head);

    stuck.slice(0, 4).forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'sw-row';
      row.textContent = (s.title || s.id) + ' · 静默 ' + s.quietSeconds + 's · ' + s.tail;
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
    why.textContent = '判据：转录停止增长超过 ' + (state.staleSeconds || '?') + 's 且回合未收尾';
    box.appendChild(why);

    el.appendChild(box);

    var close = document.createElement('button');
    close.className = 'sw-x';
    close.textContent = '×';
    close.title = '本次页面内不再提示（刷新后恢复）';
    close.onclick = function () { dismissed = true; remove(); };
    el.appendChild(close);
  }

  function read() {
    fetch(STATE_URL, { headers: { accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (state) { if (state) render(state); })
      .catch(function () { /* host not ready: say nothing rather than shout */ });
  }

  function start() {
    if (window.__sessionWatchNotice) return;
    window.__sessionWatchNotice = true;
    read();
    setInterval(read, POLL_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
