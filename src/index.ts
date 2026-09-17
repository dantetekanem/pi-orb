import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { readFileSync } from 'node:fs';
import { post } from './client.ts';
import { senderContext } from './herdr.ts';
import { VoiceSession } from './voice-session.ts';

const say = Type.Object({ text: Type.String({ minLength: 1, maxLength: 2000 }) });
const ask = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 2000 }),
  answers: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 64 }), label: Type.String({ minLength: 1, maxLength: 80 }),
    summary: Type.Optional(Type.String({ maxLength: 200 })), detail: Type.Optional(Type.String({ maxLength: 2000 })),
  }), { minItems: 2, maxItems: 6 }),
  default_answer_id: Type.String({ minLength: 1, maxLength: 64 }),
  timeout_seconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 60 })),
});
export type OrbSayInput = Static<typeof say>;
export type OrbAskInput = Static<typeof ask>;
const guidelines = (name: string) => readFileSync(new URL(`../prompt/${name}.md`, import.meta.url), 'utf8').trim().split('\n');
const result = (details: Record<string, string | boolean>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(details) }], details });

export default function orb(pi: ExtensionAPI, send: typeof fetch = fetch, environment = process.env.HERDR_ENV): void {
  const pending = new Set<AbortController>();
  let closed = false;
  let voice: VoiceSession | undefined;
  const invalidate = () => {
    voice?.dispose();
    for (const controller of pending) controller.abort(Error('Orb connector session ended.'));
  };
  pi.on('session_shutdown', () => {
    closed = true;
    invalidate();
  });
  pi.on('session_start', invalidate);
  pi.on('session_tree', invalidate);
  pi.on('input', invalidate);
  const request = async (
    path: '/speak' | '/ask',
    payload: object,
    timeout: number,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ) => {
    if (closed) throw Error('Orb connector session has ended.');
    invalidate();
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const current = new VoiceSession(pi, ctx, send, combined);
    const delivery = Promise.withResolvers<boolean>();
    voice = current;
    pending.add(controller);
    try {
      const context = await senderContext((command, args, options) => pi.exec(command, args, options), combined, environment);
      const realtime = await current.prepare();
      combined.throwIfAborted();
      current.assertCurrent();
      const dispatch: typeof fetch = (url, options) => {
        const dispatched = send(url, options);
        current.start(delivery.promise); // Poll concurrently; /ask waits for a click/default.
        return dispatched;
      };
      const reply = await post(path, {
        ...payload,
        source: 'Pi',
        ...context,
        realtime,
      }, timeout, combined, dispatch);
      combined.throwIfAborted();
      if (!current.originActive()) throw Error('Orb origin changed.');
      if (reply.status < 200 || reply.status >= 300) throw Error('Orb did not accept the request.');
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reply.body.id ?? '')) throw Error('Orb returned an invalid request ID.');
      delivery.resolve(!(reply.body.state === 'suppressed' && reply.body.delivery === 'none'));
      return reply;
    } catch {
      current.dispose();
      throw Error('Orb request failed or was cancelled.');
    } finally {
      delivery.resolve(false);
      pending.delete(controller);
    }
  };
  pi.registerTool({
    name: 'orb_say', label: 'Orb say', description: 'Send a brief message to native Orb. Meeting mode may deliver it silently.',
    promptSnippet: 'Speak a short update through Orb, or show its silent notice.',
    promptGuidelines: guidelines('orb-say'), parameters: say, executionMode: 'sequential',
    async execute(_id, params, signal, _update, ctx) {
      const { status, body } = await request('/speak', { text: params.text }, 5000, signal, ctx);
      const suppressed = body.state === 'suppressed' && body.delivery === 'none';
      if (status !== 202 || !((body.state === 'preparing' && body.delivery === 'voice')
        || (body.state === 'notifying' && body.delivery === 'silent') || suppressed)) {
        voice?.dispose();
        throw Error('Orb did not accept the message.');
      }
      if (suppressed) voice?.dispose();
      return result({ id: body.id, state: body.state, delivery: body.delivery, accepted: true });
    },
  });
  pi.registerTool({
    name: 'orb_ask', label: 'Orb ask', description: 'Ask one question in native Orb with 2–6 choices and a required timeout fallback.',
    promptSnippet: 'Ask through Orb and return a clicked choice or the supplied timeout fallback.',
    promptGuidelines: guidelines('orb-ask'), parameters: ask, executionMode: 'sequential',
    async execute(_id, params, signal, _update, ctx) {
      const timeout = params.timeout_seconds ?? 30, fallback = params.default_answer_id.trim();
      const ids = params.answers.map(answer => answer.id.trim());
      if (!fallback || !ids.includes(fallback) || new Set(ids).size !== ids.length) throw Error('Supply unique answer IDs and a matching default_answer_id.');
      if (!Number.isInteger(timeout) || timeout < 10 || timeout > 60) throw Error('Orb timeout_seconds must be 10–60.');
      const { status, body } = await request('/ask', {
        question: params.question, default_answer_id: fallback, timeout_seconds: timeout,
        answers: params.answers.map(({ id, label, summary, detail }) => ({ id, label, summary, detail })),
      }, timeout * 1000 + 5000, signal, ctx);
      if (status !== 200 || body.state !== 'answered' || !ids.includes(body.answer_id)
        || (body.reason !== undefined && body.reason !== 'timeout')
        || (body.reason === 'timeout' && body.answer_id !== fallback)) {
        voice?.dispose();
        throw Error('Orb returned no valid answer.');
      }
      return result({ id: body.id, state: body.state, answer_id: body.answer_id,
        ...(body.reason ? { reason: body.reason } : {}), answered_by: body.reason === 'timeout' ? 'timeout' : 'user' });
    },
  });
}
