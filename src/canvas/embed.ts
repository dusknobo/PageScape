import { canvasDialog } from './dialog';
import type { CanvasStore, CanvasSummary } from './types';

export const CANVAS_REFERENCE_BLOCK = 'canvas-reference';
const ID = /^\d{14}-[a-z0-9]{7}$/;
export function parseCanvasReference(content: string): string {
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('画布引用格式无效');
  const ref = value as Record<string, unknown>;
  if (ref.format !== 'siyuan-child-cards-reference' || ref.version !== 1 || typeof ref.docId !== 'string' || !ID.test(ref.docId)) throw new Error('画布引用版本或文档 ID 无效');
  return ref.docId;
}
export function canvasReferenceMarkdown(plugin: string, docId: string): string {
  if (!ID.test(docId)) throw new Error('画布文档 ID 无效');
  return `;;;${encodeURIComponent(plugin)}/${CANVAS_REFERENCE_BLOCK}\n${JSON.stringify({ format: 'siyuan-child-cards-reference', version: 1, docId })}\n;;;`;
}
export async function chooseCanvasReference(anchor: HTMLElement, store: CanvasStore, signal: AbortSignal, create: () => Promise<string | undefined>): Promise<string | undefined> {
  const dialog = canvasDialog(anchor, '插入或引用 Canvas', signal);
  const search = dialog.doc.createElement('input'); search.type = 'search'; search.placeholder = '搜索已有画布'; search.setAttribute('aria-label', '搜索已有画布');
  const list = dialog.doc.createElement('select'); list.size = 8; list.setAttribute('aria-label', '选择已有画布');
  const hint = dialog.doc.createElement('p'); hint.textContent = '引用同一张画布时，各处共用内容与布局。也可以先新建画布，再插入当前位置。';
  let boards: CanvasSummary[] = []; let chosen: string | undefined; let busy = false;
  const render = () => {
    const query = search.value.trim().toLocaleLowerCase(); const previous = list.value;
    list.replaceChildren(...boards.filter(board => (board.title + ' ' + board.id).toLocaleLowerCase().includes(query)).map(board => { const option = dialog.doc.createElement('option'); option.value = board.id; option.textContent = board.title; return option; }));
    if ([...list.options].some(option => option.value === previous)) list.value = previous;
    else if (list.options.length) list.selectedIndex = 0;
  };
  const insert = () => { if (list.value && !busy) { chosen = list.value; dialog.close(); } };
  search.addEventListener('input', render, { signal: dialog.signal });
  list.addEventListener('dblclick', insert, { signal: dialog.signal });
  list.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); insert(); } }, { signal: dialog.signal });
  dialog.panel.append(hint, search, list, dialog.button('引用所选画布', insert), dialog.button('新建并插入', () => {
    if (busy) return; busy = true;
    void create().then(id => { if (id && !dialog.signal.aborted) { chosen = id; dialog.close(); } }).catch(error => { if (!dialog.signal.aborted) dialog.status.textContent = String(error instanceof Error ? error.message : error); }).finally(() => { busy = false; });
  }), dialog.button('取消', dialog.close), dialog.status);
  try { boards = await store.list(); if (!dialog.signal.aborted) { render(); search.focus(); } }
  catch (error) { dialog.status.textContent = error instanceof Error ? error.message : '画布列表读取失败'; }
  await dialog.closed; return chosen;
}
