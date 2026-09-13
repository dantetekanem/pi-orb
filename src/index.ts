import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { readFileSync } from 'node:fs';
import { post } from './client.ts';
import { senderContext } from './herdr.ts';

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
  pi.on('session_shutdown', () => {
    closed = true;
    for (const controller of pending) controller.abort(Error('Orb connector session ended.'));
  });
  const request = async (path: '/speak' | '/ask', payload: object, timeout: number, signal?: AbortSignal) => {
    if (closed) throw Error('Orb connector session has ended.');
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    pending.add(controller);
    try {
      const context = await senderContext((command, args, options) => pi.exec(command, args, options), combined, environment);
      const reply = await post(path, { ...payload, source: 'Pi', ...context }, timeout, combined, send);
      if (reply.status < 200 || reply.status >= 300) throw Error(`Orb HTTP ${reply.status}: ${JSON.stringify(reply.body)}`);
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reply.body.id ?? '')) throw Error('Orb returned an invalid request ID.');
      return reply;
    } finally { pending.delete(controller); }
  };
  pi.registerTool({
    name: 'orb_say', label: 'Orb say', description: 'Send a brief message to native Orb. Meeting mode may deliver it silently.',
    promptSnippet: 'Speak a short update through Orb, or show its silent notice.',
    promptGuidelines: guidelines('orb-say'), parameters: say, executionMode: 'sequential',
    async execute(_id, params, signal) {
      const { status, body } = await request('/speak', { text: params.text }, 5000, signal);
      if (status !== 202 || !((body.state === 'preparing' && body.delivery === 'voice')
        || (body.state === 'notifying' && body.delivery === 'silent'))) throw Error('Orb did not accept the message.');
      return result({ ...body, accepted: true });
    },
  });
  pi.registerTool({
    name: 'orb_ask', label: 'Orb ask', description: 'Ask one question in native Orb with 2–6 choices and a required timeout fallback.',
    promptSnippet: 'Ask through Orb and return a clicked choice or the supplied timeout fallback.',
    promptGuidelines: guidelines('orb-ask'), parameters: ask, executionMode: 'sequential',
    async execute(_id, params, signal) {
      const timeout = params.timeout_seconds ?? 30, fallback = params.default_answer_id.trim();
      const ids = params.answers.map(answer => answer.id.trim());
      if (!fallback || !ids.includes(fallback) || new Set(ids).size !== ids.length) throw Error('Supply unique answer IDs and a matching default_answer_id.');
      if (!Number.isInteger(timeout) || timeout < 10 || timeout > 60) throw Error('Orb timeout_seconds must be 10–60.');
      const { status, body } = await request('/ask', {
        question: params.question, default_answer_id: fallback, timeout_seconds: timeout,
        answers: params.answers.map(({ id, label, summary, detail }) => ({ id, label, summary, detail })),
      }, timeout * 1000 + 5000, signal);
      if (status !== 200 || body.state !== 'answered' || !ids.includes(body.answer_id)
        || (body.reason !== undefined && body.reason !== 'timeout')
        || (body.reason === 'timeout' && body.answer_id !== fallback)) throw Error('Orb returned no valid answer.');
      return result({ ...body, answered_by: body.reason === 'timeout' ? 'timeout' : 'user' });
    },
  });
}
