import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { post } from './client.ts';

type TranscriptPort = { isActive(): boolean; final(text: string): boolean; dispose(): void };
type Binding = {
  binding_id: string;
  token: string;
  credential_source: 'orb';
  listen: boolean;
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export class VoiceSession {
  private readonly controller = new AbortController();
  private port?: TranscriptPort;
  private binding?: Binding;
  private readonly ui;
  private readonly manager;
  private readonly sessionId;
  private started = false;
  private monitor?: ReturnType<typeof setInterval>;
  private removeAbort?: () => void;

  constructor(
    pi: ExtensionAPI,
    private readonly context: ExtensionContext | undefined,
    private readonly send: typeof fetch,
    signal?: AbortSignal,
  ) {
    this.ui = context?.ui;
    this.manager = context?.sessionManager;
    this.sessionId = this.manager?.getSessionId();
    if (context?.hasUI) {
      let accepting = true;
      let owners = 0;
      pi.events.emit('pi-voice-shortcut:bind-orb-transcript', {
        version: 1,
        context,
        reply: (port: TranscriptPort) => {
          if (!accepting || ++owners > 1) {
            port.dispose();
            this.releasePort();
            return;
          }
          if (typeof port?.isActive === 'function'
            && typeof port.final === 'function'
            && typeof port.dispose === 'function') this.port = port;
        },
      });
      accepting = false;
      if (this.port && !this.port.isActive()) this.releasePort();
    }

    const abort = () => this.dispose();
    signal?.addEventListener('abort', abort, { once: true });
    this.removeAbort = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) this.dispose();
  }

  originActive(): boolean {
    try {
      return this.context?.ui === this.ui
        && this.context?.sessionManager === this.manager
        && this.manager?.getSessionId() === this.sessionId;
    } catch {
      return false;
    }
  }

  assertCurrent(): void {
    if (this.controller.signal.aborted || !this.originActive() || (this.port && !this.port.isActive())) {
      this.dispose();
      throw Error('Orb voice binding is no longer active.');
    }
  }

  private async notice(text: string, delivery: Promise<boolean>): Promise<void> {
    if (await delivery && !this.controller.signal.aborted && this.originActive() && this.context?.hasUI) {
      this.ui?.notify(text, 'warning');
    }
  }

  private releasePort(): void {
    const port = this.port;
    this.port = undefined;
    port?.dispose();
  }

  async prepare(): Promise<Binding> {
    this.assertCurrent();
    this.binding = {
      credential_source: 'orb',
      binding_id: randomUUID(),
      token: randomBytes(32).toString('hex'),
      listen: !!this.port,
    };
    return this.binding;
  }

  start(delivery: Promise<boolean> = Promise.resolve(true)): void {
    if (this.started || !this.binding || this.controller.signal.aborted) return;
    this.started = true;
    if (!this.binding.listen) {
      void this.notice('Orb Listen needs an active pi-voice-shortcut editor binding. Voice playback is available.', delivery);
      return;
    }
    this.monitor = setInterval(() => {
      try {
        this.assertCurrent();
      } catch {
        // Closing the poll disables native listening.
      }
    }, 250);
    this.monitor.unref();
    void this.poll().catch(() =>
      this.notice('Orb Listen is unavailable. Check Orb Settings and start a new interaction.', delivery)
    ).finally(() => this.dispose());
  }

  private async poll(): Promise<void> {
    const binding = this.binding;
    if (!binding) return;
    let accepted = false;
    let retries = 0;
    let afterCapture: string | undefined;
    const delivered = new Set<string>();
    while (true) {
      this.assertCurrent();
      const { status, body } = await post('/voice-session', {
        binding_id: binding.binding_id,
        token: binding.token,
        after_capture_id: afterCapture,
      }, 25000, this.controller.signal, this.send);
      this.assertCurrent();

      if (status === 503 && body.error === 'Voice binding ended') return;
      if (status === 410 && !accepted && retries++ < 2) {
        await delay(100, undefined, { signal: this.controller.signal });
        continue;
      }
      if (status !== 200 || body.binding_id?.toLowerCase() !== binding.binding_id) throw Error('Binding unavailable.');
      if (body.state !== 'waiting' && body.state !== 'transcribed') throw Error('Invalid voice response.');
      accepted = true;
      if (body.state === 'waiting') continue;

      if (!uuid.test(body.capture_id ?? '') || !body.transcript?.trim() || body.transcript.length > 4000) {
        throw Error('Invalid transcript.');
      }
      const captureId = body.capture_id.toLowerCase();
      if (!delivered.has(captureId)) {
        if (delivered.size >= 256 || !this.port?.final(body.transcript)) throw Error('Editor unavailable.');
        delivered.add(captureId);
      }
      afterCapture = captureId;
    }
  }

  dispose(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    clearInterval(this.monitor);
    this.releasePort();
    this.removeAbort?.();
  }
}
