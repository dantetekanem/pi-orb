import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

type Sender = { title?: string; source_context?: { kind: 'herdr'; workspace_id: string; tab_id: string; pane_id: string } };
const id = (value: unknown, max = 64): value is string => typeof value === 'string'
  && value.length <= max && /^[A-Za-z0-9_][A-Za-z0-9_:-]*$/.test(value);
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid Herdr object');
  return value as Record<string, unknown>;
}

export async function senderContext(exec: ExtensionAPI['exec'], signal?: AbortSignal,
                                    environment = process.env.HERDR_ENV): Promise<Sender> {
  signal?.throwIfAborted();
  if (environment !== '1') return {};
  const read = async (args: string[], key: string) => {
    const reply = await exec('herdr', args, { signal, timeout: 1000 });
    signal?.throwIfAborted();
    if (reply.code !== 0 || reply.killed || Buffer.byteLength(reply.stdout) > 65536) throw Error('Herdr unavailable');
    return record(record(record(JSON.parse(reply.stdout)).result)[key]);
  };
  try {
    const pane = await read(['pane', 'current', '--current'], 'pane');
    const { workspace_id, tab_id, pane_id } = pane;
    if (!id(workspace_id, 32) || !id(tab_id) || !id(pane_id)
      || !tab_id.startsWith(`${workspace_id}:t`) || !pane_id.startsWith(`${workspace_id}:p`)) return {};
    const [tab, layout] = await Promise.all([
      read(['tab', 'get', tab_id], 'tab'), read(['pane', 'layout', '--pane', pane_id], 'layout'),
    ]);
    if (tab.workspace_id !== workspace_id || layout.workspace_id !== workspace_id
      || tab.tab_id !== tab_id || layout.tab_id !== tab_id || layout.zoomed !== false
      || typeof tab.number !== 'number' || !Number.isSafeInteger(tab.number) || tab.number < 1
      || !Array.isArray(layout.panes) || layout.panes.length < 1 || layout.panes.length > 128
      || tab.pane_count !== layout.panes.length) return {};
    const panes = layout.panes.map(value => {
      const item = record(value), rect = record(item.rect);
      if (!id(item.pane_id) || !item.pane_id.startsWith(`${workspace_id}:p`)
        || typeof rect.x !== 'number' || typeof rect.y !== 'number'
        || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || rect.x < 0 || rect.y < 0) throw Error('Invalid pane layout');
      return { id: item.pane_id, x: rect.x, y: rect.y };
    });
    if (new Set(panes.map(item => item.id)).size !== panes.length
      || new Set(panes.map(item => `${item.x}:${item.y}`)).size !== panes.length) return {};
    panes.sort((a, b) => a.y - b.y || a.x - b.x);
    const position = panes.findIndex(item => item.id === pane_id) + 1;
    const title = `Herdr ${tab.number}:${position}`;
    if (!position || title.length > 24) return {};
    return { title, source_context: { kind: 'herdr', workspace_id, tab_id, pane_id } };
  } catch {
    signal?.throwIfAborted();
    return {}; // Missing context must not invent a location or prevent an ordinary message.
  }
}
