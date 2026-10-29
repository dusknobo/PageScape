export const PLUGIN_ID = 'PageScape';
export const LEGACY_PLUGIN_ID = 'siyuan-child-cards';
export const ID_MIGRATION_BACKUPS = 'plugin-id-backups';
const BLOCK_ID = /^\d{14}-[a-z0-9]{7}$/;
const TYPES = new Set(['child-cards', 'canvas-document', 'canvas-reference']);

export interface PluginIdMigrationIO {
  listBlocks(): Promise<string[]>;
  readBlock(id: string): Promise<string>;
  writeBlock(id: string, markdown: string): Promise<void>;
  listLegacyFiles(): Promise<string[]>;
  readLegacyFile(name: string): Promise<Uint8Array>;
  readCurrentFile(name: string): Promise<Uint8Array | undefined>;
  writeCurrentFile(name: string, bytes: Uint8Array): Promise<void>;
  assertWritable(): void;
}
export interface PluginIdMigrationPlan {
  blocks: { id: string; before: string; after: string; hash: string }[];
  files: { name: string; bytes: Uint8Array; imported: boolean }[];
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);
export function migrationFileName(name: string): string {
  if (!name || name.length > 512 || name.split('/').some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw new Error('旧版存储路径无效');
  return name;
}
export function renameLegacyBlock(markdown: string): string | undefined {
  const match = /^;;;siyuan-child-cards\/([^\r\n]+)(\r?\n)/.exec(markdown);
  if (!match || !TYPES.has(match[1])) return;
  if (!markdown.slice(match[0].length).split(/\r?\n/).some(line => line.trim() === ';;;')) throw new Error('旧版自定义块不完整，保留原内容');
  return `;;;${PLUGIN_ID}/${match[1]}${match[2]}` + markdown.slice(match[0].length);
}
export function sameMigrationBlock(a: string, b: string): boolean {
  const stable = (markdown: string): string => {
    const lines = markdown.split('\n');
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === ';;;');
    if (end < 0) return markdown;
    return lines.map((line, index) => index > end && line.startsWith('{:') && line.endsWith('}') ? line.replace(/ updated="\d{14}"/g, '') : line).join('\n');
  };
  return stable(a) === stable(b);
}
async function hash(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join('');
}
async function fileReceipt(name: string, bytes: Uint8Array): Promise<{ name: string; bytes: Uint8Array }> {
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))].map(value => value.toString(16).padStart(2, '0')).join('');
  return { name: `${ID_MIGRATION_BACKUPS}/imported-files/${await hash(name + '\0' + digest)}.json`, bytes: new TextEncoder().encode(JSON.stringify({ name, sha256: digest })) };
}

/** Reading the plan never writes notes, storage or backups. */
export async function planPluginIdMigration(io: PluginIdMigrationIO): Promise<PluginIdMigrationPlan> {
  const ids = [...new Set(await io.listBlocks())];
  if (ids.length > 10000) throw new Error('旧版块超过 10000 个，请分批整理后迁移');
  const blocks: PluginIdMigrationPlan['blocks'] = [];
  for (const id of ids) {
    if (!BLOCK_ID.test(id)) throw new Error('旧版块 ID 无效');
    const before = await io.readBlock(id); const after = renameLegacyBlock(before);
    if (after !== undefined) blocks.push({ id, before, after, hash: await hash(before) });
  }
  const names = [...new Set(await io.listLegacyFiles())].sort();
  if (names.length > 4096) throw new Error('旧版存储文件过多，未迁移');
  const files: PluginIdMigrationPlan['files'] = []; let total = 0;
  for (const name of names) {
    migrationFileName(name);
    const bytes = await io.readLegacyFile(name); total += bytes.length;
    if (bytes.length > 16 * 1024 * 1024 || total > 64 * 1024 * 1024) throw new Error('旧版存储超出迁移体积限制，原文件未改动');
    const receipt = await fileReceipt(name, bytes); const marker = await io.readCurrentFile(receipt.name);
    if (marker && !same(marker, receipt.bytes)) throw new Error('旧版存储导入记录损坏，未覆盖');
    const existing = await io.readCurrentFile(name);
    if (!marker && existing && !same(existing, bytes)) throw new Error(`新版存储已有不同内容：${name}。未覆盖任何版本`);
    files.push({ name, bytes: Uint8Array.from(bytes), imported: Boolean(marker) });
  }
  return { blocks, files };
}

/** All original blocks are backed up and verified before the first block update. */
export async function applyPluginIdMigration(io: PluginIdMigrationIO, plan: PluginIdMigrationPlan, options: { confirmed: true; onProgress?: (done: number, total: number) => void }): Promise<{ migratedBlocks: number; copiedFiles: number }> {
  if (options?.confirmed !== true) throw new Error('请先检查并确认迁移清单');
  io.assertWritable();
  for (const block of plan.blocks) {
    if (!BLOCK_ID.test(block.id) || renameLegacyBlock(block.before) !== block.after || await hash(block.before) !== block.hash) throw new Error('迁移清单无效，请重新检查');
    const latest = await io.readBlock(block.id);
    if (!sameMigrationBlock(latest, block.before) && !sameMigrationBlock(latest, block.after)) throw new Error('检查后的旧版块已被修改，请重新检查');
  }
  for (const file of plan.files) {
    migrationFileName(file.name);
    if (!same(await io.readLegacyFile(file.name), file.bytes)) throw new Error('检查后的旧版存储已变化，请重新检查');
    if (file.imported) {
      const receipt = await fileReceipt(file.name, file.bytes); const marker = await io.readCurrentFile(receipt.name);
      if (!marker || !same(marker, receipt.bytes)) throw new Error('旧版存储导入记录已变化，请重新检查');
      continue;
    }
    const latest = await io.readCurrentFile(file.name);
    if (latest && !same(latest, file.bytes)) throw new Error(`新版存储已变化：${file.name}，未覆盖`);
  }
  const preserve = async (name: string, bytes: Uint8Array): Promise<boolean> => {
    io.assertWritable();
    const existing = await io.readCurrentFile(name);
    if (existing && !same(existing, bytes)) throw new Error(`备份或目标文件已存在不同内容：${name}，未覆盖`);
    if (!existing) await io.writeCurrentFile(name, bytes);
    const persisted = await io.readCurrentFile(name);
    if (!persisted || !same(persisted, bytes)) throw new Error(`备份或存储核对失败：${name}`);
    return !existing;
  };
  let copiedFiles = 0, migratedBlocks = 0;
  for (const file of plan.files) {
    if (file.imported) continue;
    const receipt = await fileReceipt(file.name, file.bytes); const marker = await io.readCurrentFile(receipt.name);
    if (marker) { if (!same(marker, receipt.bytes)) throw new Error('旧版存储导入记录损坏'); continue; }
    if (await preserve(file.name, file.bytes)) copiedFiles++;
    await preserve(receipt.name, receipt.bytes);
  }
  for (const block of plan.blocks) await preserve(`${ID_MIGRATION_BACKUPS}/${block.id}-${block.hash}.md`, new TextEncoder().encode(block.before));
  for (const block of plan.blocks) {
    io.assertWritable();
    const latest = await io.readBlock(block.id);
    if (sameMigrationBlock(latest, block.after)) continue;
    if (!sameMigrationBlock(latest, block.before)) throw new Error('迁移前原块已变化，已停止；备份与已完成部分保留');
    try { await io.writeBlock(block.id, block.after); }
    catch (error) { if (!sameMigrationBlock(await io.readBlock(block.id), block.after)) throw error; }
    if (!sameMigrationBlock(await io.readBlock(block.id), block.after)) throw new Error('迁移写入核对失败，已保留原块备份');
    migratedBlocks++; options.onProgress?.(migratedBlocks, plan.blocks.length);
  }
  return { migratedBlocks, copiedFiles };
}
