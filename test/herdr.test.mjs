import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load.mjs';
const { senderContext } = await load('../src/herdr.ts');
const pane = { workspace_id: 'w1', tab_id: 'w1:tE', pane_id: 'w1:p45' };
const tab = { workspace_id: 'w1', tab_id: 'w1:tE', number: 14, pane_count: 2 };
const layout = { workspace_id: 'w1', tab_id: 'w1:tE', zoomed: false, panes: [
  { pane_id: 'w1:p48', rect: { x: 109, y: 0 } }, { pane_id: 'w1:p45', rect: { x: 4, y: 0 } },
] };
function runner(change = value => value) {
  return async (command, args, options) => {
    assert.equal(command, 'herdr'); assert.equal(options.timeout, 1000);
    const key = args[0] === 'tab' ? 'tab' : args[1] === 'current' ? 'pane' : 'layout';
    assert.deepEqual(args, key === 'tab' ? ['tab', 'get', pane.tab_id] : key === 'pane' ? ['pane', 'current', '--current'] : ['pane', 'layout', '--pane', pane.pane_id]);
    const result = structuredClone({ [key]: { pane, tab, layout }[key] });
    return { code: 0, killed: false, stdout: JSON.stringify({ result: change(result) }) };
  };
}

test('uses API tab number and visual pane order rather than opaque ID or focused pane', async () => {
  assert.deepEqual(await senderContext(runner(), undefined, '1'), { title: 'Herdr 14:1', source_context: { kind: 'herdr', ...pane } });
  const moved = runner(value => { if (value.layout) value.layout.panes[1].rect.y = 10; return value; });
  assert.equal((await senderContext(moved, undefined, '1')).title, 'Herdr 14:2');
});

test('omits unavailable, stale, ambiguous, zoomed and invalid context', async () => {
  assert.deepEqual(await senderContext(() => assert.fail('outside Herdr'), undefined, ''), {});
  for (const change of [
    value => { if (value.tab) value.tab.number = 0; return value; },
    value => { if (value.layout) value.layout.tab_id = 'w1:t9'; return value; },
    value => { if (value.layout) value.layout.panes.pop(); return value; },
    value => { if (value.layout) value.layout.panes[0] = value.layout.panes[1]; return value; },
    value => { if (value.layout) value.layout.zoomed = true; return value; },
    value => { if (value.pane) value.pane.workspace_id = '--help'; return value; },
  ]) assert.deepEqual(await senderContext(runner(change), undefined, '1'), {});
  assert.deepEqual(await senderContext(async () => ({ code: 1, stdout: '' }), undefined, '1'), {});
  assert.deepEqual(await senderContext(async () => ({ code: 0, stdout: '{' }), undefined, '1'), {});
});

test('aborted lookup cannot be treated as an ordinary missing title', async () => {
  const controller = new AbortController();
  await assert.rejects(senderContext(async () => { controller.abort(); throw Error('aborted'); }, controller.signal, '1'));
});
