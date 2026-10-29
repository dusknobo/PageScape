import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createScene } from '../src/canvas/model';
import {
  CanvasMigrationError, loadCanvasMigrationManifest, migrateLegacyCanvases,
  sameMigratedCanvasContent, sha256Bytes,
} from '../src/canvas/migration';
import type {
  CanvasMigrationDocuments, CanvasMigrationIO, CanvasMigrationManifest, CanvasMigrationOptions,
} from '../src/canvas/migration';
import type { CanvasScene } from '../src/canvas/types';

const LEGACY_A = '13b8eec4-bf21-4818-a89b-59429b874226';
const LEGACY_B = 'a10ed861-2209-499c-9063-d469bead5a05';
const DOC_A = '20261017120000-abcdefg';
const DOC_B = '20261017120001-bcdefgh';
const raw = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const copy = <T>(value: T): T => structuredClone(value);
const filename = (id: string) => `canvas-${id}.json`;
const confirmed: CanvasMigrationOptions = { confirmed: true };

function populated(id = LEGACY_A): CanvasScene {
  return {
    ...createScene('流体关系'), id, revision: 'legacy-revision', updatedAt: 1,
    viewport: { x: -19, y: 35, zoom: 0.75 },
    nodes: [
      { id: 'node-doc', kind: 'doc', docId: DOC_A, title: '已关闭的文档', x: -200, y: 50, width: 321, height: 251, color: 'blue', groupId: 'missing-group' },
      { id: 'node-text', kind: 'text', text: '中文便签\n代码 ```\n;;;\n💧', x: 400, y: -20, width: 242, height: 160, color: 'neutral' },
      { id: 'node-group', kind: 'group', title: '保留分组', x: -300, y: -100, width: 900, height: 600, color: 'purple' },
    ],
    edges: [{ id: 'edge-missing', from: 'node-doc', to: 'missing-node', label: '失效端点仍保留', color: 'green' }],
  };
}

function fixture(orphan = true) {
  const a = populated();
  const b = { ...populated(LEGACY_B), title: '索引外孤立画布' };
  const files = new Map<string, Uint8Array>([
    // Deliberate BOM, CRLF, whitespace and multibyte content: parse/stringify
    // backups would not preserve these original bytes.
    [filename(a.id), new TextEncoder().encode(`\ufeff \r\n${JSON.stringify(a, null, 2)}\r\n`)],
    ['canvas-index.json', raw({ version: 1, boards: [{ id: a.id, title: a.title, updatedAt: a.updatedAt }] })],
  ]);
  if (orphan) files.set(filename(b.id), raw(b));
  const backups = new Map<string, Uint8Array>();
  const documents = new Map<string, { legacyId: string; scene: CanvasScene }>();
  const events: string[] = [];
  const creates: { legacyId: string; reservedDocId: string }[] = [];
  let manifest: CanvasMigrationManifest | undefined;
  let allocations = 0;
  let findLag = false;
  const io: CanvasMigrationIO = {
    async listLegacy() { events.push('list'); return [...files.keys(), 'other-plugin-data.txt', 'canvas-migration.json']; },
    async readLegacy(name) { events.push(`read:${name}`); const bytes = files.get(name); if (!bytes) throw new Error('missing source'); return Uint8Array.from(bytes); },
    async readBackup(runId, name) { events.push(`backup-read:${name}`); const bytes = backups.get(`${runId}/${name}`); return bytes && Uint8Array.from(bytes); },
    async writeBackup(runId, name, bytes) { events.push(`backup-write:${name}`); backups.set(`${runId}/${name}`, Uint8Array.from(bytes)); },
    async readManifest() { events.push('manifest-read'); return manifest && copy(manifest); },
    async writeManifest(next) { events.push(`manifest-write:${next.stage}`); manifest = copy(next); },
  };
  const docs: CanvasMigrationDocuments = {
    allocateDocId() { allocations++; return allocations === 1 ? DOC_A : allocations === 2 ? DOC_B : `20261017120002-${String(allocations).padStart(7, 'a')}`; },
    async findByLegacyId(id) { events.push(`find:${id}`); return findLag ? [] : [...documents.entries()].filter(([, doc]) => doc.legacyId === id).map(([docId]) => docId); },
    async createFromLegacy(scene, legacyId, migrationId, reservedDocId) {
      events.push(`create:${legacyId}`);
      assert.equal(backups.size, files.size, 'all originals must be backed up before any creation');
      assert.ok(manifest?.files.every(file => file.verified));
      assert.ok(manifest?.boards.some(board => board.legacyId === legacyId && board.reservedDocId === reservedDocId && board.stage === 'creating'));
      assert.equal(manifest?.runId, migrationId);
      if (documents.has(reservedDocId)) throw new Error('refuse existing ID');
      creates.push({ legacyId, reservedDocId });
      const saved = { ...copy(scene), id: reservedDocId, revision: 'doc-revision', updatedAt: 999 };
      documents.set(reservedDocId, { legacyId, scene: saved });
      return reservedDocId;
    },
    async load(id, expectedLegacyId) {
      events.push(`doc-read:${id}`);
      const doc = documents.get(id);
      if (!doc) return undefined;
      if (expectedLegacyId && doc.legacyId !== expectedLegacyId) throw new Error('legacy marker mismatch');
      return copy(doc.scene);
    },
  };
  return {
    a, b, files, backups, documents, creates, events, io, docs,
    get manifest() { return manifest; }, set manifest(value) { manifest = value; },
    get allocations() { return allocations; }, set findLag(value: boolean) { findLag = value; },
  };
}

test('migration requires explicit confirmation before any I/O', async () => {
  const f = fixture();
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, { confirmed: false } as unknown as CanvasMigrationOptions), /明确确认/);
  assert.equal(f.events.length, 0);
});

test('SHA256 uses original bytes; comparison ignores only document metadata', async () => {
  const bytes = new TextEncoder().encode('中文\r\n💧\u0000');
  assert.equal(await sha256Bytes(bytes), createHash('sha256').update(bytes).digest('hex'));
  const a = populated();
  const b = { ...copy(a), id: DOC_A, revision: 'new-revision', updatedAt: 999 };
  assert.ok(sameMigratedCanvasContent(a, b));
  b.nodes[0].x += 1;
  assert.equal(sameMigratedCanvasContent(a, b), false);
  b.nodes = copy(a.nodes).reverse();
  assert.equal(sameMigratedCanvasContent(a, b), false);
});

test('backs up exact bytes including orphan JSON and migrates all content without legacy writes', async () => {
  const f = fixture();
  const before = new Map([...f.files].map(([name, bytes]) => [name, Uint8Array.from(bytes)]));
  const result = await migrateLegacyCanvases(f.io, f.docs, { confirmed: true, onProgress() { throw new Error('UI failure'); } });
  assert.equal(result.stage, 'complete');
  assert.equal(result.boards.length, 2);
  assert.equal(Object.keys(result.mapping).length, 2);
  assert.equal(f.creates.length, 2);
  for (const file of result.files) {
    assert.deepEqual(f.backups.get(`${result.runId}/${file.name}`), before.get(file.name));
    assert.equal(file.sha256, createHash('sha256').update(before.get(file.name)!).digest('hex'));
    assert.equal(file.size, before.get(file.name)!.byteLength);
    assert.equal(file.verified, true);
  }
  assert.deepEqual(f.files, before);
  for (const source of [f.a, f.b]) {
    const migrated = f.documents.get(result.mapping[source.id])!.scene;
    assert.ok(sameMigratedCanvasContent(source, migrated));
    assert.equal(migrated.nodes[0].groupId, 'missing-group');
    assert.equal(migrated.edges[0].to, 'missing-node');
  }
  assert.deepEqual(await loadCanvasMigrationManifest(f.io), result);
});

test('repeat and concurrent invocations do not duplicate documents, backups, or mappings', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([
    migrateLegacyCanvases(f.io, f.docs, confirmed), migrateLegacyCanvases(f.io, f.docs, confirmed),
  ]);
  assert.equal(first.runId, second.runId);
  assert.deepEqual(first.mapping, second.mapping);
  assert.equal(f.creates.length, 2);
  assert.equal(f.events.filter(event => event.startsWith('backup-write:')).length, 3);
  // Editing a migrated document later must not cause a replay of its old scene.
  f.documents.get(first.mapping[LEGACY_A])!.scene.title = '迁移后正常改名';
  const third = await migrateLegacyCanvases(f.io, f.docs, confirmed);
  assert.deepEqual(third.mapping, first.mapping);
  assert.equal(f.documents.get(first.mapping[LEGACY_A])!.scene.title, '迁移后正常改名');
});

test('a partially completed backup resumes with the same run and no documents created early', async () => {
  const f = fixture();
  const write = f.io.writeBackup;
  let once = true;
  f.io.writeBackup = async (...args) => { await write(...args); if (once) { once = false; throw new Error('backup response lost'); } };
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), /backup response lost/);
  assert.equal(f.creates.length, 0);
  const run = f.manifest!.runId;
  const result = await migrateLegacyCanvases(f.io, f.docs, confirmed);
  assert.equal(result.runId, run);
  assert.equal(f.events.filter(event => event.startsWith('backup-write:')).length, 3);
  assert.equal(result.stage, 'complete');
});

test('corrupt backup bytes stop creation and are never overwritten', async () => {
  const f = fixture();
  const write = f.io.writeBackup;
  f.io.writeBackup = async (runId, name, bytes) => { await write(runId, name, bytes); f.backups.set(`${runId}/${name}`, new Uint8Array([0, 1, 2])); };
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), /SHA256/);
  const writes = f.events.filter(event => event.startsWith('backup-write:')).length;
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), /SHA256/);
  assert.equal(f.events.filter(event => event.startsWith('backup-write:')).length, writes);
  assert.equal(f.creates.length, 0);
});

test('all raw files are backed up before parsing an invalid scene or index', async () => {
  for (const badIndex of [false, true]) {
    const f = fixture();
    f.files.set(badIndex ? 'canvas-index.json' : filename(LEGACY_B), badIndex ? raw({ version: 1, boards: [{ id: 'missing', title: '缺失文件', updatedAt: 1 }] }) : new Uint8Array([0xff]));
    await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed));
    assert.equal(f.backups.size, f.files.size);
    assert.equal(f.creates.length, 0);
    assert.equal(f.manifest!.stage, 'backing-up');
  }
});

test('lost create response is recovered through reserved ID despite lagging legacy search', async () => {
  const f = fixture(false);
  const create = f.docs.createFromLegacy;
  let once = true;
  f.docs.createFromLegacy = async (...args) => { const id = await create(...args); if (once) { once = false; throw new Error('create response lost'); } return id; };
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), /结果尚未确认/);
  const board = f.manifest!.boards[0];
  assert.equal(board.stage, 'creation-uncertain');
  assert.equal(board.reservedDocId, DOC_A);
  assert.equal(board.docId, undefined);
  f.findLag = true;
  const result = await migrateLegacyCanvases(f.io, f.docs, confirmed);
  assert.equal(result.mapping[LEGACY_A], DOC_A);
  assert.equal(f.allocations, 1);
  assert.equal(f.creates.length, 1);
});

test('failed creation retries only the previously reserved ID after confirmed absence', async () => {
  const f = fixture(false);
  const create = f.docs.createFromLegacy;
  const requested: string[] = [];
  let once = true;
  f.docs.createFromLegacy = async (...args) => { requested.push(args[3]); if (once) { once = false; throw new Error('request not sent'); } return create(...args); };
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), /结果尚未确认/);
  await migrateLegacyCanvases(f.io, f.docs, confirmed);
  assert.deepEqual(requested, [DOC_A, DOC_A]);
  assert.equal(f.allocations, 1);
  assert.equal(f.creates.length, 1);
});

test('failure persisting mapping after create is recoverable without duplicate creation', async () => {
  const f = fixture(false);
  const write = f.io.writeManifest;
  let fail = true;
  f.io.writeManifest = async next => { if (fail && next.boards.some(board => !!board.docId)) throw new Error('manifest disk full'); await write(next); };
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), /manifest disk full/);
  assert.equal(f.creates.length, 1);
  assert.equal(f.manifest!.boards[0].stage, 'creating');
  assert.equal(f.manifest!.boards[0].reservedDocId, DOC_A);
  fail = false;
  f.findLag = true;
  const result = await migrateLegacyCanvases(f.io, f.docs, confirmed);
  assert.equal(result.mapping[LEGACY_A], DOC_A);
  assert.equal(f.creates.length, 1);
});

test('post-create read failure keeps mapping and a retry verifies the existing document', async () => {
  const f = fixture(false);
  const load = f.docs.load;
  let fail = true;
  f.docs.load = async (...args) => { if (fail) throw new Error('document offline'); return load(...args); };
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), /document offline/);
  assert.equal(f.manifest!.boards[0].stage, 'created');
  assert.equal(f.manifest!.mapping[LEGACY_A], DOC_A);
  fail = false;
  await migrateLegacyCanvases(f.io, f.docs, confirmed);
  assert.equal(f.creates.length, 1);
});

test('read/network error for reserved ID never means absence and never triggers a new create', async () => {
  const f = fixture(false);
  f.docs.createFromLegacy = async () => { throw new Error('create offline'); };
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed));
  let requests = 0;
  f.docs.createFromLegacy = async () => { requests++; return DOC_A; };
  f.docs.load = async () => { throw new Error('cannot confirm absence'); };
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), /cannot confirm absence/);
  assert.equal(requests, 0);
  assert.equal(f.allocations, 1);
});

test('an existing matching legacy document is adopted and duplicate markers block creation', async () => {
  const f = fixture(false);
  f.documents.set(DOC_B, { legacyId: LEGACY_A, scene: { ...copy(f.a), id: DOC_B, revision: 'existing' } });
  const result = await migrateLegacyCanvases(f.io, f.docs, confirmed);
  assert.equal(result.mapping[LEGACY_A], DOC_B);
  assert.equal(f.creates.length, 0);
  assert.equal(f.allocations, 0);
  const duplicate = fixture(false);
  duplicate.docs.findByLegacyId = async () => [DOC_A, DOC_B];
  await assert.rejects(() => migrateLegacyCanvases(duplicate.io, duplicate.docs, confirmed), /多个/);
  assert.equal(duplicate.creates.length, 0);
});

test('migrated content mismatch retains both versions and never rewrites or duplicates', async () => {
  const f = fixture(false);
  const load = f.docs.load;
  f.docs.load = async (...args) => { const scene = await load(...args); if (scene) scene.nodes[0].x++; return scene; };
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), /内容不一致/);
  assert.equal(f.manifest!.boards[0].stage, 'created');
  assert.equal(f.manifest!.mapping[LEGACY_A], DOC_A);
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), /内容不一致/);
  assert.equal(f.creates.length, 1);
  assert.equal(f.documents.get(DOC_A)!.scene.nodes[0].x, f.a.nodes[0].x);
});

test('changed or newly added legacy files after success do not silently remigrate', async () => {
  for (const added of [false, true]) {
    const f = fixture(false);
    await migrateLegacyCanvases(f.io, f.docs, confirmed);
    const before = copy(f.documents);
    f.files.set(filename(added ? LEGACY_B : LEGACY_A), raw(added ? f.b : { ...f.a, title: '旧格式又被修改' }));
    await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), /已改变|发生变化/);
    assert.equal(f.creates.length, 1);
    assert.deepEqual(f.documents, before);
  }
});

test('a legacy file changing mid-migration stops remaining creations and preserves completed mapping', async () => {
  const f = fixture();
  const create = f.docs.createFromLegacy;
  f.docs.createFromLegacy = async (...args) => { const id = await create(...args); f.files.set(filename(LEGACY_B), raw({ ...f.b, title: '并行旧编辑' })); return id; };
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), /迁移期间发生变化/);
  assert.equal(f.creates.length, 1);
  assert.equal(f.manifest!.mapping[LEGACY_A], DOC_A);
  assert.equal(f.manifest!.boards[0].stage, 'verified');
});

test('a corrupted journal is not replaced and no backup or document writes are attempted', async () => {
  const f = fixture(false);
  f.io.readManifest = async () => ({ version: 1, runId: '../bad', files: [], boards: [], mapping: {} });
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), CanvasMigrationError);
  assert.equal(f.events.length, 0);
  assert.equal(f.backups.size, 0);
  assert.equal(f.creates.length, 0);
});

test('invalid or duplicate allocated IDs cannot corrupt the persisted journal', async () => {
  const invalid = fixture(false);
  invalid.docs.allocateDocId = () => '../invalid';
  await assert.rejects(() => migrateLegacyCanvases(invalid.io, invalid.docs, confirmed), /预分配/);
  assert.equal(invalid.creates.length, 0);
  assert.equal(invalid.manifest!.boards[0].reservedDocId, undefined);
  assert.ok(await loadCanvasMigrationManifest(invalid.io));
  invalid.docs.allocateDocId = () => DOC_A;
  await migrateLegacyCanvases(invalid.io, invalid.docs, confirmed);
  const duplicate = fixture();
  duplicate.docs.allocateDocId = () => DOC_A;
  await assert.rejects(() => migrateLegacyCanvases(duplicate.io, duplicate.docs, confirmed), /预分配/);
  assert.equal(duplicate.creates.length, 1);
  assert.equal(duplicate.manifest!.boards[1].reservedDocId, undefined);
  assert.ok(await loadCanvasMigrationManifest(duplicate.io));
});

test('reserved ID occupied by a document with the wrong legacy marker is never adopted or replaced', async () => {
  const f = fixture(false);
  f.docs.createFromLegacy = async () => { throw new Error('request failed'); };
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed));
  const other = { legacyId: LEGACY_B, scene: { ...populated(LEGACY_B), id: DOC_A } };
  f.documents.set(DOC_A, copy(other));
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), /legacy marker mismatch/);
  assert.deepEqual(f.documents.get(DOC_A), other);
  assert.equal(f.creates.length, 0);
});

test('migration persists destination before any create and retries cannot change it for a reserved ID', async () => {
  const f = fixture(false);
  const destination = { notebook: DOC_B, parentId: '20261017120002-cdefghi' };
  const originalCreate = f.docs.createFromLegacy;
  const seenDestinations: unknown[] = [];
  let fail = true;
  f.docs.createFromLegacy = async (...args) => {
    seenDestinations.push(copy(f.manifest!.destination));
    assert.deepEqual(f.manifest!.destination, destination);
    if (fail) throw new Error('create offline');
    return originalCreate(...args);
  };
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, { confirmed: true, destination }));
  assert.deepEqual(f.manifest!.destination, destination);
  const reserved = f.manifest!.boards[0].reservedDocId;
  for (const changed of [{ notebook: DOC_A }, { notebook: DOC_B }, { notebook: DOC_B, parentId: DOC_A }]) {
    await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, { confirmed: true, destination: changed }), /固定保存位置/);
    assert.deepEqual(f.manifest!.destination, destination);
    assert.equal(f.manifest!.boards[0].reservedDocId, reserved);
  }
  assert.equal(seenDestinations.length, 1);
  fail = false;
  const result = await migrateLegacyCanvases(f.io, f.docs, confirmed);
  assert.deepEqual(result.destination, destination);
  assert.equal(f.allocations, 1);
  assert.equal(f.creates[0].reservedDocId, reserved);
});

test('invalid destination options or corrupt persisted destinations stop before writes', async () => {
  for (const destination of [{ notebook: '../bad' }, { notebook: DOC_A, parentId: '../bad' }, { notebook: DOC_A, parentID: DOC_B }]) {
    const f = fixture(false);
    await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, { confirmed: true, destination } as unknown as CanvasMigrationOptions), /保存位置无效/);
    assert.equal(f.events.length, 0);
  }
  const f = fixture(false);
  f.docs.createFromLegacy = async () => { throw new Error('request failed'); };
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed));
  f.manifest!.destination = { notebook: '../bad' };
  f.events.length = 0;
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed), /保存位置无效/);
  assert.deepEqual(f.events, ['manifest-read']);
});

test('destination may be added to an old journal only before any document creation attempt', async () => {
  const f = fixture(false);
  const backup = f.io.writeBackup;
  f.io.writeBackup = async () => { throw new Error('backup offline'); };
  await assert.rejects(() => migrateLegacyCanvases(f.io, f.docs, confirmed));
  assert.equal(f.manifest!.destination, undefined);
  f.io.writeBackup = backup;
  const destination = { notebook: DOC_B };
  const result = await migrateLegacyCanvases(f.io, f.docs, { confirmed: true, destination });
  assert.deepEqual(result.destination, destination);
  const attempted = fixture(false);
  attempted.docs.createFromLegacy = async () => { throw new Error('request failed'); };
  await assert.rejects(() => migrateLegacyCanvases(attempted.io, attempted.docs, confirmed));
  await assert.rejects(() => migrateLegacyCanvases(attempted.io, attempted.docs, { confirmed: true, destination }), /没有记录保存位置.*创建尝试/);
  assert.equal(attempted.manifest!.destination, undefined);
});
