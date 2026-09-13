import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load.mjs';
const { post } = await load('../src/client.ts');

test('sends one numeric-loopback JSON request and preserves the held reply', async () => {
  let calls = 0;
  const body = { id: 'question', state: 'answered', answer_id: 'no', reason: 'timeout' };
  const reply = await post('/ask', { question: 'Olá' }, 1000, undefined, async (url, options) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:45821/ask');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    assert.equal(Number(options.headers['Content-Length']), Buffer.byteLength(options.body));
    assert.deepEqual(JSON.parse(options.body), { question: 'Olá' });
    return Response.json(body);
  });
  assert.deepEqual(reply, { status: 200, body });
  assert.equal(calls, 1);
});

test('rejects oversized requests before sending and bounded malformed replies', async () => {
  let calls = 0;
  await assert.rejects(post('/speak', { text: '界'.repeat(6000) }, 1000, undefined, async () => { calls++; }), /16384/);
  assert.equal(calls, 0);
  for (const response of [new Response('x'.repeat(8193)), new Response('not JSON'), Response.json([]), Response.json({ id: 1 })]) {
    await assert.rejects(post('/ask', {}, 1000, undefined, async () => response));
  }
});

test('cancellation and deadline abort the owned request without retry or default', async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    let calls = 0, requestSignal;
    const pending = post('/ask', {}, cancel ? 1000 : 5, controller.signal, async (_url, { signal }) => {
      calls++; requestSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    if (cancel) controller.abort();
    await assert.rejects(pending);
    assert.equal(calls, 1);
    assert.equal(requestSignal.aborted, true);
  }
  const aborted = AbortSignal.abort();
  await assert.rejects(post('/speak', {}, 1000, aborted, () => assert.fail('must not send')));
});

test('keeps HTTP cancellation distinct from an answer', async () => {
  const body = { state: 'cancelled', reason: 'replaced' };
  assert.deepEqual(await post('/ask', {}, 1000, undefined, async () => Response.json(body, { status: 409 })), { status: 409, body });
});
