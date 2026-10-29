import type { CanvasScene } from './types';
import { createCanvasThumbnail } from './thumbnail';

export interface CanvasDocumentCardOptions {
  element: HTMLElement;
  scene?: CanvasScene;
  error?: string;
  onOpen: () => void;
  onRefresh?: () => void;
}

/** A document-owned canvas is represented by a small, read-only native block. */
export function createCanvasDocumentCard(options: CanvasDocumentCardOptions): () => void {
  const lifetime = new AbortController();
  const doc = options.element.ownerDocument;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const card = make('section', 'scv-doc-card');
  card.contentEditable = 'false'; card.setAttribute('aria-label', 'Canvas 画布概要');
  const header = make('div', 'scv-doc-card-header');
  const icon = make('span', 'scv-doc-card-icon', '▦'); icon.setAttribute('aria-hidden', 'true');
  const names = make('div', 'scv-doc-card-names');
  names.append(make('span', 'scv-doc-card-kind', 'Canvas 画布'), make('strong', 'scv-doc-card-title', options.scene?.title || '画布数据暂不可读'));
  header.append(icon, names); card.append(header);

  if (options.scene) {
    const counts = make('div', 'scv-doc-card-counts');
    const metrics: [number, string][] = [
      [options.scene.nodes.length, '节点'],
      [options.scene.nodes.filter(node => node.kind === 'doc').length, '文档卡片'],
      [options.scene.nodes.filter(node => node.kind === 'file').length, '附件'],
      [options.scene.nodes.filter(node => node.kind === 'link').length, '网页'],
      [options.scene.edges.length, '连线'],
    ];
    for (const [value, label] of metrics) {
      const count = make('span', 'scv-doc-card-count');
      count.append(make('strong', 'scv-doc-card-value', String(value)), doc.createTextNode(` ${label}`)); counts.append(count);
    }
    card.append(counts);
    const overview = createCanvasThumbnail(doc, options.scene);
    if (overview) card.append(overview);
  }
  card.append(make('p', 'scv-doc-card-description', '画布布局随本文档保存。文档卡片引用原文，移动或移除卡片不会修改原文。'));
  const message = make('p', 'scv-doc-card-message', options.error || '');
  message.hidden = !options.error; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  card.classList.toggle('scv-doc-card-error', Boolean(options.error)); card.append(message);
  const actions = make('div', 'scv-doc-card-actions');
  const open = make('button', 'scv-doc-card-button scv-doc-card-primary', '打开 Canvas'); open.type = 'button';
  const invoke = (callback: () => void) => {
    try { callback(); }
    catch (error) {
      message.textContent = error instanceof Error ? error.message : '操作失败，请重试'; message.hidden = false;
      card.classList.add('scv-doc-card-error');
    }
  };
  open.addEventListener('click', () => invoke(options.onOpen), { signal: lifetime.signal }); actions.append(open);
  if (options.onRefresh) {
    const refresh = make('button', 'scv-doc-card-button', '刷新'); refresh.type = 'button';
    refresh.addEventListener('click', () => invoke(options.onRefresh!), { signal: lifetime.signal }); actions.append(refresh);
  }
  card.append(actions); options.element.append(card);
  return () => { lifetime.abort(); card.remove(); };
}
