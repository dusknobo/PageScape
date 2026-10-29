import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPluginIdMigration, migrationFileName, planPluginIdMigration, renameLegacyBlock, sameMigrationBlock } from '../src/plugin-id-migration';
import type { PluginIdMigrationIO } from '../src/plugin-id-migration';

const id = '20261029123456-abcdefg';
const id2 = '20261029123457-abcdefg';
const raw = (type = 'child-cards') => `;;;siyuan-child-cards/${type}\n{"text":"正文 ;;; / 原样"}\n;;;\n{: id="${id}" custom-test="保留"}\n`;
const bytes = (value: string) => new TextEncoder().encode(value);
function fixture() {
  const blocks = new Map([[id, raw()]]);
  const legacy = new Map([['canvas-index.json', bytes('{"version":1,"boards":[]}\n')], ['canvas-backups/run/orphan.json', bytes('  原始备份\n')]]);
  const current = new Map<string, Uint8Array>(); const writes: string[] = [];
  let writable = true;
  const io: PluginIdMigrationIO = {
    listBlocks: async () => [...blocks.keys()],
    readBlock: async key => { if (!blocks.has(key)) throw new Error('block unavailable'); return blocks.get(key)!; },
    writeBlock: async (key, value) => { writes.push('block:' + key); blocks.set(key, value); },
    listLegacyFiles: async () => [...legacy.keys()],
    readLegacyFile: async key => { if (!legacy.has(key)) throw new Error('file unavailable'); return Uint8Array.from(legacy.get(key)!); },
    readCurrentFile: async key => current.has(key) ? Uint8Array.from(current.get(key)!) : undefined,
    writeCurrentFile: async (key, value) => { writes.push('file:' + key); current.set(key, Uint8Array.from(value)); },
    assertWritable: () => { if (!writable) throw new Error('readonly or legacy plugin active'); },
  };
  return { io, blocks, legacy, current, writes, setWritable: (value: boolean) => { writable = value; } };
}

test('ID conversion changes only three owned opening fences and preserves body, attributes and CRLF', () => {
  for (const type of ['child-cards', 'canvas-document', 'canvas-reference']) {
    const original = raw(type).replace(/\n/g, '\r\n');
    assert.equal(renameLegacyBlock(original), original.replace(';;;siyuan-child-cards/', ';;;PageScape/'));
  }
  for (const other of ['```md\n' + raw() + '\n```', raw('unknown-type'), raw().replace('siyuan-child-cards/', 'other/'), raw().replace('siyuan-child-cards/', 'PageScape/')]) assert.equal(renameLegacyBlock(other), undefined);
  assert.throws(() => renameLegacyBlock(';;;siyuan-child-cards/child-cards\n{}'), /不完整/);
});

test('preview performs no writes and snapshots exact legacy bytes independently', async () => {
  const f = fixture(); f.setWritable(false);
  const plan = await planPluginIdMigration(f.io);
  assert.equal(plan.blocks.length, 1); assert.equal(plan.files.length, 2); assert.deepEqual(f.writes, []);
  f.legacy.get('canvas-index.json')![0] = 0;
  assert.equal(plan.files[1].bytes[0], '{'.charCodeAt(0));
});

test('apply requires explicit confirmation and a writable workspace before any writes', async () => {
  const f = fixture(); const plan = await planPluginIdMigration(f.io);
  await assert.rejects(applyPluginIdMigration(f.io, plan, { confirmed: false } as unknown as { confirmed: true }), /确认/);
  f.setWritable(false);
  await assert.rejects(applyPluginIdMigration(f.io, plan, { confirmed: true }), /readonly/);
  assert.deepEqual(f.writes, []);
});

test('storage and every original block are preserved before any block update; IDs and payload remain exact', async () => {
  const f = fixture(); f.blocks.set(id2, raw('canvas-reference'));
  const plan = await planPluginIdMigration(f.io);
  const result = await applyPluginIdMigration(f.io, plan, { confirmed: true });
  assert.deepEqual(result, { migratedBlocks: 2, copiedFiles: 2 });
  assert.equal(f.blocks.get(id), raw().replace(';;;siyuan-child-cards/', ';;;PageScape/'));
  for (const block of plan.blocks) {
    const name = `plugin-id-backups/${block.id}-${block.hash}.md`;
    assert.deepEqual(f.current.get(name), bytes(block.before));
    assert.ok(f.writes.indexOf('file:' + name) < f.writes.findIndex(value => value.startsWith('block:')));
  }
  for (const file of plan.files) assert.deepEqual(f.current.get(file.name), file.bytes);
  assert.deepEqual(f.legacy.get('canvas-index.json'), bytes('{"version":1,"boards":[]}\n'));
});

test('repeating migration preserves subsequent new-plugin changes and imports newly opened legacy blocks', async () => {
  const f = fixture();
  await applyPluginIdMigration(f.io, await planPluginIdMigration(f.io), { confirmed: true });
  f.current.set('canvas-index.json', bytes('new plugin edits'));
  f.blocks.set(id2, raw('canvas-document'));
  const plan = await planPluginIdMigration(f.io);
  assert.equal(plan.blocks.length, 1); assert.ok(plan.files.every(file => file.imported));
  assert.deepEqual(await applyPluginIdMigration(f.io, plan, { confirmed: true }), { migratedBlocks: 1, copiedFiles: 0 });
  assert.deepEqual(f.current.get('canvas-index.json'), bytes('new plugin edits'));
});

test('an existing different target file stops preview without overwriting either version', async () => {
  const f = fixture(); f.current.set('canvas-index.json', bytes('new data'));
  await assert.rejects(planPluginIdMigration(f.io), /不同内容/);
  assert.deepEqual(f.writes, []); assert.equal(f.blocks.get(id), raw());
});

test('a changed block, source file or destination after preview stops before any writes', async () => {
  for (const kind of ['block', 'source', 'destination']) {
    const f = fixture(); const plan = await planPluginIdMigration(f.io);
    if (kind === 'block') f.blocks.set(id, raw() + 'user edit');
    if (kind === 'source') f.legacy.set('canvas-index.json', bytes('old plugin edit'));
    if (kind === 'destination') f.current.set('canvas-index.json', bytes('new plugin edit'));
    await assert.rejects(applyPluginIdMigration(f.io, plan, { confirmed: true }), /变化|修改/);
    assert.deepEqual(f.writes, []);
  }
});

test('backup write failure leaves all original blocks untouched and a later retry resumes safely', async () => {
  const f = fixture(); const write = f.io.writeCurrentFile;
  f.io.writeCurrentFile = async (name, value) => { if (name.endsWith('.md')) throw new Error('disk unavailable'); await write(name, value); };
  await assert.rejects(applyPluginIdMigration(f.io, await planPluginIdMigration(f.io), { confirmed: true }), /disk unavailable/);
  assert.equal(f.blocks.get(id), raw());
  f.io.writeCurrentFile = write;
  await applyPluginIdMigration(f.io, await planPluginIdMigration(f.io), { confirmed: true });
  assert.ok(f.blocks.get(id)!.startsWith(';;;PageScape/'));
});

test('corrupt existing block backups and missing import receipts are never overwritten', async () => {
  const f = fixture(); const plan = await planPluginIdMigration(f.io); const block = plan.blocks[0];
  const path = `plugin-id-backups/${id}-${block.hash}.md`; f.current.set(path, bytes('corrupt'));
  await assert.rejects(applyPluginIdMigration(f.io, plan, { confirmed: true }), /不同内容/);
  assert.equal(f.blocks.get(id), raw()); assert.deepEqual(f.current.get(path), bytes('corrupt'));
  f.current.delete(path);
  await applyPluginIdMigration(f.io, await planPluginIdMigration(f.io), { confirmed: true });
  const second = await planPluginIdMigration(f.io);
  const receipt = [...f.current.keys()].find(name => name.includes('/imported-files/'))!; f.current.delete(receipt);
  await assert.rejects(applyPluginIdMigration(f.io, second, { confirmed: true }), /导入记录/);
});

test('an update with a lost response is verified and not issued twice', async () => {
  const f = fixture(); const write = f.io.writeBlock;
  f.io.writeBlock = async (key, value) => { await write(key, value); throw new Error('response lost'); };
  assert.equal((await applyPluginIdMigration(f.io, await planPluginIdMigration(f.io), { confirmed: true })).migratedBlocks, 1);
  assert.equal(f.writes.filter(name => name.startsWith('block:')).length, 1);
});

test('native updated timestamps may advance while user content and attributes remain exact', async () => {
  const f = fixture(); const write = f.io.writeBlock;
  f.io.writeBlock = async (key, value) => { await write(key, value.replace('custom-test="保留"', 'updated="20261029125959" custom-test="保留"')); };
  assert.equal((await applyPluginIdMigration(f.io, await planPluginIdMigration(f.io), { confirmed: true })).migratedBlocks, 1);
  assert.ok(sameMigrationBlock(raw(), raw().replace('custom-test="保留"', 'updated="20261029125959" custom-test="保留"')));
  assert.ok(!sameMigrationBlock(raw(), raw().replace('正文', '修改正文')));
  assert.ok(!sameMigrationBlock(raw(), raw().replace('custom-test="保留"', 'custom-test="修改"')));
});

test('concurrent edits during backup stop the final update and preserve the original backup', async () => {
  const f = fixture(); const write = f.io.writeCurrentFile;
  f.io.writeCurrentFile = async (name, value) => { await write(name, value); if (name.endsWith('.md')) f.blocks.set(id, raw() + 'concurrent edit'); };
  await assert.rejects(applyPluginIdMigration(f.io, await planPluginIdMigration(f.io), { confirmed: true }), /原块已变化/);
  assert.ok(f.blocks.get(id)!.endsWith('concurrent edit')); assert.ok(!f.writes.some(name => name.startsWith('block:')));
});

test('path traversal, excessive inputs and malformed owned fences fail without writes', async () => {
  for (const name of ['../x', '/x', 'a//b', 'a\\b', '.', 'a/..', 'x\0y']) assert.throws(() => migrationFileName(name));
  const f = fixture(); f.legacy.set('../escape.json', bytes('bad'));
  await assert.rejects(planPluginIdMigration(f.io), /路径/); assert.deepEqual(f.writes, []);
  f.legacy.delete('../escape.json'); f.blocks.set(id, ';;;siyuan-child-cards/canvas-document\n{}');
  await assert.rejects(planPluginIdMigration(f.io), /不完整/); assert.deepEqual(f.writes, []);
});
