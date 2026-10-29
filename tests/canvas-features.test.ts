import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene, normalizeScene } from '../src/canvas/model';
import { appendTemplate, canvasVisibility, layoutTree, reconcileChildren } from '../src/canvas/scene-features';
import { BUILTIN_TEMPLATES } from '../src/canvas/templates';
import { importJsonCanvas, exportJsonCanvas } from '../src/canvas/json-canvas';
import { canvasReferenceMarkdown, parseCanvasReference } from '../src/canvas/embed';
import type { CanvasNode, CanvasScene } from '../src/canvas/types';

const parent = '20261029100000-parent1', child = '20261029100001-child01', second = '20261029100002-child02';
const note = (id: string, x = 0, y = 0): CanvasNode => ({ id, kind: 'text', text: id, x, y, width: 200, height: 150, color: 'blue' });
function scene(): CanvasScene { return { ...createScene('Features'), id: 'features', updatedAt: 1, nodes: [note('a'), note('b', 350)], edges: [{ id: 'edge', from: 'a', to: 'b', label: '关系', color: 'green' }] }; }

test('folded groups preserve expanded geometry, all contents and connections; nested folds use the visible outer group', () => {
  const original = scene();
  original.nodes.push({ id: 'inner', kind: 'group', title: 'Inner', x: -10, y: -10, width: 800, height: 400, color: 'neutral', collapsed: true, groupId: 'outer' },
    { id: 'outer', kind: 'group', title: 'Outer', x: -30, y: -30, width: 1000, height: 600, color: 'neutral', collapsed: true });
  original.nodes[0].groupId = 'inner'; const before = structuredClone(original);
  const visible = canvasVisibility(original);
  assert.equal(visible.representative.get('a')!.id, 'outer'); assert.equal(visible.representative.get('inner')!.id, 'outer');
  assert.equal(visible.nodes.find(node => node.id === 'outer')!.height, 52);
  assert.deepEqual(original, before);
  const outer = original.nodes.find(node => node.id === 'outer')!; if (outer.kind === 'group') outer.collapsed = false;
  assert.equal(canvasVisibility(original).representative.get('a')!.id, 'inner');
});

test('group cycles and orphan associations remain readable without infinite traversal', () => {
  const original = scene(); original.nodes[0].groupId = 'missing';
  original.nodes.push({ id: 'g1', kind: 'group', title: 'G1', x: 0, y: 0, width: 400, height: 300, color: 'neutral', collapsed: true, groupId: 'g2' },
    { id: 'g2', kind: 'group', title: 'G2', x: 0, y: 0, width: 500, height: 400, color: 'neutral', groupId: 'g1' });
  assert.equal(canvasVisibility(original).representative.size, 4);
  assert.equal(normalizeScene(layoutTree(original, new Set(), 'right')).nodes.length, 4);
});

test('connected layout produces ordered levels without changing node identities, content or edges', () => {
  const original = scene(); original.nodes.push(note('c', -100, 600)); original.edges.push({ id: 'bc', from: 'b', to: 'c', label: '', color: 'neutral' });
  const before = structuredClone(original); const right = layoutTree(original, new Set(), 'right');
  assert.ok(right.nodes[0].x < right.nodes[1].x && right.nodes[1].x < right.nodes[2].x);
  const down = layoutTree(original, new Set(), 'down'); assert.ok(down.nodes[0].y < down.nodes[1].y && down.nodes[1].y < down.nodes[2].y);
  assert.deepEqual(right.edges, original.edges); assert.deepEqual(original, before);
  assert.deepEqual(right.nodes.map(node => [node.id, node.kind === 'text' && node.text]), original.nodes.map(node => [node.id, node.kind === 'text' && node.text]));
});

test('tree layout moves a selected group and its descendants by the same delta while leaving unrelated nodes intact', () => {
  const original = scene(); original.nodes[0].groupId = 'group';
  original.nodes.push({ id: 'group', kind: 'group', title: 'Group', x: -30, y: -50, width: 300, height: 250, color: 'neutral' }, note('untouched', 900, 1000));
  const result = layoutTree(original, new Set(['group', 'b']), 'right');
  const group = result.nodes.find(node => node.id === 'group')!, oldGroup = original.nodes.find(node => node.id === 'group')!;
  assert.equal(result.nodes[0].x - original.nodes[0].x, group.x - oldGroup.x);
  assert.equal(result.nodes[0].y - original.nodes[0].y, group.y - oldGroup.y);
  assert.deepEqual(result.nodes.find(node => node.id === 'untouched'), original.nodes.find(node => node.id === 'untouched'));
});

test('cycles and disconnected components have finite tree coordinates and keep every edge', () => {
  const original = scene(); original.nodes.push(note('isolated'));
  original.edges.push({ id: 'cycle', from: 'b', to: 'a', label: '', color: 'neutral' }, { id: 'orphan', from: 'missing', to: 'a', label: '', color: 'neutral' });
  const result = layoutTree(original, new Set(), 'right'); assert.equal(result.nodes.length, 3); assert.deepEqual(result.edges, original.edges);
  assert.ok(result.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
});

test('following children adopts an existing card, keeps geometry and links, and appends only new documents', () => {
  const original = scene(); original.nodes.push({ id: 'doc', kind: 'doc', docId: child, title: 'Old', x: -200, y: 300, width: 330, height: 240, color: 'orange', subpath: '#题目' }); original.followParentId = parent;
  const children = [child, second].map((id, i) => ({ id, title: 'Child ' + i, notebook: '20261029100000-book001', path: '/' + id + '.sy', icon: '', childCount: 0 }));
  const result = reconcileChildren(original, parent, children); const adopted = result.nodes.find(node => node.id === 'doc')!;
  assert.equal(result.nodes.length, original.nodes.length + 1); assert.equal(adopted.x, -200); assert.equal(adopted.y, 300);
  assert.ok(adopted.kind === 'doc' && adopted.followedFrom === parent && adopted.title === 'Child 0' && adopted.subpath === '#题目');
  assert.deepEqual(result.edges, original.edges);
  assert.deepEqual(reconcileChildren(result, parent, children), result, 'repeat refresh is idempotent');
});

test('removed children are marked detached instead of deleted and explicit exclusions are not re-added', () => {
  const original = scene(); original.nodes.push({ id: 'doc', kind: 'doc', docId: child, title: 'Keep', x: 800, y: 0, width: 320, height: 240, color: 'blue', followedFrom: parent });
  original.followExcluded = [second];
  const result = reconcileChildren(original, parent, [{ id: second, title: 'Excluded', notebook: parent, path: '/test.sy', icon: '', childCount: 0 }]);
  assert.equal(result.nodes.length, original.nodes.length);
  assert.ok(result.nodes.some(node => node.kind === 'doc' && node.docId === child && node.detached));
  assert.deepEqual(result.edges, original.edges);
});

test('new metadata survives native and JSON Canvas round trips and rejects malformed persistence', () => {
  const original = scene(); original.followParentId = parent; original.followExcluded = [second];
  original.nodes.push({ id: 'g', kind: 'group', title: 'Folded', x: -20, y: -20, width: 900, height: 600, color: 'green', collapsed: true });
  original.nodes[0].groupId = 'g'; original.nodes.push({ id: 'd', kind: 'doc', docId: child, title: 'Child', x: 1000, y: 0, width: 300, height: 200, color: 'blue', followedFrom: parent, detached: true });
  const roundtrip = importJsonCanvas(JSON.stringify(exportJsonCanvas(original))).scene;
  assert.equal(roundtrip.followParentId, parent); assert.deepEqual(roundtrip.followExcluded, [second]); assert.deepEqual(roundtrip.nodes, original.nodes);
  assert.throws(() => normalizeScene({ ...original, followParentId: '../bad' }));
  assert.throws(() => normalizeScene({ ...original, followExcluded: [false] }));
  assert.throws(() => normalizeScene({ ...original, nodes: [{ ...original.nodes[2], collapsed: 'yes' }] }));
});

test('templates append independent node/edge identities and preserve nested membership without replacing existing content', () => {
  const original = scene(); original.followParentId = parent;
  const template = { id: 'template', name: 'Test', updatedAt: 1, nodes: [
    { id: 'g', kind: 'group' as const, title: 'Group', x: 0, y: 0, width: 700, height: 400, color: 'neutral' as const, collapsed: true },
    { ...note('a', 20, 50), groupId: 'g' },
  ], edges: [{ id: 'edge', from: 'a', to: 'missing', label: 'orphan stays orphan', color: 'neutral' as const }] };
  const applied = appendTemplate(original, template); assert.equal(applied.scene.nodes.length, 4); assert.deepEqual(applied.scene.nodes.slice(0, 2), original.nodes);
  assert.equal(applied.scene.nodes[3].groupId, applied.scene.nodes[2].id); assert.equal(applied.scene.edges[1].from, applied.scene.nodes[3].id);
  assert.ok(!applied.scene.nodes.some(node => node.id === applied.scene.edges[1].to));
  assert.equal(applied.scene.followParentId, parent); assert.ok(applied.ids.every(id => !original.nodes.some(node => node.id === id)));
});

test('all built-in templates are valid scenes and can be applied repeatedly', () => {
  let original = scene();
  for (const template of BUILTIN_TEMPLATES) { original = appendTemplate(original, template).scene; original = appendTemplate(original, template).scene; }
  assert.equal(new Set(original.nodes.map(node => node.id)).size, original.nodes.length);
  assert.equal(new Set(original.edges.map(edge => edge.id)).size, original.edges.length);
});

test('canvas references bind only a valid source document and cannot inject another block or path', () => {
  const markdown = canvasReferenceMarkdown('siyuan-child-cards', parent);
  const body = markdown.split('\n')[1]; assert.equal(parseCanvasReference(body), parent);
  assert.throws(() => parseCanvasReference(JSON.stringify({ format: 'siyuan-child-cards-reference', version: 2, docId: parent })));
  assert.throws(() => canvasReferenceMarkdown('siyuan-child-cards', '../escape\n;;;'));
  assert.throws(() => parseCanvasReference('null'));
});
