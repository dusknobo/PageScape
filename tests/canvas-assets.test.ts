import test from 'node:test';
import assert from 'node:assert/strict';
import { CANVAS_ASSET_ATTR_PREFIX, collectCanvasAssetPaths, verifyCanvasAssetAttributes, withCanvasAssetAttributes } from '../src/canvas/assets';
import type { CanvasNode, CanvasScene } from '../src/canvas/types';

const base = { x: 0, y: 0, width: 200, height: 120, color: 'neutral' as const };
const file = (value: string, unresolved = false): CanvasNode => ({ ...base, id: value, kind: 'file', file: value, unresolved });
const text = (value: string): CanvasNode => ({ ...base, id: 'note', kind: 'text', text: value });
const scene = (nodes: CanvasNode[]): CanvasScene => ({ version: 1, id: 'test', title: 'Asset registration', revision: null, updatedAt: 1, nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 } });

test('file, group and Markdown refs share one sorted native asset registration', () => {
  const board = scene([file('/assets/z raw space.png'), file('assets/a.png'),
    { ...base, id: 'group', kind: 'group', title: 'Group', background: 'assets/a.png' },
    text('![same](assets/a.png) [download](<assets/z raw space.png>)')]);
  assert.deepEqual(collectCanvasAssetPaths(board), ['assets/a.png', 'assets/z raw space.png']);
  assert.deepEqual(withCanvasAssetAttributes(board), {
    [CANVAS_ASSET_ATTR_PREFIX + '0']: 'assets/a.png', [CANVAS_ASSET_ATTR_PREFIX + '1']: 'assets/z raw space.png',
  });
});

test('resolved attachments exclude remote URLs, unresolved vault files and OS paths', () => {
  assert.deepEqual(collectCanvasAssetPaths(scene([
    file('https://example.com/assets/a.png'), file('assets/unresolved.png', true), file('../assets/a.png', true),
    file('C:/assets/a.png'), file('file:///assets/a.png'), file('//server/assets/a.png'), file('notes/a.png'),
  ])), []);
});

test('unsafe Markdown destinations are ignored without changing or rejecting note content', () => {
  const original = '[a](assets/../private) [b](assets/%2e%2e/private) [c](assets/%252e%252e/private)\n' +
    '[d](assets/foo%2f..%2fprivate) [e](assets/%5cprivate) [f](assets/foo%00.png)\n' +
    '[g](https://example.com/assets/x.png) [h](assets/a:b.png) [i](assets/%25252525252e%25252525252e/private)';
  const board = scene([text(original)]);
  assert.deepEqual(collectCanvasAssetPaths(board), []);
  assert.equal((board.nodes[0] as { text: string }).text, original);
});

test('Markdown inline assets preserve raw spaces, balanced and escaped parentheses', () => {
  assert.deepEqual(collectCanvasAssetPaths(scene([text(
    '![image](assets/raw space.png "a title") [pdf](assets/file(2).pdf)\n' +
    '![escaped](assets/file\\(3\\).png) [angle](<assets/other raw.png> "caption")',
  )])), ['assets/file(2).pdf', 'assets/file(3).png', 'assets/other raw.png', 'assets/raw space.png']);
});

test('reference definitions and native HTML media attributes register whole safe destinations', () => {
  assert.deepEqual(collectCanvasAssetPaths(scene([text(
    '![reference][pic]\n[pic]: <assets/ref raw.png> "title"\n' +
    '<video src="assets/movie.mp4" poster="assets/poster.png"></video>\n' +
    '<a href="assets/a&amp;b.pdf">pdf</a><img src="https://host/assets/remote.png">',
  )])), ['assets/a&b.pdf', 'assets/movie.mp4', 'assets/poster.png', 'assets/ref raw.png']);
});

test('code examples do not keep otherwise unused local assets alive', () => {
  assert.deepEqual(collectCanvasAssetPaths(scene([text(
    '`![example](assets/inline.png)`\n```md\n![example](assets/fenced.png)\n```\n' +
    '~~~html\n<img src="assets/fenced-html.png">\n~~~\n![real](assets/real.png)',
  )])), ['assets/real.png']);
});

test('asset fragments and query strings register the underlying local file', () => {
  assert.deepEqual(collectCanvasAssetPaths(scene([
    file('assets/document.pdf#page=2'), file('/assets/document.pdf?download=1'), file('assets/raw%20space.png'),
  ])), ['assets/document.pdf', 'assets/raw%20space.png']);
});

test('rebuilding only owned attributes removes stale refs while preserving other plugins and users', () => {
  const existing = { id: '20261017150000-abcdefg', 'custom-user': 'keep', 'custom-data-assets-other-plugin': 'assets/foreign.png',
    [CANVAS_ASSET_ATTR_PREFIX + '0']: 'assets/old.png', [CANVAS_ASSET_ATTR_PREFIX + '71']: 'assets/stale.png' };
  const board = scene([file('assets/new.png')]);
  const attrs = withCanvasAssetAttributes(board, existing);
  assert.deepEqual(attrs, { id: existing.id, 'custom-user': 'keep', 'custom-data-assets-other-plugin': 'assets/foreign.png', [CANVAS_ASSET_ATTR_PREFIX + '0']: 'assets/new.png' });
  assert.equal(existing[CANVAS_ASSET_ATTR_PREFIX + '0'], 'assets/old.png', 'input attrs must remain untouched');
  assert.doesNotThrow(() => verifyCanvasAssetAttributes(board, attrs));
  assert.deepEqual(withCanvasAssetAttributes(scene([]), attrs), { id: existing.id, 'custom-user': 'keep', 'custom-data-assets-other-plugin': 'assets/foreign.png' });
});

test('readback rejects missing, stale and changed owned refs, including empty-scene cleanup', () => {
  const board = scene([file('assets/new.png')]);
  assert.throws(() => verifyCanvasAssetAttributes(board, {}), /登记核对失败/);
  assert.throws(() => verifyCanvasAssetAttributes(board, { [CANVAS_ASSET_ATTR_PREFIX + '0']: 'assets/old.png' }), /登记核对失败/);
  assert.throws(() => verifyCanvasAssetAttributes(board, { ...withCanvasAssetAttributes(board), [CANVAS_ASSET_ATTR_PREFIX + '1']: 'assets/stale.png' }), /登记核对失败/);
  assert.throws(() => verifyCanvasAssetAttributes(scene([]), { [CANVAS_ASSET_ATTR_PREFIX + '3']: 'assets/stale.png' }), /登记核对失败/);
  assert.doesNotThrow(() => verifyCanvasAssetAttributes(scene([]), { 'custom-data-assets-other-plugin': 'assets/foreign.png' }));
});
