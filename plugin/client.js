/**
 * Client half of dsh-session-watch.
 *
 * WHAT IT RENDERS
 *   A small notice in the frame-wide `shell.overlay` layer listing the sessions the host has
 *   flagged as stuck. It polls the host's `/session-watch/state` route, which the host half
 *   registers, so no Remote/typert plumbing is involved and the plugin stays self-contained.
 *
 * DELIBERATE CONSTRAINTS
 *   - No JSX: this file is served straight to the browser, and there is no build step on this
 *     machine (no DSH source checkout), so it is hand-written in the `window.__ModuleLoader__.load`
 *     format the shipped template uses and builds elements with `React.createElement`.
 *   - No import of any Harness Client package: `practices.md` forbids loading Harness Client
 *     packages as modules, so no Toast primitive and no theme-token helper - just an inline
 *     element styled with the documented `--dsw-alias-*` tokens.
 *   - Hooks only from `require('react')` (useState/useEffect), which the loader seeds.
 *   - The notice renders nothing at all when nothing is stuck, so an all-clear system is invisible.
 *
 * VERIFICATION LIMIT, STATED PLAINLY
 *   Whether this renders in the running page cannot be asserted from here: there is no browser
 *   control and no client-plugin HMR watcher on this machine. What CAN be verified is that the
 *   host half serves the state (curl the route) and that this file is served to the page
 *   (fetch /plugins/<id>/client.js). Visual confirmation is the user's eye, or a refresh.
 *
 * THE 404s THIS FILE USED TO CAUSE - worth reading before touching it again
 *   It hard-coded the state route as `/session-watch/state`. That path has NEVER existed: the host
 *   registers `/session-watch/state-<load-stamp>.json`, stamped so that reinstalling the plugin
 *   cannot collide with the previous generation's routes. So every 5s this poll 404'd, and the
 *   page's console accumulated >1000 errors - the user's report was literally "DevTools 一直在触发".
 *   The notice it was supposed to draw never appeared either.
 *
 *   Two rules now, and both matter:
 *     1. The URL is read off the injected <script> tag (see `stateUrl()`), never hard-coded.
 *     2. If the injected notice is already running, this half stays completely out of the way.
 *        Both halves draw the same notice, and stacking two copies of it is worse than not
 *        loading at all. No URL and no fetch: silence beats shouting.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-watch',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /**
     * The route is unique per plugin load, and the host publishes it on the tag it injects into the
     * served index.html. Reading it from there is the only way to stay correct across reloads.
     */
    function stateUrl() {
      const tag = document.getElementById('session-watch-notice-loader');
      const url = tag && tag.getAttribute('data-session-watch-state');
      return url || null;
    }

    /**
     * Has the injected notice taken over?
     *
     * `notice.js` sets the window flag when it starts; the element check covers the ordering where
     * this module mounts first and the injected script draws one tick later. Either way, one notice.
     */
    function injectedNoticeOwnsUi() {
      return Boolean(window.__sessionWatchNotice) || Boolean(document.getElementById('session-watch-notice'));
    }

    const styles = {
      wrap: {
        position: 'fixed',
        top: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2147483000,
        maxWidth: 'min(680px, 92vw)',
        font: '12.5px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        background: 'var(--dsw-alias-bg-overlay, rgba(28,28,30,.96))',
        color: 'var(--dsw-alias-fg-primary, #fff)',
        border: '1px solid var(--dsw-alias-border-strong, rgba(255,255,255,.22))',
        borderRadius: '10px',
        padding: '9px 12px',
        boxShadow: '0 6px 24px rgba(0,0,0,.35)',
        display: 'flex',
        gap: '10px',
        alignItems: 'flex-start',
      },
      dot: {
        width: '8px',
        height: '8px',
        marginTop: '5px',
        borderRadius: '50%',
        background: 'var(--dsw-alias-status-warning, #e8a33d)',
        flex: '0 0 auto',
      },
      head: { fontWeight: 600, marginBottom: '3px' },
      row: { opacity: 0.92, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '58ch' },
      dim: { opacity: 0.62 },
      close: {
        marginLeft: 'auto',
        cursor: 'pointer',
        opacity: 0.6,
        padding: '0 2px',
        background: 'none',
        border: 'none',
        color: 'inherit',
        font: 'inherit',
      },
    };

    function SessionWatchNotice() {
      const [state, setState] = React.useState(null);
      const [hidden, setHidden] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        let inFlight = false;
        let failures = 0;
        let nextReadAt = 0;
        const read = async () => {
          /* the injected notice is already drawing it: this half must not fetch, must not render */
          if (!alive || inFlight || Date.now() < nextReadAt || injectedNoticeOwnsUi()) return;
          const url = stateUrl();
          /*
           * No tag means the index-injection did not happen, so there is no route to read and
           * nothing to draw from here. Returning is the whole point: the previous version fetched a
           * hard-coded path here and filled the console with 404s.
           */
          if (!url) return;
          inFlight = true;
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const state = await res.json();
            failures = 0;
            nextReadAt = 0;
            if (alive) setState(state);
          } catch {
            failures++;
            nextReadAt = Date.now() + Math.min(300000, 5000 * Math.pow(2, Math.min(failures, 6)));
          } finally { inFlight = false; }
        };
        read();
        const timer = setInterval(read, 5000);
        return () => { alive = false; clearInterval(timer); };
      }, []);

      if (injectedNoticeOwnsUi()) return null;
      if (hidden || !state || !state.stuck || state.stuck.length === 0) return null;

      const count = state.stuck.length;
      return h('div', { style: styles.wrap, role: 'status' },
        h('span', { style: styles.dot, 'aria-hidden': true }),
        h('div', { style: { minWidth: 0 } },
          h('div', { style: styles.head },
            count === 1 ? '1 个会话可能卡住了' : `${count} 个会话可能卡住了`),
          ...state.stuck.slice(0, 4).map((s) =>
            h('div', { key: s.id, style: styles.row },
              h('span', null, s.title || s.id),
              h('span', { style: styles.dim }, ` · 静默 ${s.quietSeconds}s · ${s.tail}`))),
          count > 4 ? h('div', { style: styles.dim }, `还有 ${count - 4} 个…`) : null,
          h('div', { style: { ...styles.dim, marginTop: '3px' } },
            `判据：转录停止增长超过 ${state.staleSeconds}s 且回合未收尾`),
        ),
        h('button', {
          style: styles.close,
          title: '本次会话内不再提示（刷新后恢复）',
          onClick: () => setHidden(true),
        }, '×'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        /*
         * `shell.overlay` is a root-scoped list slot for frame-wide floating layers, which is
         * exactly what a "something needs your attention" notice is. Registering into an
         * undeclared slot fails, so this key is used verbatim from the live Slot tree.
         */
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-watch-notice',
          order: 40,
          label: 'Session watch',
        }, SessionWatchNotice));
      },
    };
  },
});
