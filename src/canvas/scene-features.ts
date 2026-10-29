import { newCanvasId, normalizeScene } from './model';
import type { CanvasNode, CanvasScene, CanvasTemplate, DocNode } from './types';
import type { DocInfo } from '../types';

/** Folding only changes presentation; stored nodes, expanded sizes and edges stay intact. */
export function canvasVisibility(scene: CanvasScene): { nodes: CanvasNode[]; representative: Map<string, CanvasNode> } {
  const byId = new Map(scene.nodes.map(node => [node.id, node]));
  const representative = new Map<string, CanvasNode>();
  for (const node of scene.nodes) {
    let current = node; let visible = node; const seen = new Set([node.id]);
    while (current.groupId) {
      const parent = byId.get(current.groupId);
      if (!parent || parent.kind !== 'group' || seen.has(parent.id)) break;
      seen.add(parent.id); if (parent.collapsed) visible = parent;
      current = parent;
    }
    representative.set(node.id, visible.kind === 'group' && visible.collapsed ? { ...visible, height: 52 } : visible);
  }
  return { representative, nodes: scene.nodes.filter(node => representative.get(node.id)?.id === node.id).map(node => representative.get(node.id)!) };
}

/** Use connected levels with a deterministic cycle break; move groups with all descendants. */
export function layoutTree(scene: CanvasScene, selected: Set<string>, direction: 'right' | 'down'): CanvasScene {
  const next = structuredClone(scene);
  const byId = new Map(next.nodes.map(node => [node.id, node]));
  const visibility = canvasVisibility(next);
  const containsSelectedParent = (node: CanvasNode) => {
    const seen = new Set([node.id]); let parent = node.groupId;
    while (parent && !seen.has(parent)) {
      if (selected.has(parent)) return true;
      seen.add(parent); parent = byId.get(parent)?.groupId;
    }
    return false;
  };
  const units = visibility.nodes.filter(node => selected.size ? selected.has(node.id) && !containsSelectedParent(node) : !node.groupId || !byId.has(node.groupId));
  if (units.length < 2) return next;
  const unitIds = new Set(units.map(node => node.id));
  const unitFor = (id: string): string | undefined => {
    let node = byId.get(id); const seen = new Set<string>();
    while (node && !seen.has(node.id)) {
      if (unitIds.has(node.id)) return node.id;
      seen.add(node.id); node = node.groupId ? byId.get(node.groupId) : undefined;
    }
    return undefined;
  };
  const adjacency = new Map(units.map(node => [node.id, new Set<string>()]));
  const incoming = new Map(units.map(node => [node.id, 0]));
  for (const edge of scene.edges) {
    const from = unitFor(edge.from), to = unitFor(edge.to);
    if (!from || !to || from === to || adjacency.get(from)!.has(to)) continue;
    adjacency.get(from)!.add(to); incoming.set(to, incoming.get(to)! + 1);
  }
  const ranks = new Map(units.map(node => [node.id, 0]));
  const queue = units.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  const visited = new Set<string>(); let cursor = 0;
  while (visited.size < units.length) {
    if (cursor >= queue.length) queue.push(units.find(node => !visited.has(node.id))!.id);
    const id = queue[cursor++]; if (visited.has(id)) continue;
    visited.add(id);
    for (const child of adjacency.get(id)!) {
      if (visited.has(child)) continue;
      ranks.set(child, Math.max(ranks.get(child)!, ranks.get(id)! + 1));
      incoming.set(child, incoming.get(child)! - 1);
      if (incoming.get(child) === 0) queue.push(child);
    }
  }
  const levels = new Map<number, CanvasNode[]>();
  for (const node of units) { const rank = ranks.get(node.id)!; const level = levels.get(rank) || []; level.push(node); levels.set(rank, level); }
  const origin = { x: Math.min(...units.map(node => node.x)), y: Math.min(...units.map(node => node.y)) };
  const destinations = new Map<string, { x: number; y: number }>(); let major = 0;
  for (const [, nodes] of [...levels].sort(([a], [b]) => a - b)) {
    let minor = 0;
    for (const node of nodes) {
      destinations.set(node.id, direction === 'right' ? { x: origin.x + major, y: origin.y + minor } : { x: origin.x + minor, y: origin.y + major });
      minor += (direction === 'right' ? node.height : node.width) + 60;
    }
    major += Math.max(...nodes.map(node => direction === 'right' ? node.width : node.height)) + 120;
  }
  const originals = new Map(scene.nodes.map(node => [node.id, node]));
  for (const node of next.nodes) {
    const unit = unitFor(node.id); const target = unit && destinations.get(unit); const original = unit && originals.get(unit);
    if (target && original) { node.x += target.x - original.x; node.y += target.y - original.y; }
  }
  return normalizeScene(next);
}

export function reconcileChildren(scene: CanvasScene, parentId: string, children: DocInfo[]): CanvasScene {
  const next = structuredClone(scene); const present = new Map(children.map(doc => [doc.id, doc]));
  const represented = new Set(next.nodes.filter((node): node is DocNode => node.kind === 'doc').map(node => node.docId));
  const excluded = new Set(next.followExcluded || []);
  for (const node of next.nodes) if (node.kind === 'doc') {
    const child = present.get(node.docId);
    if (child && !excluded.has(child.id)) { node.followedFrom = parentId; node.detached = false; node.title = child.title; }
    else if (node.followedFrom === parentId) node.detached = true;
  }
  const additions = children.filter(doc => !represented.has(doc.id) && !excluded.has(doc.id));
  const startX = next.nodes.length ? Math.max(...next.nodes.map(node => node.x + node.width)) + 80 : 0;
  const startY = next.nodes.length ? Math.min(...next.nodes.map(node => node.y)) : 0;
  additions.forEach((doc, index) => next.nodes.push({ id: newCanvasId(), kind: 'doc', docId: doc.id, title: doc.title, followedFrom: parentId, detached: false,
    x: startX + (index % 3) * 350, y: startY + Math.floor(index / 3) * 290, width: 320, height: 250, color: 'neutral' }));
  return normalizeScene(next);
}

export function appendTemplate(scene: CanvasScene, template: CanvasTemplate): { scene: CanvasScene; ids: string[] } {
  const next = structuredClone(scene); const mapping = new Map<string, string>();
  const mapped = (id: string) => { if (!mapping.has(id)) mapping.set(id, newCanvasId()); return mapping.get(id)!; };
  const minX = template.nodes.length ? Math.min(...template.nodes.map(node => node.x)) : 0;
  const minY = template.nodes.length ? Math.min(...template.nodes.map(node => node.y)) : 0;
  const startX = next.nodes.length ? Math.max(...next.nodes.map(node => node.x + node.width)) + 80 : 0;
  const startY = next.nodes.length ? Math.min(...next.nodes.map(node => node.y)) : 0;
  const nodes = structuredClone(template.nodes).map(node => {
    const copy = { ...node, id: mapped(node.id), x: node.x - minX + startX, y: node.y - minY + startY, ...(node.groupId ? { groupId: mapped(node.groupId) } : {}) };
    if (copy.kind === 'doc') { delete copy.followedFrom; delete copy.detached; }
    return copy;
  });
  next.nodes.push(...nodes);
  next.edges.push(...template.edges.map(edge => ({ ...structuredClone(edge), id: newCanvasId(), from: mapped(edge.from), to: mapped(edge.to) })));
  return { scene: normalizeScene(next), ids: nodes.map(node => node.id) };
}
