/** Keep the desktop fetch bridge alive while the host HMR SSE channel is idle. */
export function keepPluginEventsAlive(ctx, intervalMs = 30000) {
  const route = ctx.webServer.match?.('/plugins/events');
  if (!route || route.path !== '/plugins/events') return () => {};
  const original = route.handler;
  const stops = new Set();
  function handler(req, res) {
    if (req.method !== 'GET') return original(req, res);
    const timer = setInterval(() => {
      if (res.destroyed || res.writableEnded) { stop(); return; }
      // SSE comments do not change graph/rebuilt messages or trigger a reload.
      if (res.headersSent && !res.writableNeedDrain) res.write(': session-watch keepalive\n\n');
    }, intervalMs);
    timer.unref?.();
    const stop = () => {
      clearInterval(timer);
      stops.delete(stop);
      res.off('close', stop);
      res.off('error', stop);
    };
    stops.add(stop);
    res.once('close', stop);
    res.once('error', stop);
    try {
      const result = original(req, res);
      if (result && typeof result.then === 'function') return result.catch(error => { stop(); throw error; });
      return result;
    } catch (error) { stop(); throw error; }
  }
  route.handler = handler;
  return () => {
    if (route.handler === handler) route.handler = original;
    for (const stop of [...stops]) stop();
  };
}
