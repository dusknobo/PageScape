import type { CanvasEdge, CanvasNode, CanvasPreview, CanvasScene, CanvasSummary, CanvasView, CanvasViewOptions, NodeColor, NodeSide, Point } from './types';
import { extractDropIds, newCanvasId, normalizeScene } from './model';
import { exportJsonCanvas } from './json-canvas';
import { arrangeNodes, bounds, curve, nearestSide, portPoint, snapDelta, updateGroupMembership } from './view-geometry';
import type { Arrangement } from './view-geometry';
import { downloadBlob, renderNoteMarkdown, safeCanvasUrl } from './view-content';
import { canvasPng } from './view-export';
import { canvasVisibility, layoutTree } from './scene-features';
import { createCanvasNavigation } from './navigation';

const COLORS: NodeColor[] = ['neutral', 'red', 'blue', 'green', 'orange', 'yellow', 'cyan', 'purple'];
const COLOR_NAMES = ['默认', '红色', '蓝色', '绿色', '橙色', '黄色', '青色', '紫色'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const DOCUMENT_ID = /^\d{14}-[a-z0-9]{7}$/;
type NodeView = { element: HTMLElement; title: HTMLElement; preview?: HTMLElement; reading?: HTMLElement; text?: HTMLTextAreaElement; signature?: string; cleanup?: () => void; markdownCleanup?: () => void; editorCleanup?: () => void; editor?: HTMLElement; textSignature?: string };
type Gesture = {
  type: 'pan' | 'drag' | 'resize' | 'marquee' | 'connect' | 'reconnect'; pointer: number; start: Point; before: CanvasScene;
  ids?: Set<string>; nodeId?: string; positions?: Map<string, { x: number; y: number }>; selected?: Set<string>;
  side?: NodeSide; edgeId?: string; edgeEnd?: 'from' | 'to';
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); result.className = cls;
  if (text !== undefined) result.textContent = text;
  return result;
}
function btn(text: string, title?: string): HTMLButtonElement {
  const result = el('button', 'scv-button', text); result.type = 'button'; result.title = title || text; return result;
}
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const result = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) result.setAttribute(name, value);
  return result;
}
function clone(scene: CanvasScene): CanvasScene { return structuredClone(scene); }
function uid(prefix: string): string { return `${prefix}-${newCanvasId()}`; }
function editing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input,textarea,select')) return true;
  return target.closest('[contenteditable]')?.getAttribute('contenteditable') === 'true';
}
function content(scene: CanvasScene): string {
  return JSON.stringify([scene.title, scene.viewport, scene.nodes, scene.edges, scene.settings, scene.jsonCanvas]);
}
function graphContent(scene: CanvasScene): string {
  return JSON.stringify([scene.nodes.map(item => {
    if (item.kind !== 'doc') return item;
    const { title: _title, ...node } = item; return node;
  }), scene.edges, scene.settings, scene.jsonCanvas]);
}

/** Extract document references only; never execute dropped HTML or interpret it as canvas markup. */
function droppedIds(transfer: DataTransfer | null): string[] {
  if (!transfer) return [];
  for (const type of ['application/siyuan-documents', 'application/siyuan-document-tab', 'application/x-siyuan', 'text/uri-list', 'text/plain', 'text/html']) {
    if (![...transfer.types].includes(type)) continue;
    let raw = '';
    try { raw = transfer.getData(type); } catch { continue; }
    if (type === 'text/html') {
      if (raw.length > 2_000_000) continue;
      const source = document.createElement('template'); source.innerHTML = raw;
      // Tree HTML contains notebook and ancestor IDs too; only explicit links qualify.
      raw = [...source.content.querySelectorAll('a[href]')].map(anchor => anchor.getAttribute('href') || '').join('\n');
    }
    const ids = extractDropIds(raw);
    if (ids.length) return ids;
  }
  return [];
}

export function createCanvasView(options: CanvasViewOptions): CanvasView {
  const lifetime = new AbortController();
  const root = el('section', 'scv-root'); root.tabIndex = 0; root.setAttribute('aria-label', '子页画布');
  if (options.inline) root.contentEditable = 'false';
  const header = el('header', 'scv-toolbar');
  const boardRow = el('div', 'scv-toolbar-row');
  const boardSelect = el('select', 'scv-board-select'); boardSelect.setAttribute('aria-label', '选择画布');
  const inlineTitle = el('strong', 'scv-inline-title'); inlineTitle.hidden = !options.inline;
  const boardNew = btn('新建', '选择保存位置并新建画布文档'); const boardRename = btn('重命名');
  const openOwner = btn('打开所属文档', '打开保存此画布布局的思源文档'); openOwner.disabled = true;
  const migrateLegacy = btn('迁移旧画布…', '把旧版独立 JSON 画布复制保存为思源文档');
  migrateLegacy.hidden = !options.onMigrateLegacy;
  const save = btn('保存'); const reload = btn('重载'); const saveCopy = btn('另存副本'); const refresh = btn('刷新文档');
  const meta = el('span', 'scv-meta');
  const openCanvas = btn('打开 Canvas', '在独立页签中编辑同一张画布'); openCanvas.hidden = !options.onOpenCanvas;
  if (options.inline) { boardSelect.hidden = true; boardNew.hidden = true; boardRename.hidden = true; openOwner.hidden = true; }
  boardRow.append(inlineTitle, boardSelect, boardNew, boardRename, openOwner, openCanvas, migrateLegacy, el('span', 'scv-toolbar-spacer'), meta, save, reload, saveCopy, refresh);
  const actionRow = el('div', 'scv-toolbar-row');
  const addDoc = btn('添加文档'); const importChildren = btn('导入子页'); const addNote = btn('添加便签');
  const followChildren = btn('跟随子页'); const stopFollowing = btn('停止跟随'); stopFollowing.hidden = true;
  const templates = btn('模板'); templates.disabled = !options.onTemplates;
  const references = btn('引用位置', '查看所选文档或当前画布的反向引用'); references.disabled = !options.onReferences;
  const more = btn('更多工具'); more.setAttribute('aria-expanded', 'false');
  const addLink = btn('添加网页'); const addMedia = btn('添加附件'); const importFile = btn('导入 .canvas'); const exportFile = btn('导出 .canvas'); const exportPng = btn('导出 PNG');
  const mediaInput = el('input', 'scv-file-input'); mediaInput.type = 'file'; mediaInput.multiple = true; mediaInput.hidden = true;
  let pendingMediaReplace: string | undefined;
  const chooseMedia = (replaceNodeId?: string) => { pendingMediaReplace = replaceNodeId; mediaInput.multiple = !replaceNodeId; mediaInput.click(); };
  const canvasInput = el('input', 'scv-file-input'); canvasInput.type = 'file'; canvasInput.accept = '.canvas,application/json'; canvasInput.hidden = true;
  const layout = el('select', 'scv-layout-select'); layout.setAttribute('aria-label', '排列所选节点');
  const layouts: [string, string][] = [['', '对齐 / 排列'], ['left', '左对齐'], ['center', '水平居中'], ['right', '右对齐'], ['top', '顶端对齐'], ['middle', '垂直居中'], ['bottom', '底端对齐'], ['distribute-x', '水平等距'], ['distribute-y', '垂直等距'], ['row', '排成一行'], ['column', '排成一列'], ['grid', '网格排列']];
  for (const [value, label] of layouts) { const option = el('option', '', label); option.value = value; layout.append(option); }
  for (const [value, label] of [['tree-right', '树形布局（向右）'], ['tree-down', '层级布局（向下）']]) { const option = el('option', '', label); option.value = value; layout.append(option); }
  const settings = btn('设置');
  const connect = btn('连线'); connect.setAttribute('aria-pressed', 'false');
  const marqueeMode = btn('框选'); marqueeMode.setAttribute('aria-pressed', 'false');
  const group = btn('分组'); const remove = btn('移除', '仅从画布移除，不删除原文档');
  const undo = btn('撤销', '撤销 Ctrl+Z'); const redo = btn('重做', '重做 Ctrl+Shift+Z');
  const palette = el('div', 'scv-palette'); palette.setAttribute('aria-label', '节点颜色');
  const colorButtons = COLORS.map((color, index) => {
    const item = btn(''); item.className = 'scv-color-button'; item.dataset.color = color;
    item.title = COLOR_NAMES[index]; item.setAttribute('aria-label', `${COLOR_NAMES[index]}节点`);
    item.addEventListener('click', () => recolor(color), { signal: lifetime.signal }); palette.append(item); return item;
  });
  const customColor = el('input', 'scv-custom-color'); customColor.type = 'color'; customColor.setAttribute('aria-label', '自定义节点或连线颜色'); palette.append(customColor);
  actionRow.append(addDoc, addNote, connect, group, undo, redo, remove, templates, references, more);
  const advanced = el('div', 'scv-toolbar-row scv-advanced-tools');
  advanced.append(importChildren, followChildren, stopFollowing, addLink, addMedia, marqueeMode, palette, layout, settings, boardRename, migrateLegacy, reload, saveCopy, refresh, importFile, exportFile, exportPng, mediaInput, canvasInput);
  const setAdvanced = (expanded: boolean, remember = false) => {
    advanced.hidden = !expanded; more.textContent = expanded ? '收起工具' : '更多工具'; more.setAttribute('aria-expanded', String(expanded));
    if (remember) try { localStorage.setItem('scc-toolbar-expanded', String(expanded)); } catch { /* Optional view preference. */ }
  };
  try { setAdvanced(localStorage.getItem('scc-toolbar-expanded') === 'true'); } catch { setAdvanced(false); }
  more.addEventListener('click', () => setAdvanced(Boolean(advanced.hidden), true), { signal: lifetime.signal });
  header.append(boardRow, actionRow, advanced);
  const stage = el('div', 'scv-stage'); stage.tabIndex = 0;
  const world = el('div', 'scv-world');
  const edges = svg('svg', { class: 'scv-edges', 'aria-label': '画布连线' });
  const defs = svg('defs');
  const markerId = uid('scv-arrow');
  const marker = svg('marker', { id: markerId, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
  marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'context-stroke' })); defs.append(marker); edges.append(defs);
  const edgeLayer = svg('g'); edges.append(edgeLayer);
  const pendingEdge = svg('path', { class: 'scv-pending-edge', 'marker-end': `url(#${markerId})` }); pendingEdge.style.display = 'none'; edges.append(pendingEdge);
  const connectionHandles = svg('svg', { class: 'scv-edge-controls', 'aria-label': '调整连线端点' });
  world.append(edges, connectionHandles); stage.append(world);
  const marquee = el('div', 'scv-marquee'); marquee.hidden = true; stage.append(marquee);
  const empty = el('div', 'scv-empty');
  empty.append(el('strong', 'scv-empty-title', '把想法放到画布上'), el('span', 'scv-empty-description', '添加文档、导入子页，或把思源文档链接拖到这里。'));
  stage.append(empty);
  const zoomTools = el('div', 'scv-zoom-tools');
  const zoomOut = btn('−', '缩小'); const zoomLabel = btn('100%', '恢复 100%'); const zoomIn = btn('+', '放大'); const fit = btn('适应全部'); const fitSelected = btn('适应选择');
  zoomTools.append(zoomOut, zoomLabel, zoomIn, fit, fitSelected); stage.append(zoomTools);
  const bottom = el('footer', 'scv-bottom');
  const status = el('span', 'scv-status', '正在打开画布…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const help = el('span', 'scv-help', '空白拖动平移 · Ctrl/空格+滚轮缩放 · Shift+1/2适应 · Alt拖动复制 · 右键更多');
  bottom.append(status, help); root.append(header, stage, bottom); options.element.append(root);

  let scene: CanvasScene | undefined;
  let disposed = false;
  let gesture: Gesture | undefined;
  let space = false;
  let connectMode = false;
  let boxMode = false;
  let connectFrom: string | undefined;
  let selected = new Set<string>();
  let selectedEdge: string | undefined;
  let boards: CanvasSummary[] = [];
  let nodeViews = new Map<string, NodeView>();
  const previews = new Map<string, CanvasPreview>();
  const edgeViews = new Map<string, { group: SVGGElement; path: SVGPathElement; text: SVGTextElement; from: SVGCircleElement; to: SVGCircleElement }>();
  const past: CanvasScene[] = [];
  const future: CanvasScene[] = [];
  let textSession: { id: string; checkpointed: boolean; before: CanvasScene } | undefined;
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  let closeDialog: (() => void) | undefined;
  let closeMenu: (() => void) | undefined;
  let clipboard: { nodes: CanvasNode[]; edges: CanvasEdge[] } | undefined;
  let pasteOffset = 0;
  const readingNotes = new Set<string>();
  const navigation = createCanvasNavigation(root, stage, {
    focus: id => focusNode(id),
    center: (point, commit) => {
      if (!scene) return;
      scene.viewport.x = stage.clientWidth / 2 - point.x * scene.viewport.zoom;
      scene.viewport.y = stage.clientHeight / 2 - point.y * scene.viewport.zoom;
      updateViewport(); if (commit) emit();
    },
    text: id => nodeViews.get(id)?.preview?.textContent || '',
  });
  boardRow.insertBefore(navigation.controls, meta);
  const resizeObserver = new ResizeObserver(() => { if (scene && !disposed) navigation.update(scene, canvasVisibility(scene).nodes); });
  resizeObserver.observe(stage);

  function readOnly(): boolean { return Boolean(scene?.settings?.readOnly || window.siyuan?.config?.readonly || window.siyuan?.isPublish || options.isReadonly?.()); }
  function mutable(): boolean { if (!scene || readOnly()) { setStatus('画布已锁定；可在设置中解除只读', 'error'); return false; } return true; }

  function setStatus(message: string, tone: 'normal' | 'error' | 'conflict' = 'normal'): void {
    if (disposed) return;
    status.textContent = message; status.dataset.tone = tone;
  }
  function invoke(callback: () => void): void {
    try { callback(); } catch (error) { setStatus(error instanceof Error ? error.message : '操作失败，请重试', 'error'); }
  }
  function checkpoint(before: CanvasScene): void {
    past.push(clone(before)); if (past.length > 80) past.shift(); future.length = 0; updateSelection();
  }
  function emit(): void {
    if (!scene || disposed) return;
    navigation.update(scene, canvasVisibility(scene).nodes);
    scene.updatedAt = Date.now(); invoke(() => options.onChange(clone(scene!)));
  }
  function commit(before: CanvasScene, history = true): void {
    if (!scene || content(before) === content(scene)) return;
    if (history) checkpoint(before);
    emit();
  }
  function edit(action: () => void): void {
    if (!scene || !mutable()) return;
    textSession = undefined;
    const before = clone(scene); action(); syncNodes(); syncEdges(); updateSelection(); commit(before);
  }
  function point(event: Pick<MouseEvent, 'clientX' | 'clientY'>): Point {
    const rect = stage.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function toWorld(local: Point): Point {
    const viewport = scene?.viewport || { x: 0, y: 0, zoom: 1 };
    return { x: (local.x - viewport.x) / viewport.zoom, y: (local.y - viewport.y) / viewport.zoom };
  }
  function getCenter(): Point { return toWorld({ x: stage.clientWidth / 2, y: stage.clientHeight / 2 }); }
  function node(id: string): CanvasNode | undefined { return scene?.nodes.find(item => item.id === id); }
  function updateViewport(): void {
    if (!scene) return;
    const { x, y, zoom } = scene.viewport;
    world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    stage.style.backgroundSize = `${24 * zoom}px ${24 * zoom}px`;
    stage.style.backgroundPosition = `${x}px ${y}px`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    root.classList.toggle('scv-readonly', readOnly());
    navigation.update(scene, canvasVisibility(scene).nodes);
  }
  function updateMeta(): void {
    if (!scene) return;
    meta.textContent = scene.revision ? `已保存 ${new Date(scene.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '新画布';
    openOwner.disabled = !DOCUMENT_ID.test(scene.id);
    openOwner.title = openOwner.disabled ? '旧版画布迁移为文档后可打开所属文档' : '打开保存此画布布局的思源文档';
    followChildren.textContent = scene.followParentId ? '子页跟随中' : '跟随子页';
    followChildren.dataset.following = String(Boolean(scene.followParentId));
    stopFollowing.hidden = !scene.followParentId;
  }
  function setBoards(next: CanvasSummary[]): void {
    boards = next;
    inlineTitle.textContent = scene?.title || 'Canvas 画布';
    boardSelect.replaceChildren();
    const entries = scene && !boards.some(item => item.id === scene!.id) ? [{ id: scene.id, title: scene.title, updatedAt: scene.updatedAt }, ...boards] : boards;
    for (const board of entries) {
      const option = el('option', '', board.id === scene?.id ? scene.title : board.title); option.value = board.id; boardSelect.append(option);
    }
    if (scene) boardSelect.value = scene.id;
  }
  function updateSelection(): void {
    for (const [id, view] of nodeViews) view.element.classList.toggle('scv-selected', selected.has(id));
    for (const [id, view] of edgeViews) view.group.classList.toggle('scv-edge-selected', id === selectedEdge);
    group.disabled = !scene || readOnly(); remove.disabled = readOnly() || selected.size === 0 && !selectedEdge;
    undo.disabled = readOnly() || past.length === 0; redo.disabled = readOnly() || future.length === 0;
    for (const color of colorButtons) color.disabled = readOnly() || selected.size === 0 && !selectedEdge;
    customColor.disabled = readOnly() || selected.size === 0 && !selectedEdge;
    layout.disabled = readOnly() || !scene || (selected.size < 2 && scene.nodes.length < 2);
    for (const button of [addDoc, importChildren, followChildren, stopFollowing, addNote, addLink, addMedia, connect, boardRename]) button.disabled = !scene || readOnly();
    fitSelected.disabled = !selected.size;
    for (const view of nodeViews.values()) if (view.text) view.text.readOnly = readOnly();
    for (const [id, view] of nodeViews) view.element.classList.toggle('scv-connection-source', id === connectFrom);
    positionEdges();
  }
  function release(view: NodeView): void {
    for (const cleanup of [view.cleanup, view.markdownCleanup, view.editorCleanup]) try { cleanup?.(); } catch { /* Release other renderers too. */ }
    view.cleanup = undefined; view.markdownCleanup = undefined; view.editorCleanup = undefined;
  }
  function updatePreview(view: NodeView, item: CanvasNode): void {
    if (item.kind !== 'doc' || !view.preview || view.editor) return;
    const payload = previews.get(item.docId + '\0' + (item.subpath || '')) || previews.get(item.docId);
    view.title.textContent = payload?.doc?.title || item.title || '未命名文档';
    const signature = payload?.error ? `error:${payload.error}` : payload?.preview ? `preview:${payload.preview.eof}:${payload.preview.dom}` : 'loading';
    if (view.signature === signature) return;
    view.signature = signature; view.cleanup?.(); view.cleanup = undefined; view.preview.replaceChildren();
    if (payload?.error) {
      view.preview.append(el('p', 'scv-preview-message scv-preview-error', `文档暂不可用：${payload.error}`));
    } else if (payload?.preview) {
      if (!payload.preview.dom.trim()) view.preview.append(el('p', 'scv-preview-message', '暂无内容'));
      else {
        try { view.cleanup = options.renderPreview(payload.preview, view.preview, true); }
        catch { view.preview.replaceChildren(el('p', 'scv-preview-message scv-preview-error', '预览暂不可用，请刷新后重试')); }
      }
    } else view.preview.append(el('p', 'scv-preview-message', '正在读取文档…'));
  }
  function createNode(item: CanvasNode): NodeView {
    const card = el('article', `scv-node scv-node-${item.kind}`); card.dataset.scvNodeId = item.id;
    const head = el('div', 'scv-node-header');
    const icon = el('span', 'scv-node-icon', item.kind === 'doc' ? '▤' : item.kind === 'group' ? '▱' : item.kind === 'file' ? '▧' : item.kind === 'link' ? '↗' : '✎');
    icon.setAttribute('aria-hidden', 'true');
    const title = el('span', 'scv-node-title', item.kind === 'text' ? '便签' : item.kind === 'file' ? item.name || item.file.split('/').pop() : item.title || (item.kind === 'link' ? item.url : '分组'));
    head.append(icon, title); head.title = item.kind === 'doc' ? '拖动移动 · 双击标题打开原文档' : '拖动移动'; card.append(head);
    const view: NodeView = { element: card, title };
    if (item.kind === 'doc') { view.preview = el('div', 'scv-node-preview'); card.append(view.preview); }
    if (item.kind === 'doc') { const badge = el('span', 'scv-follow-badge', '已移出子页'); badge.hidden = !item.detached; badge.title = '原卡片和连线保留；此文档已不在跟随父文档的直接子页列表中'; head.append(badge); }
    if (item.kind === 'group') {
      const tools = el('div', 'scv-node-tools'); const fold = btn('收起'); fold.classList.add('scv-fold-group');
      fold.addEventListener('click', () => toggleGroup(item.id), { signal: lifetime.signal }); tools.append(fold); head.append(tools);
    }
    if (item.kind === 'text') {
      const reading = el('div', 'scv-note-reading'); reading.title = '双击编辑 Markdown 便签'; card.append(reading); view.reading = reading;
      const text = el('textarea', 'scv-note-text'); text.value = item.text; text.placeholder = '写下想法…'; text.setAttribute('aria-label', '便签内容');
      text.spellcheck = false; text.maxLength = 50_000; text.tabIndex = -1; text.classList.add('scv-note-collapsed'); card.append(text); view.text = text;
      const tools = el('div', 'scv-node-tools'); const editNote = btn('编辑', '编辑便签'); editNote.setAttribute('aria-label', '编辑便签');
      editNote.addEventListener('click', () => beginNote(item.id), { signal: lifetime.signal }); tools.append(editNote); head.append(tools); readingNotes.add(item.id);
    }
    if (item.kind === 'file' || item.kind === 'link') { view.preview = el('div', 'scv-media-preview'); card.append(view.preview); }
    for (const side of ['right', 'top', 'bottom', 'left'] as NodeSide[]) {
      const port = btn('', '从这里拖出连线'); port.className = 'scv-node-port'; port.dataset.side = side;
      port.setAttribute('aria-label', side === 'right' ? '拖动连线' : `${side}侧拖动连线`); card.append(port);
    }
    const resize = el('div', 'scv-node-resize'); resize.title = '拖动调整大小'; card.append(resize);
    return view;
  }
  function positionNode(view: NodeView, item: CanvasNode): void {
    Object.assign(view.element.style, { left: `${item.x}px`, top: `${item.y}px`, width: `${item.width}px`, height: `${item.kind === 'group' && item.collapsed ? 52 : item.height}px` });
    view.element.dataset.color = item.color; view.element.dataset.kind = item.kind;
    view.element.style.setProperty('--scv-node-accent', item.color.startsWith('#') ? item.color : '');
    if (item.kind === 'group') {
      view.element.classList.toggle('scv-collapsed-group', Boolean(item.collapsed));
      const fold = view.element.querySelector<HTMLButtonElement>('.scv-fold-group');
      if (fold) { fold.textContent = item.collapsed ? '展开' : '收起'; fold.setAttribute('aria-expanded', String(!item.collapsed)); fold.disabled = readOnly(); }
      const resize = view.element.querySelector<HTMLElement>('.scv-node-resize'); if (resize) resize.hidden = Boolean(item.collapsed);
      const url = item.background && safeCanvasUrl(item.background);
      view.element.style.backgroundImage = url ? `url(${JSON.stringify(url)})` : '';
      view.element.style.backgroundSize = item.backgroundStyle === 'ratio' ? 'contain' : item.backgroundStyle === 'repeat' ? 'auto' : 'cover';
      view.element.style.backgroundRepeat = item.backgroundStyle === 'repeat' ? 'repeat' : 'no-repeat';
    }
  }
  function syncNodes(): void {
    if (!scene) return;
    const visibility = canvasVisibility(scene);
    const ids = new Set(scene.nodes.map(item => item.id));
    for (const [id, view] of nodeViews) if (!ids.has(id)) { release(view); view.element.remove(); nodeViews.delete(id); selected.delete(id); }
    for (const item of scene.nodes) {
      let view = nodeViews.get(item.id);
      if (view && (view.element.dataset.kind !== item.kind || (item.kind === 'doc' && view.element.dataset.docId !== item.docId))) {
        release(view); view.element.remove(); nodeViews.delete(item.id); view = undefined;
      }
      if (!view) { view = createNode(item); nodeViews.set(item.id, view); world.append(view.element); }
      positionNode(view, item);
      view.element.hidden = visibility.representative.get(item.id)?.id !== item.id;
      if (item.kind === 'doc') { const badge = view.element.querySelector<HTMLElement>('.scv-follow-badge'); if (badge) badge.hidden = !item.detached; }
      if (item.kind === 'doc') { view.element.dataset.docId = item.docId; updatePreview(view, item); }
      else if (item.kind === 'group') view.title.textContent = item.title || '分组';
      else if (item.kind === 'text') {
        if (view.text && document.activeElement !== view.text) view.text.value = item.text;
        if (view.reading && view.textSignature !== item.text) {
          view.markdownCleanup?.(); view.reading.replaceChildren();
          view.markdownCleanup = renderNoteMarkdown(item.text, view.reading, options.renderPreview); view.textSignature = item.text;
        }
      } else renderMedia(view, item);
    }
    empty.hidden = scene.nodes.length > 0;
    navigation.update(scene, visibility.nodes);
  }
  function beginNote(id: string): void {
    if (!mutable()) return;
    const view = nodeViews.get(id); if (!view?.text) return;
    readingNotes.delete(id); view.text.classList.remove('scv-note-collapsed'); view.text.tabIndex = 0;
    if (view.reading) view.reading.hidden = true; view.text.focus();
  }
  function finishNotes(): void {
    for (const [id, view] of nodeViews) if (view.text && view.reading) {
      readingNotes.add(id); view.text.classList.add('scv-note-collapsed'); view.text.tabIndex = -1; view.reading.hidden = false;
      const item = node(id); if (item?.kind === 'text' && view.textSignature !== item.text) {
        view.markdownCleanup?.(); view.reading.replaceChildren(); view.markdownCleanup = renderNoteMarkdown(item.text, view.reading, options.renderPreview); view.textSignature = item.text;
      }
    }
  }
  function finishDocumentEditors(): void {
    for (const [id, view] of nodeViews) if (view.editor) {
      view.editorCleanup?.(); view.editorCleanup = undefined; view.editor.remove(); view.editor = undefined;
      if (view.preview) view.preview.hidden = false; view.element.querySelector('.scv-editor-close')?.remove(); view.signature = undefined;
      const item = node(id); if (item) updatePreview(view, item);
    }
  }
  function beginDocument(id: string): void {
    const item = node(id); const view = nodeViews.get(id);
    if (options.inline && item?.kind === 'doc') { invoke(() => options.onOpenDocument(item.docId)); return; }
    if (!mutable() || item?.kind !== 'doc' || !view || !options.onEditDocument || view.editor) return;
    finishDocumentEditors(); finishNotes();
    const editor = el('div', 'scv-native-editor'); view.editor = editor; view.element.append(editor);
    if (view.preview) view.preview.hidden = true;
    const close = btn('结束编辑'); close.classList.add('scv-editor-close'); close.addEventListener('click', finishDocumentEditors, { signal: lifetime.signal }); view.element.append(close);
    try { view.editorCleanup = options.onEditDocument(item.id, editor); }
    catch (error) { finishDocumentEditors(); setStatus(error instanceof Error ? error.message : '无法打开原生编辑器', 'error'); }
  }
  function renderMedia(view: NodeView, item: Extract<CanvasNode, { kind: 'file' | 'link' }>): void {
    const signature = JSON.stringify(item); if (!view.preview || signature === view.signature) return;
    view.signature = signature; view.preview.replaceChildren();
    const raw = item.kind === 'file' ? item.file : item.url; const url = item.kind === 'file' && item.unresolved ? undefined : safeCanvasUrl(raw, item.kind === 'link');
    view.title.textContent = item.kind === 'file' ? item.name || raw.split('/').pop() || '附件' : item.title || (url ? new URL(url).hostname : '网页');
    if (!url) { view.preview.append(el('p', 'scv-preview-message', item.kind === 'file' ? `资源待导入：${raw}` : `链接不可用：${raw}`)); return; }
    const link = el('a', 'scv-resource-link', item.kind === 'file' ? '打开附件' : '在外部打开'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const address = el('p', 'scv-resource-address', raw);
    if (item.kind === 'file') {
      const media = item.mediaType || (/\.(png|jpe?g|gif|webp|svg|avif)(?:[?#]|$)/i.test(raw) ? 'image' : /\.(mp4|webm|mov)(?:[?#]|$)/i.test(raw) ? 'video' : /\.(mp3|wav|ogg|m4a)(?:[?#]|$)/i.test(raw) ? 'audio' : 'file');
      if (media === 'image') { const image = el('img', 'scv-media-image'); image.src = url; image.alt = item.name || raw; image.draggable = false; image.addEventListener('error', () => { image.replaceWith(el('p', 'scv-preview-error', '图片暂时无法加载，请打开附件检查')); }, { signal: lifetime.signal }); view.preview.append(image); }
      else if (media === 'video' || media === 'audio') { const player = el(media, 'scv-media-player'); player.src = url; player.controls = true; player.preload = 'metadata'; view.preview.append(player); }
      else view.preview.append(el('p', 'scv-preview-message', /\.pdf(?:[?#]|$)/i.test(raw) ? 'PDF 文档，点击打开查看' : '附件，点击打开查看'));
    } else {
      const preview = btn('网页预览'); preview.setAttribute('aria-pressed', 'false');
      preview.addEventListener('click', () => {
        const existing = view.preview!.querySelector('iframe'); if (existing) { existing.remove(); preview.setAttribute('aria-pressed', 'false'); return; }
        if (new URL(url).origin === location.origin) { setStatus('为保护笔记，当前思源地址只支持在外部打开，不在画布嵌入', 'error'); return; }
        const frame = el('iframe', 'scv-web-frame'); frame.src = url; frame.title = item.title || url; frame.sandbox.add('allow-scripts', 'allow-forms'); frame.referrerPolicy = 'no-referrer';
        view.preview!.append(frame); preview.setAttribute('aria-pressed', 'true');
      }, { signal: lifetime.signal }); view.preview.append(preview, el('p', 'scv-preview-message', '部分站点禁止嵌入；可随时在外部打开。'));
    }
    view.preview.append(address, link);
  }
  function edgePoints(from: CanvasNode, to: CanvasNode, edge?: CanvasEdge): [Point, Point] {
    if (edge?.fromSide || edge?.toSide) return [portPoint(from, edge.fromSide || nearestSide(from, { x: to.x + to.width / 2, y: to.y + to.height / 2 })), portPoint(to, edge.toSide || nearestSide(to, { x: from.x + from.width / 2, y: from.y + from.height / 2 }))];
    const a = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const b = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    const dx = b.x - a.x; const dy = b.y - a.y;
    const aScale = 1 / Math.max(Math.abs(dx) / (from.width / 2), Math.abs(dy) / (from.height / 2), .0001);
    const bScale = 1 / Math.max(Math.abs(dx) / (to.width / 2), Math.abs(dy) / (to.height / 2), .0001);
    return [{ x: a.x + dx * aScale, y: a.y + dy * aScale }, { x: b.x - dx * bScale, y: b.y - dy * bScale }];
  }
  function edgePath(a: Point, b: Point): string {
    const bend = Math.max(45, Math.abs(b.x - a.x) * .4); const direction = b.x >= a.x ? 1 : -1;
    return `M ${a.x} ${a.y} C ${a.x + bend * direction} ${a.y}, ${b.x - bend * direction} ${b.y}, ${b.x} ${b.y}`;
  }
  function positionEdges(): void {
    if (!scene) return;
    const visibility = canvasVisibility(scene);
    for (const edge of scene.edges) {
      const from = visibility.representative.get(edge.from); const to = visibility.representative.get(edge.to); const view = edgeViews.get(edge.id);
      if (!from || !to || !view) continue;
      const hidden = from.id === to.id && (from.id !== edge.from || to.id !== edge.to);
      view.group.style.display = hidden ? 'none' : '';
      if (hidden) { view.from.style.display = 'none'; view.to.style.display = 'none'; continue; }
      const [a, b] = edgePoints(from, to, edge); view.path.setAttribute('d', edge.fromSide || edge.toSide ? curve(a, b, edge.fromSide, edge.toSide) : edgePath(a, b));
      view.text.setAttribute('x', String((a.x + b.x) / 2)); view.text.setAttribute('y', String((a.y + b.y) / 2 - 8));
      view.from.setAttribute('cx', String(a.x)); view.from.setAttribute('cy', String(a.y)); view.to.setAttribute('cx', String(b.x)); view.to.setAttribute('cy', String(b.y));
      view.from.style.display = edge.id === selectedEdge && !readOnly() ? '' : 'none'; view.to.style.display = view.from.style.display;
    }
  }
  function syncEdges(): void {
    if (!scene) return;
    const valid = scene.edges.filter(edge => node(edge.from) && node(edge.to)); const ids = new Set(valid.map(edge => edge.id));
    for (const [id, view] of edgeViews) if (!ids.has(id)) { view.group.remove(); view.from.remove(); view.to.remove(); edgeViews.delete(id); }
    for (const edge of valid) {
      let view = edgeViews.get(edge.id);
      if (!view) {
        const group = svg('g', { class: 'scv-edge', 'data-edge-id': edge.id });
        const path = svg('path', { class: 'scv-edge-path', 'marker-end': `url(#${markerId})` });
        const text = svg('text', { class: 'scv-edge-label', 'text-anchor': 'middle' });
        const from = svg('circle', { class: 'scv-edge-handle', r: '7', 'data-edge-end': 'from', 'data-edge-id': edge.id });
        const to = svg('circle', { class: 'scv-edge-handle', r: '7', 'data-edge-end': 'to', 'data-edge-id': edge.id });
        group.append(path, text); connectionHandles.append(from, to); edgeLayer.append(group);
        view = { group, path, text, from, to }; edgeViews.set(edge.id, view);
      }
      view.group.dataset.color = edge.color; view.text.textContent = edge.label;
      view.path.style.stroke = edge.color.startsWith('#') ? edge.color : '';
      view.path.setAttribute('marker-start', edge.fromEnd === 'arrow' ? `url(#${markerId})` : 'none');
      view.path.setAttribute('marker-end', edge.toEnd === 'none' ? 'none' : `url(#${markerId})`);
    }
    positionEdges();
  }
  function restore(next: CanvasScene): void {
    if (!scene) return;
    const revision = scene.revision; const updatedAt = scene.updatedAt;
    scene = clone(next); scene.revision = revision; scene.updatedAt = updatedAt;
    selected = new Set([...selected].filter(id => node(id))); selectedEdge = undefined;
    syncNodes(); syncEdges(); updateViewport(); updateSelection(); setBoards(boards); emit();
  }
  function undoAction(): void {
    if (!mutable() || !scene || !past.length) return;
    finishDocumentEditors(); finishNotes();
    textSession = undefined; future.push(clone(scene)); restore(past.pop()!);
  }
  function redoAction(): void {
    if (!mutable() || !scene || !future.length) return;
    finishDocumentEditors(); finishNotes();
    textSession = undefined; past.push(clone(scene)); restore(future.pop()!);
  }
  function selectNode(id: string, additive = false): void {
    selectedEdge = undefined;
    if (additive) { if (selected.has(id)) selected.delete(id); else selected.add(id); }
    else if (!selected.has(id)) selected = new Set([id]);
    updateSelection();
    positionEdges();
  }
  function expandedSelection(): Set<string> {
    const ids = new Set(selected); let added = true;
    while (added) {
      added = false;
      const groups = scene?.nodes.filter(item => item.kind === 'group' && ids.has(item.id)) || [];
      for (const item of scene?.nodes || []) if (!ids.has(item.id) && (item.groupId && ids.has(item.groupId) || groups.some(group =>
        item.x >= group.x && item.y >= group.y + 24 && item.x + item.width <= group.x + group.width && item.y + item.height <= group.y + group.height))) {
        ids.add(item.id); added = true;
      }
    }
    return ids;
  }
  function removeSelection(): void {
    edit(() => {
      if (!scene) return;
      const ids = new Set(selected);
      scene.nodes = scene.nodes.filter(item => !ids.has(item.id));
      for (const item of scene.nodes) if (item.groupId && ids.has(item.groupId)) delete item.groupId;
      scene.edges = scene.edges.filter(edge => edge.id !== selectedEdge && !ids.has(edge.from) && !ids.has(edge.to));
      selected.clear(); selectedEdge = undefined;
    });
  }
  function recolor(color: NodeColor): void {
    edit(() => {
      if (!scene) return;
      for (const item of scene.nodes) if (selected.has(item.id)) item.color = color;
      for (const edge of scene.edges) if (edge.id === selectedEdge) edge.color = color;
    });
  }
  function groupSelection(): void {
    if (!mutable()) return;
    const members = scene!.nodes.filter(item => selected.has(item.id));
    if (!members.length) { const center = getCenter(); edit(() => { const id = uid('group'); scene!.nodes.push({ id, kind: 'group', title: '分组', x: center.x - 240, y: center.y - 180, width: 480, height: 360, color: 'neutral' }); selected = new Set([id]); }); return; }
    const x = Math.min(...members.map(item => item.x)) - 24; const y = Math.min(...members.map(item => item.y)) - 44;
    const width = Math.max(...members.map(item => item.x + item.width)) - x + 24;
    const height = Math.max(...members.map(item => item.y + item.height)) - y + 24;
    edit(() => {
      const id = uid('group'); scene!.nodes.push({ id, kind: 'group', title: '分组', x, y, width, height, color: 'neutral' });
      for (const item of members) item.groupId = id;
      selected = new Set([id]); selectedEdge = undefined;
    });
  }
  function addText(at = getCenter(), editNow = true): string {
    if (!mutable()) return '';
    const center = at; let id = '';
    edit(() => {
      id = uid('text'); scene!.nodes.push({ id, kind: 'text', text: '', x: center.x - 150, y: center.y - 100, width: 300, height: 200, color: 'orange' });
      selected = new Set([id]); selectedEdge = undefined;
    });
    if (editNow) beginNote(id);
    return id;
  }
  function addConnection(from: string, to: string, fromSide?: NodeSide, toSide?: NodeSide): void {
    if (!mutable()) return;
    if (from === to || !node(from) || !node(to)) { setStatus('请选择另一个节点作为连线终点'); return; }
    if (scene?.edges.some(edge => edge.from === from && edge.to === to)) { setStatus('这两个节点之间已有同向连线'); return; }
    edit(() => { scene!.edges.push({ id: uid('edge'), from, to, label: '', color: 'neutral', ...(fromSide ? { fromSide } : {}), ...(toSide ? { toSide } : {}) }); });
    setStatus('连线已添加，双击连线可填写说明');
  }
  function requestText(title: string, initial: string, submit: (value: string) => void, maxLength = 300): void {
    closeDialog?.();
    const previousFocus = document.activeElement as HTMLElement | null;
    const overlay = el('div', 'scv-dialog-overlay'); const form = el('form', 'scv-dialog');
    form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.setAttribute('aria-label', title);
    const input = el('input', 'scv-dialog-input'); input.value = initial; input.maxLength = maxLength; input.setAttribute('aria-label', title);
    const buttons = el('div', 'scv-dialog-buttons'); const cancel = btn('取消'); const accept = btn('确定'); accept.type = 'submit';
    buttons.append(cancel, accept); form.append(el('strong', 'scv-dialog-title', title), input, buttons); overlay.append(form); root.append(overlay);
    const dialogLifetime = new AbortController();
    closeDialog = () => { dialogLifetime.abort(); overlay.remove(); closeDialog = undefined; if (previousFocus?.isConnected) previousFocus.focus(); };
    cancel.addEventListener('click', () => closeDialog?.(), { signal: dialogLifetime.signal });
    overlay.addEventListener('pointerdown', event => { if (event.target === overlay) closeDialog?.(); }, { signal: dialogLifetime.signal });
    form.addEventListener('submit', event => { event.preventDefault(); const value = input.value.trim(); closeDialog?.(); submit(value); }, { signal: dialogLifetime.signal });
    form.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDialog?.(); }
      if (event.key === 'Tab') {
        const focusables = [input, cancel, accept]; const index = focusables.indexOf(document.activeElement as HTMLInputElement);
        if (event.shiftKey && index === 0) { event.preventDefault(); accept.focus(); }
        else if (!event.shiftKey && index === 2) { event.preventDefault(); input.focus(); }
      }
    }, { signal: dialogLifetime.signal });
    input.focus(); input.select();
  }
  function addWeb(url?: string, at = getCenter()): void {
    if (!mutable()) return;
    if (url === undefined) { requestText('网页地址', 'https://', value => addWeb(value, at), 4000); return; }
    const safe = safeCanvasUrl(url, true); if (!safe) { setStatus('请输入有效的 http 或 https 网页地址', 'error'); return; }
    edit(() => { const id = uid('link'); scene!.nodes.push({ id, kind: 'link', url: safe, x: at.x - 160, y: at.y - 120, width: 320, height: 260, color: 'neutral' }); selected = new Set([id]); });
  }
  function selectionData(): { nodes: CanvasNode[]; edges: CanvasEdge[] } | undefined {
    if (!scene || !selected.size) return;
    const ids = expandedSelection(); return { nodes: structuredClone(scene.nodes.filter(item => ids.has(item.id))), edges: structuredClone(scene.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to))) };
  }
  function copySelection(writeSystem = true): void {
    const data = selectionData(); if (!data) return; clipboard = data; pasteOffset = 0;
    if (writeSystem) void navigator.clipboard?.writeText(JSON.stringify({ format: 'scc-canvas-selection', ...data })).catch(() => setStatus('已复制到当前画布剪贴板；系统剪贴板不可用'));
    setStatus('所选节点和内部连线已复制');
  }
  function pasteSelection(data = clipboard, at?: Point, history = true): Set<string> {
    const result = new Set<string>(); if (!data || !mutable()) return result;
    const box = bounds(data.nodes); if (!box) return result;
    const offset = at ? { x: at.x - box.x, y: at.y - box.y } : { x: 32 * ++pasteOffset, y: 32 * pasteOffset };
    const ids = new Map(data.nodes.map(item => [item.id, uid(item.kind)]));
    const action = () => {
      for (const source of data.nodes) { const item = structuredClone(source); item.id = ids.get(source.id)!; item.x += offset.x; item.y += offset.y; if (item.groupId && ids.has(item.groupId)) item.groupId = ids.get(item.groupId); scene!.nodes.push(item); result.add(item.id); }
      for (const source of data.edges) if (ids.has(source.from) && ids.has(source.to)) scene!.edges.push({ ...structuredClone(source), id: uid('edge'), from: ids.get(source.from)!, to: ids.get(source.to)! });
      selected = result; selectedEdge = undefined; updateGroupMembership(scene!, result);
    };
    if (history) edit(action); else { action(); syncNodes(); syncEdges(); updateSelection(); }
    return result;
  }
  function duplicateSelection(): void { const data = selectionData(); if (data) pasteSelection(data); }
  function arrange(kind: Arrangement | 'tree-right' | 'tree-down'): void {
    if (kind === 'tree-right' || kind === 'tree-down') {
      edit(() => { scene!.nodes = layoutTree(scene!, selected, kind === 'tree-right' ? 'right' : 'down').nodes; }); fitAll(); return;
    }
    if (selected.size < 2) { setStatus('请先选择至少两张卡片'); return; }
    edit(() => { const members = scene!.nodes.filter(item => selected.has(item.id)); arrangeNodes(members, kind); updateGroupMembership(scene!, new Set(members.map(item => item.id))); });
  }
  function toggleGroup(id: string): void { edit(() => { const item = node(id); if (item?.kind === 'group') item.collapsed = !item.collapsed; }); }
  function focusNode(id: string): void {
    if (!scene || !node(id)) { setStatus('目标卡片已不存在'); return; }
    const parents: string[] = []; const seen = new Set([id]); let current = node(id);
    while (current?.groupId && !seen.has(current.groupId)) { seen.add(current.groupId); current = node(current.groupId); if (current?.kind === 'group' && current.collapsed) parents.push(current.id); }
    if (parents.length && !readOnly()) edit(() => { for (const id of parents) { const parent = node(id); if (parent?.kind === 'group') parent.collapsed = false; } });
    const target = canvasVisibility(scene).representative.get(id) || node(id)!;
    selected = new Set([target.id]); selectedEdge = undefined; updateSelection(); fitNodes([target]);
  }
  function settingsDialog(): void {
    if (!scene) return; closeDialog?.(); closeMenu?.();
    const overlay = el('div', 'scv-dialog-overlay'); const panel = el('form', 'scv-dialog'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '画布设置');
    const controls = new Map<string, HTMLInputElement>();
    for (const [key, label, defaultValue] of [['snapToGrid', '网格吸附', false], ['snapToObjects', '对象吸附', true], ['readOnly', '只读画布', false]] as const) {
      const row = el('label', 'scv-setting-row', label); const input = el('input', ''); input.type = 'checkbox'; input.setAttribute('aria-label', label); input.checked = scene.settings?.[key] ?? defaultValue;
      row.append(input); controls.set(key, input); panel.append(row);
    }
    const apply = btn('应用'); apply.type = 'submit'; const cancel = btn('取消'); panel.append(cancel, apply); overlay.append(panel); root.append(overlay);
    const controller = new AbortController(); closeDialog = () => { controller.abort(); overlay.remove(); closeDialog = undefined; stage.focus(); };
    cancel.addEventListener('click', () => closeDialog?.(), { signal: controller.signal });
    panel.addEventListener('submit', event => {
      event.preventDefault(); if (window.siyuan?.config?.readonly || window.siyuan?.isPublish || !scene) { setStatus('工作空间为只读，设置未保存', 'error'); return; }
      const before = clone(scene); finishDocumentEditors(); finishNotes();
      scene.settings = { ...scene.settings, snapToGrid: controls.get('snapToGrid')!.checked, snapToObjects: controls.get('snapToObjects')!.checked, readOnly: controls.get('readOnly')!.checked };
      closeDialog?.(); updateViewport(); updateSelection(); commit(before);
    }, { signal: controller.signal });
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeDialog?.(); } event.stopPropagation(); }, { signal: controller.signal });
    controls.get('snapToGrid')!.focus();
  }
  function showContext(event: MouseEvent): void {
    if (!scene || (event.target instanceof Element && event.target.closest('.scv-native-editor'))) return;
    event.preventDefault(); closeMenu?.();
    const target = event.target instanceof Element ? event.target : null; const nodeId = target?.closest<HTMLElement>('[data-scv-node-id]')?.dataset.scvNodeId;
    const edgeId = target?.closest<SVGElement>('[data-edge-id]')?.dataset.edgeId;
    if (nodeId) { if (!selected.has(nodeId)) selected = new Set([nodeId]); selectedEdge = undefined; }
    else if (edgeId) { selected.clear(); selectedEdge = edgeId; }
    updateSelection(); positionEdges();
    const menu = el('div', 'scv-context-menu'); menu.setAttribute('role', 'menu');
    const rect = root.getBoundingClientRect(); menu.style.left = `${Math.max(0, Math.min(event.clientX - rect.left, rect.width - 235))}px`; menu.style.top = `${Math.max(0, Math.min(event.clientY - rect.top, rect.height - 360))}px`;
    const controller = new AbortController(); closeMenu = () => { controller.abort(); menu.remove(); closeMenu = undefined; };
    const action = (label: string, callback: () => void, modifies = true) => {
      const button = btn(label); button.setAttribute('role', 'menuitem'); button.disabled = modifies && readOnly();
      button.addEventListener('click', () => { closeMenu?.(); invoke(callback); }, { signal: controller.signal }); menu.append(button);
    };
    const item = nodeId ? node(nodeId) : undefined; const edge = scene.edges.find(edge => edge.id === edgeId);
    if (edge) {
      action('跳到连线起点', () => focusNode(edge.from), false);
      action('跳到连线终点', () => focusNode(edge.to), false);
      action('沿连线跳转', () => {
        const from = node(edge.from), to = node(edge.to); if (!from || !to) return;
        const position = toWorld(point(event)); const distance = (item: CanvasNode) => Math.hypot(position.x - item.x - item.width / 2, position.y - item.y - item.height / 2);
        focusNode(distance(from) < distance(to) ? edge.to : edge.from);
      }, false);
      action('连线说明', () => requestText('连线说明', edge.label, value => edit(() => { edge.label = value; }), 1000));
      action('反转连线', () => edit(() => { [edge.from, edge.to] = [edge.to, edge.from]; [edge.fromSide, edge.toSide] = [edge.toSide, edge.fromSide]; [edge.fromEnd, edge.toEnd] = [edge.toEnd || 'arrow', edge.fromEnd || 'none']; }));
      action('无箭头', () => edit(() => { edge.fromEnd = 'none'; edge.toEnd = 'none'; }));
      action('单向箭头', () => edit(() => { edge.fromEnd = 'none'; edge.toEnd = 'arrow'; }));
      action('双向箭头', () => edit(() => { edge.fromEnd = 'arrow'; edge.toEnd = 'arrow'; }));
      action('删除连线', removeSelection);
    } else if (item) {
      if (item.kind === 'doc') {
        action('打开原文档', () => options.onOpenDocument(item.docId), false);
        if (options.onReferences) action('查看画布反向引用', () => options.onReferences!(item.docId), false);
        if (!options.inline) action('在卡片内编辑', () => beginDocument(item.id));
        action('限制到标题或块', () => requestText('文档片段（#标题 或 #^块ID）', item.subpath || '', value => edit(() => { item.subpath = value || undefined; const view = nodeViews.get(item.id); if (view) view.signature = undefined; }), 1000));
        if (options.onSwapDocument) action('替换文档', () => options.onSwapDocument!(item.id));
      }
      if (item.kind === 'text') { action('编辑便签', () => beginNote(item.id)); if (options.onConvertText) action('转换为思源文档', () => options.onConvertText!(item.id)); }
      if (item.kind === 'group') {
        action(item.collapsed ? '展开分组' : '折叠分组', () => toggleGroup(item.id));
        action('分组名称', () => requestText('分组名称', item.title, value => edit(() => { item.title = value; })));
        action('分组背景', () => requestText('背景图片地址（assets/或https）', item.background || '', value => { if (value && !safeCanvasUrl(value)) { setStatus('背景地址无效', 'error'); return; } edit(() => { item.background = value || undefined; }); }, 4000));
        for (const [style, label] of [['cover', '背景填充'], ['ratio', '背景等比'], ['repeat', '背景平铺']] as const) action(label, () => edit(() => { item.backgroundStyle = style; }));
      }
      if (item.kind === 'file') action(item.unresolved ? '导入待关联附件' : '替换附件', () => chooseMedia(item.id));
      if (item.kind === 'file' && item.unresolved && options.onSwapDocument) action('关联思源文档', () => options.onSwapDocument!(item.id));
      action('复制所选', copySelection, false); action('复制一份', duplicateSelection); action('分组所选', groupSelection); action('移除所选', removeSelection);
      for (const [kind, label] of layouts.slice(1)) action(label, () => arrange(kind as Arrangement));
    } else {
      const at = toWorld(point(event)); action('添加便签', () => { addText(at); }); action('添加网页', () => addWeb(undefined, at)); action('添加附件', () => chooseMedia()); action('新建空分组', () => { selected.clear(); groupSelection(); });
      action('粘贴画布节点', () => { pasteSelection(clipboard, at); });
    }
    action('适应全部', fitAll, false); if (selected.size) action('适应选择', () => fitNodes(scene!.nodes.filter(item => selected.has(item.id))), false); action('画布设置', settingsDialog, false);
    root.append(menu); menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    document.addEventListener('pointerdown', e => { if (!(e.target instanceof Node) || !menu.contains(e.target)) closeMenu?.(); }, { capture: true, signal: controller.signal });
    menu.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu?.(); e.stopPropagation(); }, { signal: controller.signal });
  }
  function zoomAt(value: number, local: Point): void {
    if (!scene) return;
    const anchor = toWorld(local); const zoom = Math.max(.15, Math.min(3, value));
    scene.viewport = { x: local.x - anchor.x * zoom, y: local.y - anchor.y * zoom, zoom }; updateViewport();
  }
  function zoomButton(factor: number): void {
    if (!scene) return;
    zoomAt(scene.viewport.zoom * factor, { x: stage.clientWidth / 2, y: stage.clientHeight / 2 }); emit();
  }
  function fitAll(): void {
    if (scene) fitNodes(canvasVisibility(scene).nodes);
  }
  function fitNodes(nodes: CanvasNode[]): void {
    if (!scene || !nodes.length) return;
    const representatives = canvasVisibility(scene).representative;
    nodes = [...new Map(nodes.map(node => { const visible = representatives.get(node.id) || node; return [visible.id, visible] as const; })).values()];
    const minX = Math.min(...nodes.map(item => item.x)); const minY = Math.min(...nodes.map(item => item.y));
    const maxX = Math.max(...nodes.map(item => item.x + item.width)); const maxY = Math.max(...nodes.map(item => item.y + item.height));
    const zoom = Math.max(.15, Math.min(1.5, (stage.clientWidth - 100) / Math.max(1, maxX - minX), (stage.clientHeight - 100) / Math.max(1, maxY - minY)));
    scene.viewport = { x: (stage.clientWidth - (maxX - minX) * zoom) / 2 - minX * zoom, y: (stage.clientHeight - (maxY - minY) * zoom) / 2 - minY * zoom, zoom };
    updateViewport(); emit();
  }
  function startGesture(type: Gesture['type'], event: PointerEvent, extra: Partial<Gesture> = {}): void {
    if (!scene) return;
    gesture = { type, pointer: event.pointerId, start: point(event), before: clone(scene), ...extra };
    stage.setPointerCapture(event.pointerId); stage.classList.toggle('scv-panning', type === 'pan'); event.preventDefault();
  }
  function cancelGesture(): void {
    if (!gesture || !scene) return;
    const { revision, updatedAt } = scene;
    scene = gesture.before; scene.revision = revision; scene.updatedAt = updatedAt;
    gesture = undefined; pendingEdge.style.display = 'none'; marquee.hidden = true;
    stage.classList.remove('scv-panning'); syncNodes(); positionEdges(); updateViewport(); updateSelection();
  }

  stage.addEventListener('pointerdown', event => {
    if (!scene || closeDialog || (event.button !== 0 && event.button !== 1)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.scv-native-editor,.scv-node-tools,.scv-editor-close,a,video,audio,iframe')) return;
    closeMenu?.();
    if (target?.closest('.scv-zoom-tools')) return;
    if (event.button === 1 || (space && !editing(event.target))) { stage.focus({ preventScroll: true }); startGesture('pan', event); return; }
    const card = target?.closest<HTMLElement>('.scv-node'); const id = card?.dataset.scvNodeId;
    const edge = target?.closest<SVGElement>('[data-edge-id]');
    const edgeEnd = target?.closest<SVGElement>('[data-edge-end]')?.dataset.edgeEnd as 'from' | 'to' | undefined;
    if (edgeEnd && edge?.dataset.edgeId && mutable()) { startGesture('reconnect', event, { edgeId: edge.dataset.edgeId, edgeEnd }); return; }
    if (edge) { selected.clear(); selectedEdge = edge.dataset.edgeId; updateSelection(); stage.focus({ preventScroll: true }); event.stopPropagation(); return; }
    if (id) {
      if (editing(event.target)) { selectNode(id, false); return; }
      if (connectMode && !target?.closest('.scv-node-resize')) {
        if (!connectFrom) { connectFrom = id; setStatus('选择连线终点，Esc 取消'); }
        else { addConnection(connectFrom, id); connectFrom = undefined; }
        updateSelection(); event.preventDefault(); return;
      }
      if (target?.closest('.scv-node-port')) {
        if (!mutable()) return;
        connectFrom = id; updateSelection(); pendingEdge.style.display = ''; startGesture('connect', event, { nodeId: id, side: target.closest<HTMLElement>('.scv-node-port')?.dataset.side as NodeSide }); return;
      }
      if (target?.closest('.scv-node-resize')) {
        if (!mutable()) return;
        selectNode(id); startGesture('resize', event, { nodeId: id }); return;
      }
      if (target?.closest('.scv-node-header')) {
        stage.focus({ preventScroll: true }); selectNode(id, event.shiftKey && !selected.has(id));
        if (!selected.has(id)) return;
        if (!mutable()) return;
        const before = clone(scene);
        if (event.altKey) { const data = selectionData(); const box = data && bounds(data.nodes); if (data && box) pasteSelection(data, { x: box.x, y: box.y }, false); }
        const ids = expandedSelection(); const positions = new Map<string, Point>();
        scene.nodes.forEach(item => { if (ids.has(item.id)) positions.set(item.id, { x: item.x, y: item.y }); });
        startGesture('drag', event, { ids, positions, before }); return;
      }
      selectNode(id, event.shiftKey); return;
    }
    finishNotes(); finishDocumentEditors();
    stage.focus({ preventScroll: true }); selectedEdge = undefined;
    if (event.shiftKey || boxMode) {
      startGesture('marquee', event, { selected: event.shiftKey ? new Set(selected) : new Set() });
      marquee.hidden = false; Object.assign(marquee.style, { left: `${point(event).x}px`, top: `${point(event).y}px`, width: '0px', height: '0px' });
    } else { selected.clear(); updateSelection(); startGesture('pan', event); }
  }, { signal: lifetime.signal });
  stage.addEventListener('pointermove', event => {
    if (!scene || !gesture || gesture.pointer !== event.pointerId) return;
    const current = point(event); const dx = current.x - gesture.start.x; const dy = current.y - gesture.start.y;
    if (gesture.type === 'pan') {
      scene.viewport.x = gesture.before.viewport.x + dx; scene.viewport.y = gesture.before.viewport.y + dy; updateViewport();
    } else if (gesture.type === 'drag') {
      let deltaX = dx / scene.viewport.zoom; let deltaY = dy / scene.viewport.zoom;
      if (event.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) deltaY = 0; else deltaX = 0; }
      const firstId = [...gesture.ids || []][0]; const first = firstId && node(firstId); const original = firstId && gesture.positions?.get(firstId);
      if (first && original && gesture.ids) {
        const snapped = snapDelta(scene, gesture.ids, { ...first, ...original }, deltaX, deltaY); deltaX = snapped.x; deltaY = snapped.y;
        if (event.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) deltaY = 0; else deltaX = 0; }
      }
      for (const item of scene.nodes) {
        const old = gesture.positions?.get(item.id); if (!old) continue;
        item.x = old.x + deltaX; item.y = old.y + deltaY;
        const view = nodeViews.get(item.id); if (view) positionNode(view, item);
      }
      positionEdges();
    } else if (gesture.type === 'resize') {
      const item = node(gesture.nodeId!); const old = gesture.before.nodes.find(item => item.id === gesture!.nodeId);
      if (item && old) {
        item.width = Math.max(item.kind === 'group' ? 180 : 220, Math.min(2400, old.width + dx / scene.viewport.zoom));
        item.height = Math.max(item.kind === 'group' ? 100 : 140, Math.min(2400, old.height + dy / scene.viewport.zoom));
        if (event.shiftKey) { const factor = Math.max(item.width / old.width, item.height / old.height); item.width = old.width * factor; item.height = old.height * factor; }
        if (scene.settings?.snapToGrid) { item.width = Math.max(48, Math.round(item.width / 24) * 24); item.height = Math.max(48, Math.round(item.height / 24) * 24); }
        const view = nodeViews.get(item.id); if (view) positionNode(view, item); positionEdges();
      }
    } else if (gesture.type === 'marquee') {
      const left = Math.min(current.x, gesture.start.x); const top = Math.min(current.y, gesture.start.y);
      Object.assign(marquee.style, { left: `${left}px`, top: `${top}px`, width: `${Math.abs(dx)}px`, height: `${Math.abs(dy)}px` });
      const a = toWorld({ x: left, y: top }); const b = toWorld({ x: left + Math.abs(dx), y: top + Math.abs(dy) });
      selected = new Set(gesture.selected);
      for (const item of scene.nodes) if (item.x <= b.x && item.x + item.width >= a.x && item.y <= b.y && item.y + item.height >= a.y) selected.add(item.id);
      updateSelection();
    } else if (gesture.type === 'connect') {
      const from = node(gesture.nodeId!); if (!from) return;
      const a = portPoint(from, gesture.side || 'right'); pendingEdge.setAttribute('d', curve(a, toWorld(current), gesture.side || 'right', 'left'));
    } else if (gesture.type === 'reconnect') {
      const edge = scene.edges.find(edge => edge.id === gesture!.edgeId); if (!edge) return;
      const fixed = node(gesture.edgeEnd === 'from' ? edge.to : edge.from); if (!fixed) return;
      const a = portPoint(fixed, gesture.edgeEnd === 'from' ? edge.toSide || 'left' : edge.fromSide || 'right');
      pendingEdge.style.display = ''; pendingEdge.setAttribute('d', edgePath(a, toWorld(current)));
    }
  }, { signal: lifetime.signal });
  stage.addEventListener('pointerup', event => {
    if (!gesture || gesture.pointer !== event.pointerId || !scene) return;
    const completed = gesture; gesture = undefined;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    stage.classList.remove('scv-panning'); marquee.hidden = true; pendingEdge.style.display = 'none';
    if (completed.type === 'connect') {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const target = hit?.closest<HTMLElement>('.scv-node');
      const at = toWorld(point(event));
      const portSide = hit?.closest<HTMLElement>('.scv-node-port')?.dataset.side as NodeSide | undefined;
      if (target?.dataset.scvNodeId && root.contains(target)) addConnection(completed.nodeId!, target.dataset.scvNodeId, completed.side, portSide || nearestSide(node(target.dataset.scvNodeId)!, at));
      else if (mutable()) {
        let created = ''; edit(() => { created = uid('text'); scene!.nodes.push({ id: created, kind: 'text', text: '', x: at.x - 100, y: at.y - 70, width: 260, height: 180, color: 'neutral' }); scene!.edges.push({ id: uid('edge'), from: completed.nodeId!, to: created, fromSide: completed.side || 'right', toSide: 'left', label: '', color: 'neutral' }); selected = new Set([created]); }); beginNote(created);
      }
      connectFrom = undefined; updateSelection();
    } else if (completed.type === 'reconnect') {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const target = hit?.closest<HTMLElement>('.scv-node'); const targetId = target?.dataset.scvNodeId;
      if (targetId && node(targetId) && mutable()) edit(() => { const edge = scene!.edges.find(edge => edge.id === completed.edgeId)!; const side = hit?.closest<HTMLElement>('.scv-node-port')?.dataset.side as NodeSide | undefined || nearestSide(node(targetId)!, toWorld(point(event))); if (completed.edgeEnd === 'from') { edge.from = targetId; edge.fromSide = side; } else { edge.to = targetId; edge.toSide = side; } });
    } else if (completed.type !== 'marquee') {
      if (completed.type === 'drag' && completed.ids) updateGroupMembership(scene, completed.ids);
      if (completed.type === 'resize') updateGroupMembership(scene, new Set(scene.nodes.map(item => item.id)));
      commit(completed.before, completed.type !== 'pan');
    }
  }, { signal: lifetime.signal });
  stage.addEventListener('pointercancel', cancelGesture, { signal: lifetime.signal });
  stage.addEventListener('dblclick', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.scv-native-editor,a,button,video,audio,iframe')) return;
    const edgeId = target?.closest<SVGElement>('[data-edge-id]')?.dataset.edgeId;
    if (edgeId) {
      const edge = scene?.edges.find(item => item.id === edgeId);
      if (edge && mutable()) requestText('连线说明', edge.label, value => edit(() => { const current = scene!.edges.find(item => item.id === edgeId); if (current) current.label = value; }), 1000);
      return;
    }
    const header = target?.closest('.scv-node-header'); const id = target?.closest<HTMLElement>('.scv-node')?.dataset.scvNodeId;
    const item = id ? node(id) : undefined;
    if (item?.kind === 'doc') { if (header) invoke(() => options.onOpenDocument(item.docId)); else beginDocument(item.id); }
    else if (item?.kind === 'text') beginNote(item.id);
    else if (item?.kind === 'group' && mutable()) requestText('分组名称', item.title, value => { if (value) edit(() => { const current = node(item.id); if (current?.kind === 'group') current.title = value; }); });
    else if (!item && !target?.closest('.scv-zoom-tools')) addText(toWorld(point(event)));
  }, { signal: lifetime.signal });
  stage.addEventListener('wheel', event => {
    if (!scene || closeDialog) return;
    if (event.target instanceof Element && event.target.closest('.scv-native-editor')) return;
    if (options.inline && !event.ctrlKey && !space && !event.shiftKey) return;
    if (!event.ctrlKey && !space && (event.target instanceof Element && event.target.closest('.scv-node-preview,.scv-note-text,.scv-note-reading'))) return;
    event.preventDefault();
    if (event.ctrlKey || space) zoomAt(scene.viewport.zoom * Math.exp(-event.deltaY * .002), point(event));
    else { scene.viewport.x -= event.deltaX; scene.viewport.y -= event.deltaY; updateViewport(); }
    clearTimeout(wheelTimer); wheelTimer = setTimeout(emit, 180);
  }, { passive: false, signal: lifetime.signal });
  root.addEventListener('keydown', event => {
    if (event.target instanceof Element && event.target.closest('.scv-native-editor')) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishDocumentEditors(); stage.focus({ preventScroll: true }); }
      return;
    }
    if (event.target instanceof HTMLTextAreaElement && (event.key === 'Escape' || (event.ctrlKey || event.metaKey) && event.key === 'Enter')) { event.preventDefault(); finishNotes(); stage.focus(); return; }
    if (closeDialog || editing(event.target)) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); navigation.focusSearch(); }
    else if (event.shiftKey && event.code === 'Digit1') { event.preventDefault(); fitAll(); }
    else if (event.shiftKey && event.code === 'Digit2') { event.preventDefault(); if (scene) fitNodes(scene.nodes.filter(item => selected.has(item.id))); }
    else if (command && event.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) { event.preventDefault(); copySelection(); }
    else if (command && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelection(); }
    else if (command && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); if (event.shiftKey) redoAction(); else undoAction(); }
    else if (command && event.key.toLowerCase() === 'y') { event.preventDefault(); event.stopPropagation(); redoAction(); }
    else if (command && event.key.toLowerCase() === 'a') { event.preventDefault(); selected = new Set(scene?.nodes.map(item => item.id)); selectedEdge = undefined; updateSelection(); }
    else if (command && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); invoke(options.onSave); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); removeSelection(); }
    else if (event.key === ' ') { space = true; stage.classList.add('scv-space-pan'); event.preventDefault(); }
    else if (event.key === 'Escape') { closeMenu?.(); finishNotes(); finishDocumentEditors(); cancelGesture(); connectFrom = undefined; connectMode = false; boxMode = false; connect.setAttribute('aria-pressed', 'false'); marqueeMode.setAttribute('aria-pressed', 'false'); updateSelection(); }
  }, { capture: true, signal: lifetime.signal });
  window.addEventListener('keyup', event => { if (event.key === ' ') { space = false; stage.classList.remove('scv-space-pan'); } }, { signal: lifetime.signal });
  window.addEventListener('blur', () => { space = false; stage.classList.remove('scv-space-pan'); cancelGesture(); }, { signal: lifetime.signal });
  root.addEventListener('focusin', event => {
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    const id = event.target.closest<HTMLElement>('.scv-node')?.dataset.scvNodeId;
    if (id && scene) { if (readOnly()) return; beginNote(id); textSession = { id, checkpointed: false, before: clone(scene) }; }
  }, { signal: lifetime.signal });
  root.addEventListener('focusout', event => { if (event.target instanceof HTMLTextAreaElement) textSession = undefined; }, { signal: lifetime.signal });
  root.addEventListener('input', event => {
    if (!(event.target instanceof HTMLTextAreaElement) || !scene) return;
    if (readOnly()) { event.target.value = (node(event.target.closest<HTMLElement>('.scv-node')?.dataset.scvNodeId || '') as { text?: string })?.text || ''; return; }
    const id = event.target.closest<HTMLElement>('.scv-node')?.dataset.scvNodeId; const item = id ? node(id) : undefined;
    if (item?.kind !== 'text') return;
    if (!textSession || textSession.id !== id) textSession = { id: item.id, checkpointed: false, before: clone(scene) };
    if (!textSession.checkpointed) { checkpoint(textSession.before); textSession.checkpointed = true; }
    item.text = event.target.value; emit();
  }, { signal: lifetime.signal });
  stage.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.scv-native-editor')) return;
    if (!target?.closest('.scv-node-preview,.scv-note-reading,.scv-media-preview')) return;
    const anchor = target.closest<HTMLAnchorElement>('a[href]'); if (!anchor) return;
    const href = anchor.getAttribute('href') || ''; const id = /^siyuan:\/\/blocks\/(\d{14}-[a-z0-9]{7})(?:[?#]|$)/.exec(href)?.[1];
    if (id) { event.preventDefault(); invoke(() => options.onOpenDocument(id)); }
    else if (safeCanvasUrl(href)) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
    else event.preventDefault();
    event.stopPropagation();
  }, { signal: lifetime.signal });
  stage.addEventListener('dragover', event => {
    if (readOnly() || (event.target instanceof Element && event.target.closest('.scv-native-editor'))) return;
    if (event.dataTransfer && ([...event.dataTransfer.types].includes('Files') || [...event.dataTransfer.types].some(type => /^(text\/(plain|html|uri-list)|application\/(?:x-siyuan|siyuan-documents|siyuan-document-tab))$/.test(type)))) {
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; stage.classList.add('scv-drop-target');
    }
  }, { signal: lifetime.signal });
  stage.addEventListener('dragleave', event => { if (!(event.relatedTarget instanceof Node) || !stage.contains(event.relatedTarget)) stage.classList.remove('scv-drop-target'); }, { signal: lifetime.signal });
  stage.addEventListener('drop', event => {
    if (event.target instanceof Element && event.target.closest('.scv-native-editor')) return;
    event.preventDefault(); event.stopPropagation(); stage.classList.remove('scv-drop-target');
    if (!mutable()) return;
    invoke(() => {
      const files = [...event.dataTransfer?.files || []]; if (files.length && options.onAddMedia) { options.onAddMedia(files, toWorld(point(event))); return; }
      const ids = droppedIds(event.dataTransfer);
      if (ids.length) options.onDrop(ids, toWorld(point(event)));
      else { const text = event.dataTransfer?.getData('text/uri-list')?.split('\n').find(line => !line.startsWith('#')) || event.dataTransfer?.getData('text/plain') || ''; if (safeCanvasUrl(text.trim(), true)) addWeb(text.trim(), toWorld(point(event))); else setStatus('请拖入文档、文件或 http(s) 网页地址'); }
    });
  }, { signal: lifetime.signal });
  root.addEventListener('paste', event => {
    if (editing(event.target) || closeDialog || (event.target instanceof Element && event.target.closest('.scv-native-editor'))) return;
    event.preventDefault(); event.stopPropagation(); if (!mutable()) return;
    invoke(() => {
      const files = [...event.clipboardData?.files || []]; if (files.length && options.onAddMedia) { options.onAddMedia(files, getCenter()); return; }
      const text = event.clipboardData?.getData('text/plain') || '';
      try {
        const data = JSON.parse(text); if (data?.format === 'scc-canvas-selection' && scene) {
          const validated = normalizeScene({ ...scene, nodes: data.nodes, edges: data.edges }); pasteSelection(validated, getCenter()); return;
        }
      } catch { /* Ordinary text and URLs are handled below. */ }
      const ids = droppedIds(event.clipboardData); if (ids.length) { options.onDrop(ids, getCenter()); return; }
      if (safeCanvasUrl(text.trim(), true)) { addWeb(text.trim()); return; }
      if (text) { if (text.length > 50000) { setStatus('粘贴文字超过 50000 字符，请先保存为文档', 'error'); return; } const id = addText(getCenter(), false); edit(() => { const item = node(id); if (item?.kind === 'text') item.text = text; }); }
    });
  }, { signal: lifetime.signal });
  stage.addEventListener('contextmenu', showContext, { signal: lifetime.signal });

  boardSelect.addEventListener('change', () => invoke(() => options.onChooseBoard(boardSelect.value)), { signal: lifetime.signal });
  followChildren.addEventListener('click', () => { if (options.onFollowChildren) invoke(options.onFollowChildren); }, { signal: lifetime.signal });
  stopFollowing.addEventListener('click', () => { if (options.onStopFollowing) invoke(options.onStopFollowing); }, { signal: lifetime.signal });
  templates.addEventListener('click', () => { if (options.onTemplates) invoke(options.onTemplates); }, { signal: lifetime.signal });
  references.addEventListener('click', () => { if (!scene || !options.onReferences) return; const item = scene.nodes.find(node => selected.has(node.id) && node.kind === 'doc'); invoke(() => options.onReferences!(item?.kind === 'doc' ? item.docId : scene!.id)); }, { signal: lifetime.signal });
  openCanvas.addEventListener('click', () => { if (options.onOpenCanvas) invoke(options.onOpenCanvas); }, { signal: lifetime.signal });
  boardNew.addEventListener('click', () => invoke(options.onNewBoard), { signal: lifetime.signal });
  openOwner.addEventListener('click', () => { if (scene && DOCUMENT_ID.test(scene.id)) invoke(() => options.onOpenDocument(scene!.id)); }, { signal: lifetime.signal });
  migrateLegacy.addEventListener('click', () => { if (options.onMigrateLegacy) invoke(options.onMigrateLegacy); }, { signal: lifetime.signal });
  boardRename.addEventListener('click', () => { if (scene) requestText('画布名称', scene.title, value => { if (value) invoke(() => options.onRenameBoard(value)); }); }, { signal: lifetime.signal });
  for (const [button, callback] of [[save, options.onSave], [reload, options.onReload], [saveCopy, options.onSaveCopy], [refresh, options.onRefresh], [addDoc, options.onAddDocument], [importChildren, options.onImportChildren]] as const) {
    button.addEventListener('click', () => { if ([addDoc, importChildren].includes(button) && !mutable()) return; invoke(callback); }, { signal: lifetime.signal });
  }
  addNote.addEventListener('click', () => { addText(); }, { signal: lifetime.signal });
  addLink.addEventListener('click', () => addWeb(), { signal: lifetime.signal });
  addMedia.hidden = !options.onAddMedia; importFile.hidden = !options.onImportCanvas;
  addMedia.addEventListener('click', () => { if (mutable()) chooseMedia(); }, { signal: lifetime.signal });
  mediaInput.addEventListener('change', () => { const replacement = pendingMediaReplace; pendingMediaReplace = undefined; if (mutable() && mediaInput.files?.length) options.onAddMedia?.([...mediaInput.files], getCenter(), replacement); mediaInput.value = ''; }, { signal: lifetime.signal });
  mediaInput.addEventListener('cancel', () => { pendingMediaReplace = undefined; mediaInput.value = ''; }, { signal: lifetime.signal });
  importFile.addEventListener('click', () => { if (mutable()) canvasInput.click(); }, { signal: lifetime.signal });
  canvasInput.addEventListener('change', () => { if (mutable() && canvasInput.files?.[0]) options.onImportCanvas?.(canvasInput.files[0]); canvasInput.value = ''; }, { signal: lifetime.signal });
  exportFile.addEventListener('click', () => invoke(() => { if (!scene) return; downloadBlob(new Blob([JSON.stringify(exportJsonCanvas(scene), null, 2)], { type: 'application/json' }), `${scene.title}.canvas`); setStatus('已导出 JSON Canvas 文件'); }), { signal: lifetime.signal });
  exportPng.addEventListener('click', () => {
    if (!scene || exportPng.disabled) return; finishNotes(); finishDocumentEditors(); exportPng.disabled = true; setStatus('正在生成完整 PNG…');
    void canvasPng(clone(scene), world, lifetime.signal).then(blob => { if (!disposed) { downloadBlob(blob, `${scene!.title}.png`); setStatus('PNG 已导出'); } })
      .catch(error => { if (!disposed) setStatus(error instanceof Error ? error.message : 'PNG 导出失败', 'error'); }).finally(() => { exportPng.disabled = false; });
  }, { signal: lifetime.signal });
  customColor.addEventListener('input', () => recolor(customColor.value as NodeColor), { signal: lifetime.signal });
  layout.addEventListener('change', () => { if (layout.value) invoke(() => arrange(layout.value as Arrangement | 'tree-right' | 'tree-down')); layout.value = ''; }, { signal: lifetime.signal });
  settings.addEventListener('click', settingsDialog, { signal: lifetime.signal });
  group.addEventListener('click', groupSelection, { signal: lifetime.signal });
  remove.addEventListener('click', removeSelection, { signal: lifetime.signal });
  undo.addEventListener('click', undoAction, { signal: lifetime.signal }); redo.addEventListener('click', redoAction, { signal: lifetime.signal });
  connect.addEventListener('click', () => {
    connectMode = !connectMode; connectFrom = undefined; connect.setAttribute('aria-pressed', String(connectMode));
    if (connectMode) { boxMode = false; marqueeMode.setAttribute('aria-pressed', 'false'); setStatus('依次点击两个节点连线，Esc 退出'); }
    updateSelection();
  }, { signal: lifetime.signal });
  marqueeMode.addEventListener('click', () => {
    boxMode = !boxMode; marqueeMode.setAttribute('aria-pressed', String(boxMode));
    if (boxMode) { connectMode = false; connectFrom = undefined; connect.setAttribute('aria-pressed', 'false'); setStatus('在空白处拖动框选，Shift 可追加选择'); }
    updateSelection();
  }, { signal: lifetime.signal });
  zoomIn.addEventListener('click', () => zoomButton(1.2), { signal: lifetime.signal });
  zoomOut.addEventListener('click', () => zoomButton(1 / 1.2), { signal: lifetime.signal });
  zoomLabel.addEventListener('click', () => { if (scene) { zoomAt(1, { x: stage.clientWidth / 2, y: stage.clientHeight / 2 }); emit(); } }, { signal: lifetime.signal });
  fit.addEventListener('click', fitAll, { signal: lifetime.signal });
  fitSelected.addEventListener('click', () => { if (scene) fitNodes(scene.nodes.filter(item => selected.has(item.id))); }, { signal: lifetime.signal });
  updateSelection();

  return {
    setScene(next) {
      if (disposed) return;
      if (gesture) cancelGesture();
      const changedBoard = scene?.id !== next.id;
      if (scene && !changedBoard && graphContent(scene) !== graphContent(next)) checkpoint(scene);
      if (changedBoard) {
        clearTimeout(wheelTimer);
        finishDocumentEditors(); closeMenu?.();
        closeDialog?.(); for (const view of nodeViews.values()) { release(view); view.element.remove(); }
        nodeViews = new Map(); selected.clear(); selectedEdge = undefined; past.length = 0; future.length = 0; textSession = undefined; connectFrom = undefined;
      }
      scene = clone(next); selected = new Set([...selected].filter(id => node(id)));
      syncNodes(); syncEdges(); updateViewport(); updateSelection(); updateMeta(); setBoards(boards);
    },
    setRevision(revision, updatedAt) { if (scene && !disposed) { scene.revision = revision; scene.updatedAt = updatedAt; updateMeta(); } },
    setBoards,
    setPreview(docId, payload) {
      if (disposed) return;
      previews.set(docId, payload);
      for (const item of scene?.nodes || []) if (item.kind === 'doc' && (item.docId + '\0' + (item.subpath || '') === docId || item.docId === docId && !item.subpath)) {
        if (payload.doc?.title) item.title = payload.doc.title;
        const view = nodeViews.get(item.id); if (view) updatePreview(view, item);
      }
    },
    setStatus,
    getCenter,
    focusNode,
    dispose() {
      if (disposed) return;
      clearTimeout(wheelTimer); closeMenu?.(); closeDialog?.(); finishDocumentEditors(); disposed = true; lifetime.abort(); gesture = undefined;
      resizeObserver.disconnect(); navigation.dispose();
      for (const view of nodeViews.values()) release(view);
      nodeViews.clear(); edgeViews.clear(); previews.clear(); past.length = 0; future.length = 0; root.remove();
    },
  };
}
