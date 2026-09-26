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
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-watch',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/session-watch/state';

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
        const read = async () => {
          try {
            const res = await fetch(ROUTE, { headers: { accept: 'application/json' } });
            if (res.ok && alive) setState(await res.json());
          } catch { /* host not ready or route gone: stay silent rather than shout */ }
        };
        read();
        const timer = setInterval(read, 5000);
        return () => { alive = false; clearInterval(timer); };
      }, []);

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
