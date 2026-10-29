import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeNodes, bounds, curve, nearestSide, portPoint, snapDelta, updateGroupMembership } from '../src/canvas/view-geometry';
import type { CanvasNode, CanvasScene, CanvasSettings } from '../src/canvas/types';

function node(id: string, x: number, y = 0, width = 24, height = 24): CanvasNode {
  return { id, kind: 'text', text: id, x, y, width, height, color: 'neutral' };
}
function scene(nodes: CanvasNode[], settings: CanvasSettings = {}, zoom = 1): CanvasScene {
  return { version: 1, id: 'geometry-test', title: 'Geometry', revision: null, updatedAt: 1, nodes, edges: [], viewport: { x: 0, y: 0, zoom }, settings };
}

test('snap can be disabled without altering the drag vector', () => {
  const origin = node('moving', 5, -7);
  assert.deepEqual(snapDelta(scene([origin, node('other', 27)], { snapToGrid: false, snapToObjects: false }), new Set(['moving']), origin, 15.5, -20.25), { x: 15.5, y: -20.25 });
});

test('grid snap anchors the origin consistently across negative coordinates', () => {
  const origin = node('moving', 5, -7);
  assert.deepEqual(snapDelta(scene([origin], { snapToGrid: true, snapToObjects: false }), new Set(['moving']), origin, 15, -20), { x: 19, y: -17 });
});

test('object snap composes with an existing grid correction on x', () => {
  const origin = node('moving', 5, 0);
  const result = snapDelta(scene([origin, node('other', 29, 1000)], { snapToGrid: true }), new Set(['moving']), origin, 15, 0);
  assert.equal(origin.x + result.x, 29, 'moving left edge must meet the object left edge');
});

test('object snap composes with an existing grid correction on y', () => {
  const origin = node('moving', 0, 5);
  const result = snapDelta(scene([origin, node('other', 1000, 29)], { snapToGrid: true }), new Set(['moving']), origin, 0, 15);
  assert.equal(origin.y + result.y, 29);
});

test('a closer candidate replaces a previous snap without accumulating corrections', () => {
  const origin = node('moving', 5, 0);
  const other1 = node('far', 29, 1000); const other2 = node('near', 27, 1000);
  const run = (others: CanvasNode[]) => snapDelta(scene([origin, ...others], { snapToGrid: true }), new Set(['moving']), origin, 15, 0);
  assert.equal(origin.x + run([other1, other2]).x, 27);
  assert.deepEqual(run([other1, other2]), run([other2, other1]), 'non-tied candidate order must not change alignment');
});

test('selected companions cannot attract their own moving selection', () => {
  const origin = node('moving', 5, 0); const companion = node('companion', 29, 1000);
  assert.equal(snapDelta(scene([origin, companion], { snapToGrid: true }), new Set(['moving', 'companion']), origin, 15, 0).x, 19);
});

test('object snap distance is measured in screen pixels as zoom changes', () => {
  const origin = node('moving', 0, 0, 1, 1); const target = node('target', 18, 1000, 1, 1);
  assert.equal(snapDelta(scene([origin, target], {}, 1), new Set(['moving']), origin, 10, 0).x, 10, 'exactly seven world/screen pixels is outside the strict threshold');
  assert.equal(snapDelta(scene([origin, target], {}, .5), new Set(['moving']), origin, 10, 0).x, 17, 'seven world pixels become close enough when zoomed out');
});

test('bounds and right alignment retain negative positions and unequal sizes', () => {
  const nodes = [node('a', -40, -30, 20, 10), node('b', 10, 5, 50, 20)];
  assert.deepEqual(bounds(nodes), { x: -40, y: -30, width: 100, height: 55 });
  arrangeNodes(nodes, 'right');
  assert.deepEqual(nodes.map(item => item.x + item.width), [60, 60]);
  assert.equal(bounds([]), undefined);
});

test('horizontal distribution uses equal gaps with unequal widths and fixed outer bounds', () => {
  const nodes = [node('a', 0, 0, 20), node('b', 40, 0, 40), node('c', 120, 0, 20)];
  arrangeNodes(nodes, 'distribute-x');
  assert.deepEqual(nodes.map(item => item.x), [0, 50, 120]);
  assert.equal(nodes[1].x - nodes[0].x - nodes[0].width, nodes[2].x - nodes[1].x - nodes[1].width);
});

test('ports and curve tangents use the requested sides', () => {
  const card = node('card', -10, 20, 100, 60);
  assert.deepEqual(portPoint(card, 'top'), { x: 40, y: 20 });
  assert.deepEqual(portPoint(card, 'right'), { x: 90, y: 50 });
  assert.deepEqual(portPoint(card, 'bottom'), { x: 40, y: 80 });
  assert.deepEqual(portPoint(card, 'left'), { x: -10, y: 50 });
  assert.equal(nearestSide(card, { x: 200, y: 50 }), 'right');
  assert.equal(curve({ x: 0, y: 0 }, { x: 100, y: 0 }, 'top', 'bottom'), 'M 0 0 C 0 -45, 100 45, 100 0');
});

test('group assignment prefers the innermost containing group without dropping untouched orphans', () => {
  const outer: CanvasNode = { ...node('outer', 0, 0, 400, 400), kind: 'group', title: 'Outer' };
  const inner: CanvasNode = { ...node('inner', 40, 40, 180, 180), kind: 'group', title: 'Inner' };
  const moving = node('moving', 80, 90, 24, 24);
  const orphan = { ...node('orphan', 700, 700), groupId: 'unavailable-group' };
  const value = scene([outer, inner, moving, orphan]);
  updateGroupMembership(value, new Set(['moving']));
  assert.equal(moving.groupId, 'inner');
  assert.equal(orphan.groupId, 'unavailable-group');
  moving.x = 800; updateGroupMembership(value, new Set(['moving']));
  assert.equal(moving.groupId, undefined, 'leaving an available group removes its membership');
  updateGroupMembership(value, new Set(['orphan']));
  assert.equal(orphan.groupId, 'unavailable-group', 'missing group metadata must survive even when its node is moved');
});
