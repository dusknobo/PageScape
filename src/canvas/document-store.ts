import { createScene, newCanvasId, normalizeScene } from './model';
import { CanvasConflictError, CanvasStorageError } from './storage';
import { canvasRequest, listCanvasNotebooks } from './document-api';
import { verifyCanvasAssetAttributes, withCanvasAssetAttributes } from './assets';
import { CANVAS_DOCUMENT_ATTR, CANVAS_LEGACY_ATTR, SIYUAN_ID, canvasDocumentContent, canvasDocumentMarkdown, extractCanvasDocumentContent, parseCanvasDocument } from './document-format';
import type { CanvasDocumentPayload } from './document-format';
import type { CanvasDestination, CanvasScene, CanvasStore, CanvasSummary } from './types';

type Request = <T>(route: string, body?: Record<string, unknown>) => Promise<T>;
interface Info { rootID: string; rootTitle: string; box: string; path: string }
interface Stored { info: Info; blockId: string; content: string; payload: CanvasDocumentPayload; scene: CanvasScene }
function blockAttributes(blockId: string, markers: { legacyId?: string }, extra: Record<string, string> = {}): string {
  const attrs = { ...extra, id: blockId, [CANVAS_DOCUMENT_ATTR]: '1', ...(markers.legacyId ? { [CANVAS_LEGACY_ATTR]: markers.legacyId } : {}) };
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
  return `{: ${Object.entries(attrs).filter(([name]) => /^[a-zA-Z0-9_-]+$/.test(name)).map(([name, value]) => `${name}="${escape(String(value))}"`).join(' ')}}`;
}
const queues = new Map<string, Promise<void>>();
function id(value: string): string { if (!SIYUAN_ID.test(value)) throw new Error('画布文档 ID 无效'); return value; }
function literal(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
const readonly = () => Boolean(typeof window !== 'undefined' && (window.siyuan?.config?.readonly || window.siyuan?.isPublish));
function requireWritable(): void { if (readonly()) throw new Error('当前工作空间为只读，无法保存画布文档'); }
function epoch(value: string): number {
  if (!/^\d{14}$/.test(value)) return 0;
  return new Date(+value.slice(0, 4), +value.slice(4, 6) - 1, +value.slice(6, 8), +value.slice(8, 10), +value.slice(10, 12), +value.slice(12, 14)).getTime();
}
async function lock<T>(key: string, action: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(`scc-document:${key}`, action);
  const previous = queues.get(key) || Promise.resolve(); const next = previous.catch(() => {}).then(action);
  const marker = next.then(() => {}, () => {}); queues.set(key, marker);
  try { return await next; } finally { if (queues.get(key) === marker) queues.delete(key); }
}
async function fingerprint(content: string, docId: string, title: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${docId}\0${title}\0${content}`);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Every board is carried by a native document; no live scene is written to plugin JSON. */
export class CanvasDocumentStore implements CanvasStore {
  private known = new Set<string>();
  constructor(private pluginName: string, private request: Request = canvasRequest,
    private notebooks = listCanvasNotebooks, private legacyAlias?: (oldId: string) => Promise<string | undefined>) {}

  allocateDocId(): string {
    const date = new Date(); const two = (n: number) => String(n).padStart(2, '0');
    const stamp = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
    return `${stamp}-${newCanvasId().replace(/-/g, '').slice(0, 7)}`;
  }

  async list(): Promise<CanvasSummary[]> {
    const books = await this.notebooks(); if (!books.length) return [];
    const boxes = books.map(book => literal(id(book.id))).join(',');
    const rows = await this.request<{ id: string; content: string; updated: string }[]>('/api/query/sql', {
      stmt: `SELECT DISTINCT r.id,r.content,r.updated FROM blocks r JOIN blocks c ON c.root_id=r.id JOIN attributes a ON a.block_id=c.id WHERE r.type='d' AND r.box IN (${boxes}) AND a.name='${CANVAS_DOCUMENT_ATTR}' AND a.value='1' ORDER BY r.updated DESC LIMIT 10001`, mode: 'readonly',
    });
    if (!Array.isArray(rows) || rows.length > 10000) throw new Error('画布文档列表过大或格式无效，请分笔记本管理');
    const result = new Map<string, CanvasSummary>();
    for (const row of rows) result.set(id(row.id), { id: row.id, title: row.content || '未命名画布', updatedAt: epoch(row.updated) });
    // Newly-created documents may precede the SQL index. Include their verified metadata.
    for (const known of this.known) if (!result.has(known)) {
      try { const data = await this.read(known); result.set(known, { id: known, title: data.scene.title, updatedAt: data.scene.updatedAt }); }
      catch { this.known.delete(known); /* A deleted/locked document is never recreated. */ }
    }
    return [...result.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  async load(boardId: string, expectedLegacyId?: string): Promise<CanvasScene> {
    let docId = boardId;
    if (!SIYUAN_ID.test(docId)) {
      docId = await this.legacyAlias?.(boardId) || '';
      if (!docId) throw new Error('此画布仍保存在旧 JSON 中，请点击“迁移旧画布”后打开');
    }
    const stored = await this.read(id(docId));
    if (expectedLegacyId && stored.payload.legacyId !== expectedLegacyId) throw new Error('文档的迁移标记不匹配，未修改该文档');
    return stored.scene;
  }

  private async read(docId: string): Promise<Stored> {
    const info = await this.request<Info>('/api/block/getBlockInfo', { id: id(docId) });
    if (info.rootID !== docId || !SIYUAN_ID.test(info.box)) throw new Error('请选择普通思源画布文档');
    const found: { blockId: string; content: string }[] = []; const seen = new Set<string>();
    const visit = async (parent: string, depth: number): Promise<void> => {
      if (depth > 12 || seen.size > 2000) throw new Error('画布块嵌套过深，未修改文档');
      const children = await this.request<{ id: string; type: string }[]>('/api/block/getChildBlocks', { id: parent });
      if (!Array.isArray(children)) throw new Error('文档块列表无效');
      for (const child of children) {
        if (seen.has(child.id)) throw new Error('文档块 ID 重复，未修改文档'); seen.add(id(child.id));
        if (['custom_b', 'custom', 'custom-block', 'NodeCustomBlock'].includes(child.type)) {
          const block = await this.request<{ kramdown: string }>('/api/block/getBlockKramdown', { id: child.id });
          const content = extractCanvasDocumentContent(block.kramdown, this.pluginName);
          if (content !== undefined) found.push({ blockId: child.id, content });
        } else if (['l', 'i', 'b', 's', 'list', 'list-item', 'blockquote', 'super'].includes(child.type)) await visit(child.id, depth + 1);
      }
    };
    await visit(docId, 0);
    if (!found.length) throw new Error('文档中没有可读的 Canvas 专用块，请从文档历史恢复');
    if (found.length !== 1) throw new Error('同一文档包含多个画布块，未自动合并或覆盖，请分别放到不同文档');
    const { blockId, content } = found[0]; const payload = parseCanvasDocument(content);
    const title = info.rootTitle || '未命名画布';
    const scene = normalizeScene({ ...payload.scene, id: docId, title, revision: await fingerprint(content, docId, title) });
    return { info, blockId, content, payload, scene };
  }

  async save(scene: CanvasScene, expectedRevision: string | null): Promise<CanvasScene> {
    requireWritable(); const snapshot = normalizeScene(scene); id(snapshot.id);
    return lock(snapshot.id, async () => {
      const current = await this.read(snapshot.id);
      if (expectedRevision === null || current.scene.revision !== expectedRevision) throw new CanvasConflictError(current.scene);
      const next = { ...snapshot, revision: newCanvasId(), updatedAt: Date.now() };
      const markers = { legacyId: current.payload.legacyId, migrationId: current.payload.migrationId };
      const content = canvasDocumentContent(next, markers);
      const attrs = await this.request<Record<string, string>>('/api/attr/getBlockAttrs', { id: current.blockId });
      const beforeWrite = await this.read(snapshot.id);
      if (beforeWrite.scene.revision !== expectedRevision) throw new CanvasConflictError(beforeWrite.scene);
      requireWritable();
      await this.request('/api/block/updateBlock', { id: current.blockId, dataType: 'markdown', data: `${canvasDocumentMarkdown(this.pluginName, content)}\n${blockAttributes(current.blockId, markers, withCanvasAssetAttributes(next, attrs))}` });
      const persisted = await this.read(snapshot.id);
      let saved = persisted.scene;
      if (persisted.info.rootTitle !== current.info.rootTitle) throw new CanvasConflictError(persisted.scene);
      if (persisted.content !== content || persisted.blockId !== current.blockId) throw new Error('画布写入核对失败，保留本地草稿，请重载检查文档');
      try { verifyCanvasAssetAttributes(next, await this.request<Record<string, string>>('/api/attr/getBlockAttrs', { id: current.blockId })); }
      catch (cause) { throw new CanvasStorageError(saved, cause, '画布内容已保存，但附件引用登记核对失败，请重试保存'); }
      if (current.info.rootTitle !== snapshot.title) {
        try { await this.request('/api/filetree/renameDocByID', { id: snapshot.id, title: snapshot.title }); saved = (await this.read(snapshot.id)).scene; }
        catch (cause) { throw new CanvasStorageError(saved, cause, '画布内容已保存，但文档重命名失败，请重试保存'); }
      }
      return saved;
    });
  }

  async create(title: string, destination?: CanvasDestination): Promise<CanvasScene> {
    if (!destination) throw new Error('请先选择画布文档保存位置');
    return this.createDocument(createScene(title), destination);
  }

  async copy(scene: CanvasScene, destination?: CanvasDestination): Promise<CanvasScene> {
    const source = normalizeScene(scene);
    if (!destination) {
      const current = await this.read(id(source.id));
      const parts = current.info.path.split('/').filter(Boolean); parts.pop();
      destination = { notebook: current.info.box, ...(parts.length ? { parentId: parts[parts.length - 1] } : {}) };
    }
    return this.createDocument({ ...source, title: destination.title?.trim() || (source.title.length <= 297 ? `${source.title} 副本` : source.title) }, destination);
  }

  async findByLegacyId(legacyId: string): Promise<string[]> {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(legacyId)) throw new Error('旧画布标记无效');
    const rows = await this.request<{ id: string }[]>('/api/query/sql', {
      stmt: `SELECT DISTINCT b.root_id AS id FROM attributes a JOIN blocks b ON a.block_id=b.id WHERE a.name='${CANVAS_LEGACY_ATTR}' AND a.value=${literal(legacyId)} LIMIT 100`, mode: 'readonly',
    });
    return rows.map(row => id(row.id));
  }

  async importLegacy(scene: CanvasScene, legacyId: string, migrationId: string, reservedDocId: string, destination: CanvasDestination): Promise<CanvasScene> {
    return this.createDocument(scene, destination, { legacyId, migrationId }, id(reservedDocId));
  }

  private async createDocument(source: CanvasScene, destination: CanvasDestination, markers: { legacyId?: string; migrationId?: string } = {}, reservedId = this.allocateDocId()): Promise<CanvasScene> {
    requireWritable(); id(destination.notebook); if (destination.parentId) id(destination.parentId);
    const books = await this.notebooks();
    if (!books.some(book => book.id === destination.notebook)) throw new Error('目标笔记本已关闭或锁定');
    let humanPath = '';
    if (destination.parentId) {
      const parent = await this.request<Info>('/api/block/getBlockInfo', { id: destination.parentId });
      if (parent.rootID !== destination.parentId || parent.box !== destination.notebook) throw new Error('保存位置已变化，请重新选择父文档');
      humanPath = await this.request<string>('/api/filetree/getHPathByID', { id: destination.parentId });
      if (typeof humanPath !== 'string' || !humanPath.startsWith('/')) throw new Error('父文档路径无效');
    }
    const scene = normalizeScene({ ...source, id: reservedId, revision: newCanvasId(), updatedAt: Date.now() });
    const childId = this.allocateDocId();
    const attrs = blockAttributes(childId, markers, withCanvasAssetAttributes(scene));
    const content = canvasDocumentContent(scene, markers);
    const markdown = `${canvasDocumentMarkdown(this.pluginName, content)}\n${attrs}\n`;
    const result = await this.request<string>('/api/filetree/createDocWithMd', {
      notebook: destination.notebook, id: reservedId, ...(destination.parentId ? { parentID: destination.parentId } : {}),
      path: `${humanPath}/${scene.title.replace(/[\\/\x00-\x1f]/g, ' ').trim() || '未命名画布'}`, markdown,
    });
    if (result !== reservedId) throw new Error('创建画布文档返回的 ID 与预分配值不匹配');
    this.known.add(reservedId);
    let stored = await this.read(reservedId);
    if (stored.content !== content || stored.payload.legacyId !== markers.legacyId) throw new Error('新建画布文档核对失败，原数据仍保留');
    verifyCanvasAssetAttributes(scene, await this.request<Record<string, string>>('/api/attr/getBlockAttrs', { id: stored.blockId }));
    if (stored.info.rootTitle !== scene.title) {
      await this.request('/api/filetree/renameDocByID', { id: reservedId, title: scene.title });
      stored = await this.read(reservedId);
    }
    if (destination.parentId && !stored.info.path.startsWith(`${(await this.request<Info>('/api/block/getBlockInfo', { id: destination.parentId })).path.replace(/\.sy$/, '')}/`)) throw new Error('文档保存位置核对失败，请检查新建文档；没有覆盖原数据');
    return stored.scene;
  }
}
