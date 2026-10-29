import { Constants } from 'siyuan';
import { canvasDialog } from './canvas/dialog';
import { CanvasApiError, canvasRequest, listCanvasNotebooks } from './canvas/document-api';
import { applyPluginIdMigration, ID_MIGRATION_BACKUPS, LEGACY_PLUGIN_ID, migrationFileName, planPluginIdMigration, PLUGIN_ID } from './plugin-id-migration';
import type { PluginIdMigrationIO, PluginIdMigrationPlan } from './plugin-id-migration';

export function createPluginIdMigrationIO(canWrite: () => void): PluginIdMigrationIO {
  const oldRoot = `/data/storage/petal/${LEGACY_PLUGIN_ID}`;
  const newRoot = `/data/storage/petal/${PLUGIN_ID}`;
  const read = async (path: string): Promise<Uint8Array | undefined> => {
    const response = await fetch('/api/file/getFile', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }), signal: AbortSignal.timeout(15000) });
    if (response.status === 404) return;
    if (!response.ok) throw new Error(`存储读取失败（HTTP ${response.status}）`);
    if (response.status === 202) {
      const result = await response.json(); if (result?.code === 404) return;
      throw new Error(result?.msg || '存储读取失败');
    }
    return new Uint8Array(await response.arrayBuffer());
  };
  return {
    assertWritable: canWrite,
    async listBlocks() {
      const books = await listCanvasNotebooks(); if (!books.length) return [];
      const boxes = books.map(book => { if (!/^\d{14}-[a-z0-9]{7}$/.test(book.id)) throw new Error('笔记本 ID 无效'); return `'${book.id}'`; }).join(',');
      const rows = await canvasRequest<{ id: string }[]>('/api/query/sql', { stmt: `SELECT id FROM blocks WHERE box IN (${boxes}) AND type IN ('custom','custom_b','custom-block','NodeCustomBlock') AND markdown LIKE ';;;${LEGACY_PLUGIN_ID}/%' ORDER BY id LIMIT 10001`, mode: 'readonly' });
      if (!Array.isArray(rows)) throw new Error('旧版块列表无效');
      return rows.map(row => row.id);
    },
    async readBlock(id) { return (await canvasRequest<{ kramdown: string }>('/api/block/getBlockKramdown', { id })).kramdown; },
    async writeBlock(id, markdown) { canWrite(); await canvasRequest('/api/block/updateBlock', { id, dataType: 'markdown', data: markdown }); },
    async listLegacyFiles() {
      const result: string[] = [];
      const walk = async (prefix: string, depth: number): Promise<void> => {
        if (depth > 6 || result.length > 4096) throw new Error('旧版存储目录过大，未迁移');
        let entries: { name: string; isDir: boolean; isSymlink?: boolean }[];
        try { entries = await canvasRequest('/api/file/readDir', { path: oldRoot + (prefix ? '/' + prefix : '') }); }
        catch (error) { if (!prefix && error instanceof CanvasApiError && error.code === 404) return; throw error; }
        if (!Array.isArray(entries)) throw new Error('旧版存储目录无效');
        for (const entry of entries) {
          if (entry.name.includes('/') || entry.isSymlink) throw new Error('旧版存储含有不支持的路径或链接');
          const name = migrationFileName(prefix ? `${prefix}/${entry.name}` : entry.name);
          if (entry.isDir) await walk(name, depth + 1); else result.push(name);
        }
      };
      await walk('', 0); return result;
    },
    async readLegacyFile(name) { const data = await read(`${oldRoot}/${migrationFileName(name)}`); if (!data) throw new Error('旧版文件已不存在'); return data; },
    readCurrentFile: name => read(`${newRoot}/${migrationFileName(name)}`),
    async writeCurrentFile(name, bytes) {
      canWrite(); const path = `${newRoot}/${migrationFileName(name)}`;
      const form = new FormData(); form.append('path', path); form.append('isDir', 'false'); form.append('app', Constants.SIYUAN_APPID);
      form.append('file', new Blob([Uint8Array.from(bytes).buffer], { type: 'application/octet-stream' }), name.split('/').pop()!);
      const response = await fetch('/api/file/putFile', { method: 'POST', credentials: 'same-origin', body: form, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`备份写入失败（HTTP ${response.status}）`);
      const result = await response.json(); if (result?.code !== 0) throw new Error(result?.msg || '备份写入失败');
    },
  };
}

export function showPluginIdMigration(anchor: HTMLElement, io: PluginIdMigrationIO, signal: AbortSignal, onComplete: () => Promise<void>): void {
  const dialog = canvasDialog(anchor, '迁移旧版插件 ID · Migrate Legacy Plugin ID', signal);
  const help = dialog.doc.createElement('p');
  help.textContent = `将 ${LEGACY_PLUGIN_ID} 的卡片、画布和引用迁移到 ${PLUGIN_ID}。请先保存并关闭旧版编辑页，停用旧插件；旧存储保留，原块备份到 ${PLUGIN_ID}/${ID_MIGRATION_BACKUPS}/。只检查已打开且未加密的笔记本，其他笔记本打开后可再次检查。`;
  let plan: PluginIdMigrationPlan | undefined;
  const check = dialog.button('检查旧版 / Preview', () => { void preview(); });
  const apply = dialog.button('备份并迁移 / Migrate', () => { void migrate(); }); apply.disabled = true;
  const close = dialog.button('关闭', dialog.close);
  dialog.panel.append(help, check, apply, close, dialog.status);
  async function preview(): Promise<void> {
    check.disabled = true; apply.disabled = true; dialog.status.textContent = '正在读取旧版内容，不修改笔记…';
    try {
      plan = await planPluginIdMigration(io);
      dialog.status.textContent = `找到 ${plan.blocks.length} 个旧版块、${plan.files.length} 个旧存储文件。迁移只改变块命名空间，保留块 ID、正文、布局及引用。`;
      apply.disabled = !plan.blocks.length && !plan.files.length;
    } catch (error) { plan = undefined; dialog.status.textContent = `检查停止：${error instanceof Error ? error.message : String(error)}`; }
    finally { check.disabled = false; }
  }
  async function migrate(): Promise<void> {
    if (!plan) return;
    check.disabled = true; apply.disabled = true; close.disabled = true;
    try {
      const result = await applyPluginIdMigration(io, plan, { confirmed: true, onProgress: (done, total) => { dialog.status.textContent = `已迁移 ${done}/${total} 个块…`; } });
      dialog.status.textContent = `完成：迁移 ${result.migratedBlocks} 个块，复制 ${result.copiedFiles} 个存储文件。可重新打开文档查看；旧存储与原块备份已保留。`;
      await onComplete();
    } catch (error) { dialog.status.textContent = `迁移已停止：${error instanceof Error ? error.message : String(error)}。已完成部分和备份保留，可重新检查后继续。`; }
    finally { plan = undefined; check.disabled = false; close.disabled = false; }
  }
  void preview();
}
