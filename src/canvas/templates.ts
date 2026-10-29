import type { CanvasDocumentStore } from './document-store';
import { canvasRequest, listCanvasNotebooks } from './document-api';
import { createScene, normalizeScene } from './model';
import type { CanvasScene, CanvasTemplate, CanvasTemplates } from './types';
import { canvasDialog } from './dialog';

const TEMPLATE_ATTR = 'custom-scc-template';
const ID = /^\d{14}-[a-z0-9]{7}$/;
function builtin(id: string, name: string, headings: string[]): CanvasTemplate {
  return { id: 'builtin-' + id, name, builtin: true, updatedAt: 0,
    nodes: headings.map((heading, index) => ({ id: `${id}-${index}`, kind: 'text', text: '# ' + heading, x: index * 360, y: 0, width: 300, height: 240, color: index % 2 ? 'green' : 'blue' })),
    edges: headings.slice(1).map((_, index) => ({ id: `${id}-edge-${index}`, from: `${id}-${index}`, to: `${id}-${index + 1}`, label: '', color: 'neutral', fromSide: 'right', toSide: 'left' })),
  };
}
export const BUILTIN_TEMPLATES: CanvasTemplate[] = [
  builtin('concept', '概念与公式推导', ['定义', '前提与假设', '公式推导', '例题', '结论与适用范围']),
  builtin('paper', '论文阅读', ['研究问题', '方法', '实验与证据', '结论与局限']),
  builtin('modules', '模块依赖', ['输入与边界条件', '核心模块', '求解流程', '输出', '参考文档']),
];

/** User templates are native canvas documents, keeping media references and history alive. */
export class CanvasTemplateLibrary implements CanvasTemplates {
  private known = new Set<string>();
  constructor(private store: CanvasDocumentStore) {}
  async list(): Promise<CanvasTemplate[]> {
    const books = await listCanvasNotebooks();
    if (!books.length) return structuredClone(BUILTIN_TEMPLATES);
    const boxes = books.map(book => `'${book.id}'`).join(',');
    const rows = await canvasRequest<{ id: string }[]>('/api/query/sql', {
      stmt: `SELECT b.id FROM blocks b JOIN attributes a ON a.block_id=b.id WHERE b.type='d' AND b.box IN (${boxes}) AND a.name='${TEMPLATE_ATTR}' AND a.value='1' ORDER BY b.updated DESC LIMIT 201`, mode: 'readonly',
    });
    if (!Array.isArray(rows) || rows.length > 200) throw new Error('自定义模板超过 200 张，请在文档中整理模板标记');
    const ids = new Set(rows.map(row => row.id)); const open = new Set(books.map(book => book.id));
    for (const id of this.known) {
      if (ids.has(id)) { this.known.delete(id); continue; }
      try {
        const info = await canvasRequest<{ box: string }>('/api/block/getBlockInfo', { id });
        if (!open.has(info.box)) continue;
        const attrs = await canvasRequest<Record<string, string>>('/api/attr/getBlockAttrs', { id });
        if (attrs[TEMPLATE_ATTR] === '1') ids.add(id); else this.known.delete(id);
      } catch { /* A closed or unindexed document is never recreated. */ }
    }
    const templates = structuredClone(BUILTIN_TEMPLATES);
    for (const id of ids) {
      if (!ID.test(id)) throw new Error('模板文档 ID 无效');
      const attrs = await canvasRequest<Record<string, string>>('/api/attr/getBlockAttrs', { id });
      if (attrs[TEMPLATE_ATTR] !== '1') { this.known.delete(id); continue; }
      const scene = await this.store.load(id);
      templates.push({ id: scene.id, name: scene.title.replace(/^模板：/, ''), updatedAt: scene.updatedAt, nodes: scene.nodes, edges: scene.edges });
    }
    return templates;
  }
  async save(name: string, scene: CanvasScene): Promise<CanvasTemplate> {
    if (!name.trim() || name.trim().length > 280) throw new Error('请输入 1 至 280 个字符的模板名称');
    const snapshot = normalizeScene(scene);
    const info = await canvasRequest<{ rootID: string; box: string; path: string }>('/api/block/getBlockInfo', { id: snapshot.id });
    if (info.rootID !== snapshot.id || !ID.test(info.box)) throw new Error('无法确定模板保存位置');
    const parts = info.path.split('/').filter(Boolean); parts.pop();
    delete snapshot.followParentId; delete snapshot.followExcluded;
    for (const node of snapshot.nodes) if (node.kind === 'doc') { delete node.followedFrom; delete node.detached; }
    const saved = await this.store.copy(snapshot, { notebook: info.box, ...(parts.length ? { parentId: parts[parts.length - 1] } : {}), title: '模板：' + name.trim() });
    await canvasRequest('/api/attr/setBlockAttrs', { id: saved.id, attrs: { [TEMPLATE_ATTR]: '1' } });
    const attrs = await canvasRequest<Record<string, string>>('/api/attr/getBlockAttrs', { id: saved.id });
    if (attrs[TEMPLATE_ATTR] !== '1') throw new Error('模板画布已创建，但模板标记核对失败，请在文档树中检查新建文档');
    this.known.add(saved.id);
    return { id: saved.id, name: name.trim(), updatedAt: saved.updatedAt, nodes: saved.nodes, edges: saved.edges };
  }
  async remove(id: string): Promise<void> {
    if (!ID.test(id)) throw new Error('内置模板不能移除');
    await canvasRequest('/api/attr/setBlockAttrs', { id, attrs: { [TEMPLATE_ATTR]: '' } });
    this.known.delete(id);
  }
}

export function showTemplateLibrary(anchor: HTMLElement, library: CanvasTemplates, options: {
  signal: AbortSignal; snapshot: () => CanvasScene | undefined; apply: (template: CanvasTemplate) => boolean;
}): void {
  const dialog = canvasDialog(anchor, '画布模板', options.signal);
  const select = dialog.doc.createElement('select'); select.setAttribute('aria-label', '选择画布模板');
  const name = dialog.doc.createElement('input'); name.placeholder = '新模板名称'; name.maxLength = 280; name.setAttribute('aria-label', '新模板名称');
  const hint = dialog.doc.createElement('p'); hint.textContent = '添加模板会追加卡片。自定义模板保存为同目录的画布文档；原文与附件引用保持关联。';
  let templates: CanvasTemplate[] = []; let busy = false;
  const work = async (task: () => Promise<void>) => {
    if (busy || dialog.signal.aborted) return; busy = true; dialog.status.textContent = '正在处理…';
    try { await task(); }
    catch (error) { if (!dialog.signal.aborted) dialog.status.textContent = error instanceof Error ? error.message : '模板操作失败'; }
    finally { busy = false; }
  };
  const load = async () => {
    templates = await library.list(); if (dialog.signal.aborted) return;
    select.replaceChildren(...templates.map(template => { const option = dialog.doc.createElement('option'); option.value = template.id; option.textContent = template.name + (template.builtin ? '（内置）' : ''); return option; }));
  };
  const apply = dialog.button('添加到当前画布', () => { const template = templates.find(item => item.id === select.value); if (template && !busy && options.apply(template)) dialog.close(); });
  const save = dialog.button('将当前画布保存为模板', () => { void work(async () => {
    const scene = options.snapshot(); if (!scene) throw new Error('当前画布为只读或已切换');
    const saved = await library.save(name.value, scene); await load(); select.value = saved.id; remove.disabled = false; dialog.status.textContent = '已保存为独立模板文档';
  }); });
  const remove = dialog.button('从模板列表移除', () => { void work(async () => {
    const scene = options.snapshot(); if (!scene) throw new Error('当前画布为只读或已切换');
    await library.remove(select.value); await load(); dialog.status.textContent = '已移除模板标记，画布文档和内容仍保留';
  }); });
  select.addEventListener('change', () => { remove.disabled = !templates.some(item => item.id === select.value && !item.builtin); }, { signal: dialog.signal });
  dialog.panel.append(hint, select, name, apply, save, remove, dialog.button('关闭', dialog.close), dialog.status);
  void work(async () => { await load(); remove.disabled = true; dialog.status.textContent = ''; select.focus(); });
}
