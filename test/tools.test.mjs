import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load.mjs';
const { default: orb } = await load('../src/index.ts');
const { Check } = await load('typebox/value');
const id = '00000000-0000-4000-8000-000000000001';
const question = { question: 'Continue?', answers: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], default_answer_id: 'no' };
function fixture(send, exec = () => assert.fail('no Herdr call'), env = '') {
  const tools = new Map(), events = new Map();
  orb({ registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => events.set(name, handler), exec }, send, env);
  return { tools, events, call: (name, params, signal) => tools.get(name).execute('call', params, signal) };
}

test('registers two sequential tools and returns accepted delivery rather than completed speech', async () => {
  let sends = 0;
  const f = fixture(async (url, options) => {
    sends++;
    assert.equal(url, 'http://127.0.0.1:45821/speak');
    assert.deepEqual(JSON.parse(options.body), { text: 'Ready', source: 'Pi' });
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
