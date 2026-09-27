import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../plugin/notice.js', import.meta.url), 'utf8');

function page(url = '/state.json') {
  let now = 0;
  let calls = 0;
  let mode = 'fail';
  let resolvePending;
  const elements = new Map();
  function element() {
    return {
      style: {}, children: [], textContent: '',
      setAttribute() {},
      appendChild(child) {
        this.children.push(child);
        if (child.id) elements.set(child.id, child);
      },
      remove() { elements.delete(this.id); },
    };
  }
  const document = {
    readyState: 'complete',
    currentScript: { getAttribute: name => name === 'data-session-watch-state' ? url : null },
    getElementById: id => elements.get(id),
    createElement: element,
    head: element(), body: element(),
  };
  const timers = [];
  vm.runInNewContext(source, {
    document, window: {}, location: { href: 'http://localhost/' },
    Date: { now: () => now }, AbortSignal,
    setInterval: fn => timers.push(fn),
    fetch: async () => {
      calls++;
      if (mode === 'pending') return new Promise(resolve => { resolvePending = resolve; });
      if (mode === 'fail') return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ available: true, stuck: [] }) };
    },
  });
  return {
    timers, elements,
    get calls() { return calls; },
    set mode(value) { mode = value; },
    async tick(time) {
      now = time;
      timers.forEach(fn => fn());
      await new Promise(resolve => setImmediate(resolve));
    },
    settle() { resolvePending({ ok: true, json: async () => ({ available: true, stuck: [] }) }); },
  };
}

const absent = page(null);
await absent.tick(0);
assert.equal(absent.calls, 0);
assert.equal(absent.timers.length, 0);

const p = page();
await p.tick(0);
assert.equal(p.calls, 1);
assert.ok(p.elements.has('session-watch-notice'));
await p.tick(5000);
assert.equal(p.calls, 1);
await p.tick(10000);
assert.equal(p.calls, 2);
await p.tick(15000);
assert.equal(p.calls, 2);
p.mode = 'ok';
await p.tick(30000);
assert.equal(p.calls, 3);
assert.equal(p.elements.has('session-watch-notice'), false);
await p.tick(35000);
assert.equal(p.calls, 4);
p.mode = 'pending';
await p.tick(40000);
await p.tick(45000);
assert.equal(p.calls, 5);
p.settle();
await new Promise(resolve => setImmediate(resolve));
await p.tick(50000);
assert.equal(p.calls, 6);
console.log('notice-poll: 12 assertions passed (missing route, backoff, recovery, no overlap)');
