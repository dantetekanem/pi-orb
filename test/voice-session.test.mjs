import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load.mjs';

const { VoiceSession } = await load('../src/voice-session.ts');
const capture = '00000000-0000-4000-8000-00000000abcd';
const deferred = () => Promise.withResolvers();

function fixture(send, { final = () => true, peer = true } = {}) {
  const notices = [], inserted = [];
  let active = true, disposals = 0;
  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => 'synthetic-session' },
    ui: { notify: text => notices.push(text) },
  };
  const port = {
    isActive: () => active,
    final: text => { inserted.push(text); return final(text); },
    dispose: () => { disposals++; active = false; },
  };
  const pi = { events: { emit: (name, payload) => {
    assert.equal(name, 'pi-voice-shortcut:bind-orb-transcript');
    assert.equal(payload.version, 1);
    assert.equal(payload.context, ctx);
    if (peer) payload.reply(port);
  } } };
  const session = new VoiceSession(pi, ctx, send);
  return { session, ctx, inserted, notices, invalidate: () => { active = false; }, disposals: () => disposals };
}

test('native uppercase UUID replies insert and acknowledge a capture once across case variants', async () => {
  const done = deferred();
  let calls = 0, binding;
  const f = fixture(async (_url, options) => {
    const body = JSON.parse(options.body);
    calls++;
    assert.equal(body.binding_id, binding.binding_id);
    assert.equal(body.token, binding.token);
    if (calls > 1) assert.equal(body.after_capture_id, capture);
    if (calls === 3) {
      done.resolve();
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('closed')), { once: true }));
    }
    return Response.json({
      state: 'transcribed', binding_id: body.binding_id.toUpperCase(),
      capture_id: calls === 1 ? capture.toUpperCase() : capture, transcript: 'Add this draft',
    });
  });
  const dispose = f.session.dispose.bind(f.session);
  f.session.dispose = () => { dispose(); done.resolve(); };
  binding = await f.session.prepare();
  assert.match(binding.token, /^[a-f0-9]{64}$/);
  assert.equal(binding.listen, true);

  f.session.start();
  await done.promise;
  assert.deepEqual(f.inserted, ['Add this draft']);
  f.session.dispose();
  assert.equal(f.disposals(), 1);
});

test('stale origin and failed insertion stop without acknowledgment or raw background errors', async () => {
  for (const failure of ['inactive', 'ui', 'session', 'insert', 'oversize', 'binding', 'error']) {
    const response = deferred(), started = deferred(), disposed = deferred();
    let calls = 0;
    const f = fixture(async (_url, options) => {
      calls++;
      started.resolve(JSON.parse(options.body));
      return response.promise;
    }, { final: () => false });
    await f.session.prepare();
    const originalDispose = f.session.dispose.bind(f.session);
    f.session.dispose = () => { originalDispose(); disposed.resolve(); };

    f.session.start();
    const request = await started.promise;
    if (failure === 'inactive') f.invalidate();
    if (failure === 'ui') f.ctx.ui = { notify: () => assert.fail('replacement UI') };
    if (failure === 'session') f.ctx.sessionManager = { getSessionId: () => 'replacement' };
    if (failure === 'error') response.reject(Error('fake-sensitive-error'));
    else response.resolve(Response.json({
      state: 'transcribed',
      binding_id: failure === 'binding' ? capture : request.binding_id,
      capture_id: capture,
      transcript: failure === 'oversize' ? 'x'.repeat(4001) : 'Draft',
    }));
    await disposed.promise;

    assert.equal(calls, 1);
    assert.deepEqual(f.inserted, failure === 'insert' ? ['Draft'] : []);
    assert.ok(f.notices.every(text => !text.includes('fake-sensitive-error')));
  }
});

test('native-managed playback works without an editor peer while Listen stays disabled', async () => {
  const f = fixture(() => assert.fail('no polling'), { peer: false });
  const binding = await f.session.prepare();
  assert.equal(binding.credential_source, 'orb');
  assert.equal(binding.listen, false);
  f.session.start();
  f.session.dispose();
});

test('voice poll accepts a 4000-code-unit transcript above 8 KiB, but rejects envelopes above 16 KiB', async () => {
  for (const oversize of [false, true]) {
    const done = deferred();
    let calls = 0;
    const f = fixture(async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      if (calls > 1) {
        done.resolve();
        return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('closed')), { once: true }));
      }
      return Response.json({
        state: 'transcribed', binding_id: body.binding_id, capture_id: capture,
        transcript: oversize ? '\u0001'.repeat(4000) : '語'.repeat(4000),
      });
    });
    const dispose = f.session.dispose.bind(f.session);
    f.session.dispose = () => { dispose(); done.resolve(); };
    await f.session.prepare();
    f.session.start();
    await done.promise;
    f.session.dispose();

    assert.equal(f.inserted.length, oversize ? 0 : 1);
    assert.equal(calls, oversize ? 1 : 2);
  }
});

test('only the initial readiness race permits two bounded 410 retries; accepted 410 is terminal', async () => {
  for (const accepts of [false, true]) {
    const sent = [], done = deferred();
    const f = fixture(async (_url, options) => {
      const body = JSON.parse(options.body);
      sent.push(body);
      if (accepts && sent.length === 2) return Response.json({ state: 'waiting', binding_id: body.binding_id });
      return Response.json({ error: 'unavailable' }, { status: 410 });
    });
    const dispose = f.session.dispose.bind(f.session);
    f.session.dispose = () => { dispose(); done.resolve(); };
    await f.session.prepare();
    f.session.start();
    await done.promise;
    assert.equal(sent.length, 3);
  }
});

test('cancelling initial readiness retry prevents all later polls', async () => {
  const sent = deferred(), ended = deferred();
  let calls = 0, disposals = 0;
  const f = fixture(async () => {
    calls++;
    sent.resolve();
    return Response.json({ error: 'unavailable' }, { status: 410 });
  });
  const dispose = f.session.dispose.bind(f.session);
  f.session.dispose = () => {
    dispose();
    if (++disposals === 2) ended.resolve();
  };
  await f.session.prepare();
  f.session.start();
  await sent.promise;
  await new Promise(resolve => setImmediate(resolve));
  f.session.dispose();
  await ended.promise;
  assert.equal(calls, 1);
});
