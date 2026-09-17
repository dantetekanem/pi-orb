import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load.mjs';
const { default: orb } = await load('../src/index.ts');
const { Check } = await load('typebox/value');
const id = '00000000-0000-4000-8000-000000000001';
const question = { question: 'Continue?', answers: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], default_answer_id: 'no' };
function fixture(send, exec = () => assert.fail('no Herdr call'), env = '', context, peer) {
  const tools = new Map(), events = new Map();
  orb({ registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => events.set(name, handler), exec,
    events: { emit: (_name, payload) => peer && payload.reply(peer) } }, send, env);
  return { tools, events, call: (name, params, signal) => tools.get(name).execute('call', params, signal, undefined, context) };
}

test('registers two sequential tools and returns accepted delivery rather than completed speech', async () => {
  let sends = 0;
  const f = fixture(async (url, options) => {
    sends++;
    assert.equal(url, 'http://127.0.0.1:45821/speak');
    const { realtime, ...payload } = JSON.parse(options.body);
    assert.deepEqual(payload, { text: 'Ready', source: 'Pi' });
    assert.equal(realtime.credential_source, 'orb');
    return Response.json({ id, state: 'notifying', delivery: 'silent' }, { status: 202 });
  });
  assert.equal(sends, 0);
  assert.deepEqual([...f.tools.keys()], ['orb_say', 'orb_ask']);
  for (const tool of f.tools.values()) assert.equal(tool.executionMode, 'sequential');
  const result = await f.call('orb_say', { text: 'Ready' });
  assert.deepEqual(result.details, { id, state: 'notifying', delivery: 'silent', accepted: true });
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  assert.equal(sends, 1);
});

test('native-managed voice carries routing only and never calls OpenAI from Pi', async () => {
  const paths = [];
  let payload;
  const context = { hasUI: true, sessionManager: { getSessionId: () => 'synthetic' }, ui: { notify() {} } };
  const f = fixture(async (url, options) => {
    paths.push(new URL(url).pathname);
    if (url.startsWith('https:')) {
      return Response.json({ value: 'ek_synthetic_legacy', expires_at: Math.floor(Date.now() / 1000) + 600 });
    }
    payload = JSON.parse(options.body);
    return Response.json({ id, state: 'preparing', delivery: 'voice' }, { status: 202 });
  }, undefined, '', context);
  const result = await f.call('orb_say', { text: 'Read this' });
  assert.deepEqual(paths, ['/speak']);
  assert.deepEqual(payload.realtime, {
    binding_id: payload.realtime.binding_id,
    token: payload.realtime.token,
    credential_source: 'orb',
    listen: false,
  });
  assert.match(payload.realtime.binding_id, /^[0-9a-f-]{36}$/);
  assert.match(payload.realtime.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.details, { id, state: 'preparing', delivery: 'voice', accepted: true });
  f.events.get('session_shutdown')();
});

test('display suppression is accepted without replay and closes the return poll', async () => {
  let calls = 0;
  let disposed = 0;
  let pollSignal;
  const context = { hasUI: true, sessionManager: { getSessionId: () => 'synthetic' }, ui: { notify() {} } };
  const peer = {
    isActive: () => true,
    final: () => assert.fail('no insertion'),
    dispose: () => disposed++,
  };
  const f = fixture(async (url, options) => {
    calls++;
    if (url.endsWith('/voice-session')) {
      pollSignal = options.signal;
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(Error('closed')), { once: true });
      });
    }
    return Response.json({ id, state: 'suppressed', delivery: 'none' }, { status: 202 });
  }, undefined, '', context, peer);
  const result = await f.call('orb_say', { text: 'While asleep' });
  assert.deepEqual(result.details, { id, state: 'suppressed', delivery: 'none', accepted: true });
  assert.equal(pollSignal.aborted, true);
  assert.equal(disposed, 1);
  assert.equal(calls, 2);

  const malformed = fixture(async () => Response.json({ id, state: 'suppressed', delivery: 'voice' }, { status: 202 }));
  await assert.rejects(malformed.call('orb_say', { text: 'Invalid combination' }));
});

test('primary suppression and normal binding closure stay quiet without hiding Listen failures', async t => {
  for (const hasPeer of [true, false]) {
    for (const outcome of ['suppressed', 'cancelled', 'delivered', 'closed']) {
      if (outcome === 'closed' && !hasPeer) continue;
      const primary = Promise.withResolvers();
      const poll = Promise.withResolvers();
      const dispatched = Promise.withResolvers();
      const notices = [];
      let disposed = 0;
      const context = {
        hasUI: true,
        sessionManager: { getSessionId: () => 'synthetic' },
        ui: { notify: text => notices.push(text) },
      };
      const peer = {
        isActive: () => true,
        final: () => assert.fail('no insertion'),
        dispose: () => disposed++,
      };
      const f = fixture(async url => {
        if (url.endsWith('/voice-session')) {
          if (outcome === 'closed') return poll.promise;
          return Response.json({ error: 'Transcription unavailable' }, { status: 503 });
        }
        dispatched.resolve();
        return primary.promise;
      }, undefined, '', context, hasPeer ? peer : undefined);
      const pending = outcome === 'cancelled' ? f.call('orb_ask', question) : f.call('orb_say', { text: 'Update' });
      const completion = pending.catch(error => error);
      t.after(async () => {
        f.events.get('session_shutdown')();
        primary.resolve(Response.json({ id, state: 'cancelled' }, { status: 409 }));
        await completion;
      });

      await dispatched.promise;
      await new Promise(resolve => setImmediate(resolve)); // Drain the poll failure before the primary reply.
      assert.deepEqual(notices, []);
      primary.resolve(outcome === 'cancelled'
        ? Response.json({ id, state: 'cancelled', reason: 'display_asleep' }, { status: 409 })
        : Response.json({ id, state: outcome === 'suppressed' ? 'suppressed' : 'notifying',
          delivery: outcome === 'suppressed' ? 'none' : 'silent' }, { status: 202 }));
      const result = await completion;
      poll.resolve(Response.json({ error: 'Voice binding ended' }, { status: 503 }));
      await new Promise(resolve => setImmediate(resolve));

      if (outcome === 'cancelled') assert.equal(result.message, 'Orb request failed or was cancelled.');
      else assert.equal(result.details.accepted, true);
      assert.deepEqual(notices, outcome !== 'delivered' ? [] : [hasPeer
        ? 'Orb Listen is unavailable. Check Orb Settings and start a new interaction.'
        : 'Orb Listen needs an active pi-voice-shortcut editor binding. Voice playback is available.']);
      if (hasPeer) assert.equal(disposed, 1);
    }
  }
});

test('ask returns a real choice or a clearly marked supplied timeout fallback', async () => {
  for (const reason of [undefined, 'timeout']) {
    const f = fixture(async (_url, options) => {
      assert.equal(JSON.parse(options.body).timeout_seconds, 30);
      return Response.json({ id, state: 'answered', answer_id: reason ? 'no' : 'yes', reason });
    });
    const result = await f.call('orb_ask', question);
    assert.equal(result.details.answer_id, reason ? 'no' : 'yes');
    assert.equal(result.details.answered_by, reason ? 'timeout' : 'user');
  }
});

test('schema bounds choices and deadlines, and unknown defaults are rejected before send', async () => {
  const f = fixture(() => assert.fail('invalid ask must not send'));
  const schema = f.tools.get('orb_ask').parameters;
  assert.equal(Check(schema, question), true);
  for (const value of [{ ...question, default_answer_id: undefined }, { ...question, answers: [] },
    ...[9, 61, 10.5].map(timeout_seconds => ({ ...question, timeout_seconds }))]) assert.equal(Check(schema, value), false);
  await assert.rejects(f.call('orb_ask', { ...question, default_answer_id: 'missing' }), /default/i);
});

test('rejects cancellation, failed or malformed replies rather than manufacturing consent', async () => {
  for (const [status, body] of [
    [409, { id, state: 'cancelled', reason: 'replaced' }], [503, { error: 'voice failed' }],
    [200, { id, state: 'answered', answer_id: 'unknown' }],
    [200, { id, state: 'answered', answer_id: 'yes', reason: 'timeout' }],
    [200, { id, state: 'answered', answer_id: 'yes', reason: 'something else' }],
  ]) {
    let calls = 0;
    const f = fixture(async () => { calls++; return Response.json(body, { status }); });
    await assert.rejects(f.call('orb_ask', question)); assert.equal(calls, 1);
  }
});

test('tool cancellation and session shutdown abort only their held connections', async () => {
  for (const shutdown of [false, true]) {
    const controller = new AbortController();
    let started, sends = 0;
    const ready = new Promise(resolve => { started = resolve; });
    const f = fixture(async (_url, { signal }) => {
      sends++; started();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const pending = f.call('orb_ask', question, controller.signal);
    await ready;
    if (shutdown) f.events.get('session_shutdown')(); else controller.abort();
    await assert.rejects(pending); assert.equal(sends, 1);
  }
});

test('transcription inserts while ask is unresolved; only the click resolves its answer', async t => {
  const answered = Promise.withResolvers(), acknowledged = Promise.withResolvers();
  const inserted = [], paths = [];
  let binding, requestSignal, pollSignal;
  const context = { hasUI: true, sessionManager: { getSessionId: () => 'synthetic' }, ui: { notify() {} } };
  const peer = { isActive: () => true, final: text => { inserted.push(text); return true; }, dispose() {} };
  const f = fixture(async (url, options) => {
    paths.push(new URL(url).pathname);
    const body = JSON.parse(options.body);
    if (url.endsWith('/ask')) {
      binding = body.realtime;
      assert.ok(binding);
      requestSignal = options.signal;
      return answered.promise;
    }
    assert.equal(url, 'http://127.0.0.1:45821/voice-session');
    pollSignal = options.signal;
    assert.equal(body.binding_id, binding.binding_id);
    if (body.after_capture_id) {
      acknowledged.resolve();
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
    }
    return Response.json({ state: 'transcribed', binding_id: binding.binding_id, capture_id: id, transcript: 'Keep as draft' });
  }, undefined, '', context, peer);
  t.after(() => {
    answered.resolve(Response.json({ id, state: 'answered', answer_id: 'no' }));
    f.events.get('session_shutdown')();
  });
  let resolved = false;
  const answer = f.call('orb_ask', question).then(value => {
    resolved = true;
    return value;
  });
  await Promise.race([acknowledged.promise, answer.then(() => assert.fail('ask resolved before dictation'))]);
  assert.equal(resolved, false);
  assert.equal(requestSignal.aborted, false);
  assert.deepEqual(inserted, ['Keep as draft']);
  assert.deepEqual(paths, ['/ask', '/voice-session', '/voice-session']);
  assert.equal(binding.credential_source, 'orb');
  answered.resolve(Response.json({ id, state: 'answered', answer_id: 'yes', client_secret: 'do-not-return' }));
  assert.deepEqual((await answer).details, { id, state: 'answered', answer_id: 'yes', answered_by: 'user' });
  f.events.get('session_shutdown')();
  assert.equal(pollSignal.aborted, true);
});

test('lifecycle and tool cancellation invalidate the peer before a late native answer', async () => {
  for (const event of ['session_shutdown', 'session_start', 'session_tree', 'input', 'abort']) {
    const started = Promise.withResolvers();
    const reply = Promise.withResolvers();
    let calls = 0;
    let disposed = 0;
    const context = { hasUI: true, sessionManager: { getSessionId: () => 'synthetic' }, ui: { notify() {} } };
    const peer = { isActive: () => true, final: () => assert.fail('no insert'), dispose: () => disposed++ };
    const f = fixture(async (url, options) => {
      if (url.endsWith('/voice-session')) return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(Error('closed')), { once: true });
      });
      calls++;
      started.resolve();
      return reply.promise;
    }, undefined, '', context, peer);
    const controller = new AbortController();
    const answer = f.call('orb_ask', question, controller.signal);
    const rejected = assert.rejects(answer);
    await started.promise;

    if (event === 'abort') {
      controller.abort();
    } else {
      f.events.get(event)();
    }
    reply.resolve(Response.json({ id, state: 'answered', answer_id: 'yes' }));
    await rejected;
    assert.equal(calls, 1);
    assert.equal(disposed, 1);
  }
});

test('failed native dispatch closes its concurrent poll and never returns raw response details', async () => {
  const dispatch = Promise.withResolvers(), polling = Promise.withResolvers();
  let sends = 0, pollSignal;
  const context = { hasUI: true, sessionManager: { getSessionId: () => 'synthetic' }, ui: { notify() {} } };
  const peer = { isActive: () => true, final: () => assert.fail('no insertion'), dispose() {} };
  const f = fixture(async (url, options) => {
    if (url.endsWith('/ask')) {
      sends++;
      return dispatch.promise;
    }
    pollSignal = options.signal;
    polling.resolve();
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('fake-sensitive-error')), { once: true }));
  }, undefined, '', context, peer);
  const answer = f.call('orb_ask', question);
  const rejected = assert.rejects(answer, { message: 'Orb request failed or was cancelled.' });
  await polling.promise;
  dispatch.resolve(Response.json({ error: 'fake-sensitive-error' }, { status: 503 }));
  await rejected;
  assert.equal(pollSignal.aborted, true);
  assert.equal(sends, 1);
});

test('a switched live context rejects a late native answer instead of returning it to another session', async () => {
  const ready = Promise.withResolvers(), dispatch = Promise.withResolvers();
  const context = { hasUI: true, sessionManager: { getSessionId: () => 'synthetic' }, ui: { notify() {} } };
  const f = fixture(async url => {
    ready.resolve();
    return dispatch.promise;
  }, undefined, '', context);
  const answer = f.call('orb_ask', question), rejected = assert.rejects(answer);
  await ready.promise;
  context.sessionManager = { getSessionId: () => 'replacement' };
  dispatch.resolve(Response.json({ id, state: 'answered', answer_id: 'yes' }));
  await rejected;
});

test('rejected native request sizing cannot start a return poll before dispatch', async () => {
  let nativeRequests = 0;
  const context = { hasUI: true, sessionManager: { getSessionId: () => 'synthetic' }, ui: { notify() {} } };
  const peer = { isActive: () => true, final: () => assert.fail('no insert'), dispose() {} };
  const f = fixture(async url => {
    nativeRequests++;
    return Response.json({ error: 'not dispatched' }, { status: 410 });
  }, undefined, '', context, peer);
  await assert.rejects(f.call('orb_ask', { ...question,
    answers: Array.from({ length: 6 }, (_, i) => ({ id: i ? `choice${i}` : 'no', label: 'Choice', detail: '語'.repeat(2000) })) }));
  assert.equal(nativeRequests, 0);
});

test('resolves the sending Herdr location afresh for each call', async () => {
  let number = 14;
  const pane = { workspace_id: 'w1', tab_id: 'w1:tE', pane_id: 'w1:p45' }, sent = [];
  const exec = async (_cmd, args) => ({ code: 0, stdout: JSON.stringify({ result:
    args[0] === 'tab' ? { tab: { ...pane, number, pane_count: 1 } } : args[1] === 'current' ? { pane }
      : { layout: { ...pane, zoomed: false, panes: [{ pane_id: pane.pane_id, rect: { x: 0, y: 0 } }] } } }) });
  const f = fixture(async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ id, state: 'preparing', delivery: 'voice' }, { status: 202 });
  }, exec, '1');
  await f.call('orb_say', { text: 'First' }); number = 15;
  await f.call('orb_say', { text: 'Second' });
  assert.deepEqual(sent.map(body => body.title), ['Herdr 14:1', 'Herdr 15:1']);
  assert.deepEqual(sent[1].source_context, { kind: 'herdr', ...pane });
});
