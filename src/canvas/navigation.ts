import type { CanvasNode, CanvasScene, Point } from './types';

const NS = 'http://www.w3.org/2000/svg';
const nodeLabel = (node: CanvasNode) => node.kind === 'text' ? node.text : node.kind === 'file' ? node.name || node.file : node.kind === 'link' ? node.title || node.url : node.title;
export function createCanvasNavigation(root: HTMLElement, stage: HTMLElement, options: {
  focus: (id: string) => void; center: (point: Point, commit: boolean) => void; text: (id: string) => string;
}) {
  const doc = root.ownerDocument; const lifetime = new AbortController();
  const controls = doc.createElement('div'); controls.className = 'scv-navigation';
  const searchBox = doc.createElement('div'); searchBox.className = 'scv-search-box';
  const input = doc.createElement('input'); input.type = 'search'; input.placeholder = '搜索画布…'; input.setAttribute('aria-label', '搜索画布');
  const results = doc.createElement('div'); results.className = 'scv-search-results'; results.setAttribute('role', 'list'); results.hidden = true;
  const groups = doc.createElement('select'); groups.setAttribute('aria-label', '跳到分组');
  const toggle = doc.createElement('button'); toggle.type = 'button'; toggle.className = 'scv-button'; toggle.textContent = '小地图'; toggle.setAttribute('aria-pressed', 'true');
  const map = doc.createElementNS(NS, 'svg'); map.classList.add('scv-minimap'); map.setAttribute('tabindex', '0');
  map.setAttribute('role', 'img'); map.setAttribute('aria-label', '画布小地图，点击或拖动定位');
  map.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const layer = doc.createElementNS(NS, 'g'); const viewport = doc.createElementNS(NS, 'rect'); viewport.classList.add('scv-minimap-viewport');
  map.append(layer, viewport); stage.append(map);
  searchBox.append(input, results); controls.append(searchBox, groups, toggle);
  let scene: CanvasScene | undefined; let visible: CanvasNode[] = []; let frame = 0; let groupSignature = '';
  let matches: CanvasNode[] = []; let selected = 0; let pointer: number | undefined;
  const rectangles = new Map<string, SVGRectElement>();
  const renderResults = () => {
    const query = input.value.trim().toLocaleLowerCase(); results.replaceChildren();
    if (!scene || !query) { results.hidden = true; matches = []; return; }
    matches = scene.nodes.filter(node => `${nodeLabel(node)} ${node.kind === 'doc' ? node.docId : ''} ${options.text(node.id)}`.toLocaleLowerCase().includes(query)).slice(0, 60);
    selected = Math.min(selected, Math.max(0, matches.length - 1));
    for (const [index, node] of matches.entries()) {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'scv-search-result'; button.setAttribute('role', 'listitem');
      button.textContent = nodeLabel(node).replace(/\s+/g, ' ').slice(0, 100) || '未命名卡片'; button.dataset.active = String(index === selected);
      button.addEventListener('click', () => { options.focus(node.id); results.hidden = true; stage.focus({ preventScroll: true }); }, { once: true }); results.append(button);
    }
    if (!matches.length) { const message = doc.createElement('span'); message.textContent = '没有匹配卡片'; results.append(message); }
    results.hidden = false;
  };
  input.addEventListener('input', () => { selected = 0; renderResults(); }, { signal: lifetime.signal });
  input.addEventListener('focus', renderResults, { signal: lifetime.signal });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { results.hidden = true; stage.focus({ preventScroll: true }); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(1, matches.length)) % Math.max(1, matches.length); renderResults(); }
    else if (event.key === 'Enter' && matches[selected]) { event.preventDefault(); options.focus(matches[selected].id); results.hidden = true; stage.focus({ preventScroll: true }); }
    event.stopPropagation();
  }, { signal: lifetime.signal });
  root.addEventListener('pointerdown', event => { if (event.target instanceof Node && !searchBox.contains(event.target)) results.hidden = true; }, { signal: lifetime.signal });
  groups.addEventListener('change', () => { if (groups.value) options.focus(groups.value); groups.value = ''; }, { signal: lifetime.signal });
  const setMapVisible = (shown: boolean) => { map.toggleAttribute('hidden', !shown); map.style.display = shown ? '' : 'none'; toggle.setAttribute('aria-pressed', String(shown)); };
  try { setMapVisible(localStorage.getItem('scc-minimap-visible') !== 'false'); } catch { /* Optional view preference. */ }
  toggle.addEventListener('click', () => { const shown = toggle.getAttribute('aria-pressed') !== 'true'; setMapVisible(shown); try { localStorage.setItem('scc-minimap-visible', String(shown)); } catch { /* Keep this window's choice. */ } }, { signal: lifetime.signal });
  const point = (event: PointerEvent): Point | undefined => {
    const matrix = map.getScreenCTM(); if (!matrix) return;
    const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()); return { x: local.x, y: local.y };
  };
  map.addEventListener('pointerdown', event => { if (event.button !== 0) return; pointer = event.pointerId; map.setPointerCapture(pointer); const p = point(event); if (p) options.center(p, false); event.preventDefault(); event.stopPropagation(); }, { signal: lifetime.signal });
  map.addEventListener('pointermove', event => { if (pointer !== event.pointerId) return; const p = point(event); if (p) options.center(p, false); event.stopPropagation(); }, { signal: lifetime.signal });
  const finish = (event: PointerEvent) => { if (pointer !== event.pointerId) return; pointer = undefined; const p = point(event); if (p) options.center(p, true); event.stopPropagation(); };
  map.addEventListener('pointerup', finish, { signal: lifetime.signal }); map.addEventListener('pointercancel', finish, { signal: lifetime.signal });
  for (const type of ['dblclick', 'contextmenu']) map.addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); }, { signal: lifetime.signal });
  map.addEventListener('keydown', event => {
    if (!scene || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const zoom = scene.viewport.zoom; const x = (stage.clientWidth / 2 - scene.viewport.x) / zoom; const y = (stage.clientHeight / 2 - scene.viewport.y) / zoom;
    options.center({ x: x + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0) * stage.clientWidth / zoom / 4,
      y: y + (event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0) * stage.clientHeight / zoom / 4 }, true);
  }, { signal: lifetime.signal });
  function render(): void {
    frame = 0; if (!scene || lifetime.signal.aborted) return;
    const x = -scene.viewport.x / scene.viewport.zoom, y = -scene.viewport.y / scene.viewport.zoom;
    const width = stage.clientWidth / scene.viewport.zoom, height = stage.clientHeight / scene.viewport.zoom;
    const minX = Math.min(x, ...visible.map(node => node.x)) - 60, minY = Math.min(y, ...visible.map(node => node.y)) - 60;
    const maxX = Math.max(x + width, ...visible.map(node => node.x + node.width)) + 60, maxY = Math.max(y + height, ...visible.map(node => node.y + node.height)) + 60;
    map.setAttribute('viewBox', `${minX} ${minY} ${Math.max(1, maxX - minX)} ${Math.max(1, maxY - minY)}`);
    const ids = new Set(visible.map(node => node.id));
    for (const [id, rectangle] of rectangles) if (!ids.has(id)) { rectangle.remove(); rectangles.delete(id); }
    for (const node of visible) {
      let rectangle = rectangles.get(node.id); if (!rectangle) { rectangle = doc.createElementNS(NS, 'rect'); rectangles.set(node.id, rectangle); layer.append(rectangle); }
      for (const [name, value] of Object.entries({ x: node.x, y: node.y, width: node.width, height: node.height })) rectangle.setAttribute(name, String(value));
      rectangle.setAttribute('class', node.kind === 'group' ? 'scv-minimap-group' : 'scv-minimap-node');
    }
    for (const [name, value] of Object.entries({ x, y, width, height })) viewport.setAttribute(name, String(value));
    const currentGroups = scene.nodes.filter(node => node.kind === 'group'); const signature = JSON.stringify(currentGroups.map(node => [node.id, node.title]));
    if (signature !== groupSignature || !groups.options.length) {
      groupSignature = signature; const placeholder = doc.createElement('option'); placeholder.value = ''; placeholder.textContent = '跳到分组';
      groups.replaceChildren(placeholder, ...currentGroups.map(node => { const option = doc.createElement('option'); option.value = node.id; option.textContent = node.title || '未命名分组'; return option; }));
    }
    if (input.value && !results.hidden) renderResults();
  }
  return {
    controls,
    update(next: CanvasScene, nodes: CanvasNode[]) { scene = next; visible = nodes; if (!frame) frame = requestAnimationFrame(render); },
    focusSearch() { input.focus(); input.select(); },
    dispose() { lifetime.abort(); cancelAnimationFrame(frame); map.remove(); controls.remove(); },
  };
}
