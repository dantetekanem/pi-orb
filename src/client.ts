export type OrbReply = { status: number; body: Record<string, string> };

export async function post(path: '/speak' | '/ask', payload: object, timeoutMs: number,
                           signal?: AbortSignal, send: typeof fetch = fetch): Promise<OrbReply> {
  signal?.throwIfAborted();
  const body = JSON.stringify(payload), size = Buffer.byteLength(body);
  if (size > 16384) throw Error('Orb request exceeds 16384 UTF-8 bytes.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(Error('Orb deadline exceeded; no answer received.')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await send(`http://127.0.0.1:45821${path}`, {
      method: 'POST', redirect: 'error', signal: combined, body,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(size) },
    });
    reader = response.body?.getReader();
    if (!reader) throw Error('Orb returned an empty response.');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) throw Error('Orb response exceeds 8192 bytes.');
      chunks.push(value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isStringRecord(result)) throw Error('Orb returned an invalid response.');
    return { status: response.status, body: result };
  } finally {
    clearTimeout(timeout);
    controller.abort();
    reader?.releaseLock();
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === 'string');
}
