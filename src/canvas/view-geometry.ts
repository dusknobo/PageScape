import type { CanvasNode, CanvasScene, NodeSide, Point } from './types';

export type Arrangement = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' | 'distribute-x' | 'distribute-y' | 'row' | 'column' | 'grid';
export function bounds(nodes: CanvasNode[]): { x: number; y: number; width: number; height: number } | undefined {
  if (!nodes.length) return;
  const x = Math.min(...nodes.map(node => node.x)); const y = Math.min(...nodes.map(node => node.y));
  return { x, y, width: Math.max(...nodes.map(node => node.x + node.width)) - x, height: Math.max(...nodes.map(node => node.y + node.height)) - y };
}
export function arrangeNodes(nodes: CanvasNode[], kind: Arrangement): void {
  const box = bounds(nodes); if (!box) return;
  if (kind.startsWith('distribute-')) {
    const horizontal = kind === 'distribute-x'; if (nodes.length < 3) return;
    const ordered = [...nodes].sort((a, b) => horizontal ? a.x - b.x : a.y - b.y);
    const span = horizontal ? box.width : box.height;
    const occupied = ordered.reduce((sum, item) => sum + (horizontal ? item.width : item.height), 0);
    const gap = (span - occupied) / (ordered.length - 1); let position = horizontal ? box.x : box.y;
    for (const item of ordered) { if (horizontal) item.x = position; else item.y = position; position += (horizontal ? item.width : item.height) + gap; }
  } else if (['row', 'column', 'grid'].includes(kind)) {
    const columns = kind === 'column' ? 1 : kind === 'row' ? nodes.length : Math.ceil(Math.sqrt(nodes.length));
    const width = Math.max(...nodes.map(item => item.width)) + 40; const height = Math.max(...nodes.map(item => item.height)) + 40;
    nodes.forEach((item, index) => { item.x = box.x + index % columns * width; item.y = box.y + Math.floor(index / columns) * height; });
  } else for (const item of nodes) {
    if (kind === 'left') item.x = box.x;
    if (kind === 'center') item.x = box.x + (box.width - item.width) / 2;
    if (kind === 'right') item.x = box.x + box.width - item.width;
    if (kind === 'top') item.y = box.y;
    if (kind === 'middle') item.y = box.y + (box.height - item.height) / 2;
    if (kind === 'bottom') item.y = box.y + box.height - item.height;
  }
}
export function portPoint(node: CanvasNode, side: NodeSide): Point {
  if (side === 'top') return { x: node.x + node.width / 2, y: node.y };
  if (side === 'bottom') return { x: node.x + node.width / 2, y: node.y + node.height };
  if (side === 'left') return { x: node.x, y: node.y + node.height / 2 };
  return { x: node.x + node.width, y: node.y + node.height / 2 };
}
export function nearestSide(node: CanvasNode, position: Point): NodeSide {
  const choices: NodeSide[] = ['top', 'right', 'bottom', 'left'];
  return choices.reduce((best, side) => {
    const a = portPoint(node, best); const b = portPoint(node, side);
    return Math.hypot(position.x - b.x, position.y - b.y) < Math.hypot(position.x - a.x, position.y - a.y) ? side : best;
  });
}
export function curve(a: Point, b: Point, fromSide: NodeSide = 'right', toSide: NodeSide = 'left'): string {
  const distance = Math.max(45, Math.hypot(b.x - a.x, b.y - a.y) * .35);
  const vector = (side: NodeSide) => side === 'top' ? [0, -distance] : side === 'bottom' ? [0, distance] : side === 'left' ? [-distance, 0] : [distance, 0];
  const [ax, ay] = vector(fromSide); const [bx, by] = vector(toSide);
  return `M ${a.x} ${a.y} C ${a.x + ax} ${a.y + ay}, ${b.x + bx} ${b.y + by}, ${b.x} ${b.y}`;
}
/** Re-evaluate only geometrically moved nodes; unavailable/orphan group IDs stay intact elsewhere. */
export function updateGroupMembership(scene: CanvasScene, moved: Set<string>): void {
  const groups = scene.nodes.filter(node => node.kind === 'group');
  for (const item of scene.nodes) {
    if (!moved.has(item.id)) continue;
    const candidates = groups.filter(group => group.id !== item.id && group.width * group.height > item.width * item.height &&
      item.x >= group.x && item.y >= group.y + 24 && item.x + item.width <= group.x + group.width && item.y + item.height <= group.y + group.height)
      .sort((a, b) => a.width * a.height - b.width * b.height);
    if (candidates.length) item.groupId = candidates[0].id;
    else if (item.groupId && groups.some(group => group.id === item.groupId)) delete item.groupId;
  }
}
export function snapDelta(scene: CanvasScene, moving: Set<string>, origin: CanvasNode, dx: number, dy: number): Point {
  let x = dx; let y = dy;
  if (scene.settings?.snapToGrid) { x = Math.round((origin.x + x) / 24) * 24 - origin.x; y = Math.round((origin.y + y) / 24) * 24 - origin.y; }
  if (scene.settings?.snapToObjects !== false) {
    const threshold = 7 / scene.viewport.zoom; let bestX = threshold; let bestY = threshold;
    const xs = [origin.x + x, origin.x + x + origin.width / 2, origin.x + x + origin.width];
    const ys = [origin.y + y, origin.y + y + origin.height / 2, origin.y + y + origin.height];
    const baseX = x; const baseY = y;
    for (const other of scene.nodes) if (!moving.has(other.id)) {
      for (const a of xs) for (const b of [other.x, other.x + other.width / 2, other.x + other.width]) if (Math.abs(a - b) < bestX) { bestX = Math.abs(a - b); x = baseX + b - a; }
      for (const a of ys) for (const b of [other.y, other.y + other.height / 2, other.y + other.height]) if (Math.abs(a - b) < bestY) { bestY = Math.abs(a - b); y = baseY + b - a; }
    }
  }
  return { x, y };
}
