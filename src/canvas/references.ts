import { canvasDialog } from './dialog';
import { canvasRequest, listCanvasNotebooks } from './document-api';
import { CANVAS_REFERENCE_BLOCK, parseCanvasReference } from './embed';
import type { CanvasStore } from './types';

export function showCanvasReferences(anchor: HTMLElement, store: CanvasStore, docId: string, options: {
  pluginName: string; signal: AbortSignal; openCanvas: (id: string, nodeId: string) => Promise<void>; openDocument: (id: string) => void;
}): void {
  if (!/^\d{14}-[a-z0-9]{7}$/.test(docId)) return;
  const dialog = canvasDialog(anchor, '画布反向引用', options.signal);
  const list = dialog.doc.createElement('div'); list.className = 'scv-reference-results';
  dialog.panel.append(list, dialog.button('关闭', dialog.close), dialog.status);
  dialog.status.textContent = '正在检查已打开笔记本中的画布…';
  let found = 0, unreadable = 0;
  const add = (label: string, open: () => void) => {
    found++; const button = dialog.button(label, () => { dialog.close(); open(); }); button.classList.add('scv-reference-result'); list.append(button);
  };
  void (async () => {
    const boards = await store.list(); let cursor = 0, checked = 0;
    await Promise.all(Array.from({ length: Math.min(4, boards.length) }, async () => {
      while (cursor < boards.length && !dialog.signal.aborted) {
        const board = boards[cursor++];
        try {
          const scene = await store.load(board.id);
          if (dialog.signal.aborted) return;
          for (const node of scene.nodes) if (node.kind === 'doc' && node.docId === docId) add(`${scene.title} → ${node.title || '文档卡片'}`, () => { void options.openCanvas(scene.id, node.id); });
        } catch { unreadable++; }
        checked++; if (!dialog.signal.aborted) dialog.status.textContent = `已检查 ${checked}/${boards.length} 张画布，找到 ${found} 个引用`;
      }
    }));
    if (dialog.signal.aborted) return;
    const books = await listCanvasNotebooks();
    if (books.length) {
      const boxes = books.map(book => `'${book.id}'`).join(',');
      const rows = await canvasRequest<{ id: string; root_id: string; title: string }[]>('/api/query/sql', {
        stmt: `SELECT c.id,c.root_id,r.content AS title FROM blocks c JOIN blocks r ON r.id=c.root_id WHERE c.box IN (${boxes}) AND c.markdown LIKE '%/${CANVAS_REFERENCE_BLOCK}%' AND c.markdown LIKE '%${docId}%' ORDER BY c.updated DESC LIMIT 10001`, mode: 'readonly',
      }, dialog.signal);
      if (!Array.isArray(rows) || rows.length > 10000) throw new Error('嵌入引用过多，请缩小笔记本范围后重试');
      for (const row of rows) {
        if (dialog.signal.aborted) return;
        if (!/^\d{14}-[a-z0-9]{7}$/.test(row.id) || !/^\d{14}-[a-z0-9]{7}$/.test(row.root_id)) continue;
        try {
          const block = await canvasRequest<{ kramdown: string }>('/api/block/getBlockKramdown', { id: row.id }, dialog.signal);
          const lines = block.kramdown.split('\n');
          if (lines[0]?.trim() !== `;;;${encodeURIComponent(options.pluginName)}/${CANVAS_REFERENCE_BLOCK}`) continue;
          const end = lines.findIndex((line, index) => index > 0 && line.trim() === ';;;');
          if (end > 0 && parseCanvasReference(lines.slice(1, end).join('\n')) === docId) add(`${row.title || '未命名文档'}（嵌入画布）`, () => options.openDocument(row.root_id));
        } catch { unreadable++; }
      }
    }
    if (!dialog.signal.aborted) dialog.status.textContent = `${found ? `找到 ${found} 个引用` : '已打开笔记本中未找到引用'}${unreadable ? `；${unreadable} 项暂不可读，结果可能不完整` : ''}`;
  })().catch(error => { if (!dialog.signal.aborted) dialog.status.textContent = `检查未完成：${error instanceof Error ? error.message : String(error)}`; });
}
