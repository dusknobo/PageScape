import type { CanvasNode, CanvasScene } from './types';

const NS = 'http://www.w3.org/2000/svg';
const colors: Record<string, string> = { neutral: '#9298a3', red: '#db5a64', orange: '#dc9851', yellow: '#c1aa42', green: '#5da778', cyan: '#47a9af', blue: '#568ec9', purple: '#a17bc4' };
const color = (value: string) => /^#[0-9a-f]{6}$/i.test(value) ? value : colors[value] || colors.neutral;

/** Safe, non-interactive overview for a canvas embedded in its owner document. */
export function createCanvasThumbnail(doc: Document, scene: CanvasScene): SVGSVGElement | undefined {
  if (!scene.nodes.length) return undefined;
  const make = <T extends keyof SVGElementTagNameMap>(tag: T, attrs: Record<string, string>) => {
    const element = doc.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    return element;
  };
  const minX = Math.min(...scene.nodes.map(n => n.x));
  const minY = Math.min(...scene.nodes.map(n => n.y));
  const width = Math.max(...scene.nodes.map(n => n.x + n.width)) - minX;
  const height = Math.max(...scene.nodes.map(n => n.y + n.height)) - minY;
  const padding = Math.max(24, Math.max(width, height) * .035);
  const image = make('svg', { viewBox: `${minX - padding} ${minY - padding} ${width + padding * 2} ${height + padding * 2}`, role: 'img', 'aria-label': 'Canvas 布局缩略图', preserveAspectRatio: 'xMidYMid meet' });
  image.classList.add('scv-doc-card-preview');
  image.style.cssText = 'display:block;width:100%;height:220px;margin-top:12px;border:1px solid var(--b3-border-color,#ddd);border-radius:8px;background:var(--b3-theme-background,#fff);pointer-events:none';
  const byId = new Map(scene.nodes.map(n => [n.id, n]));
  const render = (node: CanvasNode) => {
    const group = make('g', {});
    group.append(make('rect', { x: String(node.x), y: String(node.y), width: String(node.width), height: String(node.height), rx: '8', fill: color(node.color), 'fill-opacity': node.kind === 'group' ? '.07' : '.16', stroke: color(node.color), 'stroke-width': '2', 'vector-effect': 'non-scaling-stroke' }));
    const label = node.kind === 'text' ? node.text : node.kind === 'file' ? node.name || node.file : node.kind === 'link' ? node.title || node.url : node.title;
    const text = make('text', { x: String(node.x + 12), y: String(node.y + 26), fill: 'var(--b3-theme-on-background,#333)', 'font-size': '16', 'font-family': 'system-ui,sans-serif' });
    text.textContent = label.split('\n')[0].slice(0, Math.max(1, Math.min(45, Math.floor(node.width / 14))));
    group.append(text); return group;
  };
  for (const node of scene.nodes.filter(n => n.kind === 'group')) image.append(render(node));
  for (const edge of scene.edges) {
    const from = byId.get(edge.from), to = byId.get(edge.to); if (!from || !to) continue;
    image.append(make('line', { x1: String(from.x + from.width / 2), y1: String(from.y + from.height / 2), x2: String(to.x + to.width / 2), y2: String(to.y + to.height / 2), stroke: color(edge.color), 'stroke-width': '2', 'vector-effect': 'non-scaling-stroke' }));
  }
  for (const node of scene.nodes.filter(n => n.kind !== 'group')) image.append(render(node));
  return image;
}
