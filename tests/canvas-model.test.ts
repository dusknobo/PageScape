import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScene, extractDropIds, newCanvasId, normalizeScene } from '../src/canvas/model';
import { CanvasConflictError, CanvasStorage, CanvasStorageError } from '../src/canvas/storage';
import { createCanvasIO } from '../src/canvas/io';
import type { CanvasScene, CanvasStorageIO } from '../src/canvas/types';

const DOC_A = '20261017120000-abcdefg';
const DOC_B = '20261017120001-bcdefgh';
const BOX = '20261017120002-cdefghi';
const copy = <T>(value: T): T => structuredClone(value);
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function populated(): CanvasScene {
  const scene = createScene('计算关系');
  scene.nodes = [
    {id: 'doc-a', kind: 'doc', docId: DOC_A, title: '流体', x: -12, y: 40, width: 280, height: 240, color: 'blue', groupId: 'missing-group'},
    {id: 'text-a', kind: 'text', text: '保留这段文字', x: 400, y: -20, width: 240, height: 160, color: 'neutral'},
  ];
  scene.edges = [{id: 'edge-a', from: 'doc-a', to: 'missing-node', label: '待恢复端点', color: 'green'}];
  return scene;
}

function memoryIO(): {files: Map<string, unknown>; io: CanvasStorageIO; writes: string[]} {
  const files = new Map<string, unknown>();
  const writes: string[] = [];
  return {
    files, writes,
    io: {
      async read(name) { await pause(); return copy(files.get(name)); },
      async write(name, value) { await pause(); writes.push(name); files.set(name, copy(value)); },
    },
  };
}

test('scene round-trip preserves orphan associations and owns only supported fields', () => {
  const scene = populated();
  const input = {...scene, unknown: 'ignored', nodes: scene.nodes.map(node => ({...node, script: 'no'}))};
  const normalized = normalizeScene(input);
  assert.deepEqual(normalized, scene);
  assert.equal(normalized.nodes[0].groupId, 'missing-group');
  assert.equal(normalized.edges[0].to, 'missing-node');
  normalized.nodes[0].x = 500;
  assert.equal(scene.nodes[0].x, -12);
});

test('secure scene IDs are UUIDs and cannot escape their storage directory', () => {
  assert.match(newCanvasId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => normalizeScene({...createScene('a'), id: '../escape'}), /ID/);
  assert.throws(() => normalizeScene({...createScene('a'), id: 'MixedCase'}), /ID/);
  assert.throws(() => normalizeScene({...createScene('a'), revision: '../../bad'}), /修订/);
});

test('unsupported versions, invalid geometry/document IDs, duplicate IDs and oversized text fail without truncation', () => {
  const scene = populated();
  assert.throws(() => normalizeScene({...scene, version: 2}), /版本/);
  for (const x of [NaN, Infinity, -Infinity, 10_000_001]) {
    assert.throws(() => normalizeScene({...scene, nodes: [{...scene.nodes[0], x}]}), /有限数字/);
  }
  assert.throws(() => normalizeScene({...scene, nodes: [{...scene.nodes[0], width: 0}]}), /宽度/);
  assert.throws(() => normalizeScene({...scene, nodes: [{...scene.nodes[0], docId: BOX + '/x'}]}), /文档 ID/);
  assert.throws(() => normalizeScene({...scene, nodes: [scene.nodes[0], scene.nodes[0]]}), /重复/);
  assert.throws(() => normalizeScene({...scene, edges: [scene.edges[0], scene.edges[0]]}), /重复/);
  assert.throws(() => normalizeScene({...scene, nodes: [{...scene.nodes[1], text: 'x'.repeat(50_001)}]}), /未截断/);
  assert.throws(() => normalizeScene({...scene, nodes: Array.from({length: 2_001}, (_, index) => ({...scene.nodes[1], id: `text-${index}`}))}), /2000/);
});

test('document drops accept explicit native selection and tab payloads, links, and standalone IDs', () => {
  assert.deepEqual(extractDropIds(JSON.stringify({ids: [DOC_B, DOC_A, DOC_B], notebook: BOX, children: [{id: BOX}]})), [DOC_B, DOC_A]);
  assert.deepEqual(extractDropIds(JSON.stringify({rootId: DOC_A, tabId: BOX, title: '父页'})), [DOC_A]);
  assert.deepEqual(extractDropIds(JSON.stringify([DOC_A, DOC_B, DOC_A])), [DOC_A, DOC_B]);
  assert.deepEqual(extractDropIds(`[A](siyuan://blocks/${DOC_A})\nsiyuan://blocks/${DOC_B}?focus=1\nsiyuan://blocks/${DOC_A}`), [DOC_A, DOC_B]);
  assert.deepEqual(extractDropIds(`${DOC_A},${DOC_B}`), [DOC_A, DOC_B]);
  assert.deepEqual(extractDropIds(JSON.stringify({id: BOX, type: 'navigation-root', children: [{id: DOC_A}]})), []);
  assert.deepEqual(extractDropIds(JSON.stringify({ids: [BOX], type: 'navigation-root'})), []);
  assert.deepEqual(extractDropIds(`<ul data-node-id="${BOX}"><li data-node-id="${DOC_A}"><a href="siyuan://blocks/${DOC_B}">Child</a></li></ul>`), []);
  assert.deepEqual(extractDropIds('prefix ' + DOC_A), []);
  assert.deepEqual(extractDropIds('{broken json'), []);
});

test('save/load and copy use independent files and revision tokens', async () => {
  const {files, io} = memoryIO();
  const store = new CanvasStorage(io);
  const scene = await store.save(populated(), null);
  assert.ok(scene.revision);
  assert.deepEqual(await store.load(scene.id), scene);
  const duplicate = await store.copy(scene);
  assert.notEqual(duplicate.id, scene.id);
  assert.notEqual(duplicate.revision, scene.revision);
  assert.deepEqual(duplicate.nodes, scene.nodes);
  assert.deepEqual(duplicate.edges, scene.edges);
  assert.ok(files.has(`canvas-${scene.id}.json`));
  assert.equal((await store.list()).length, 2);
});

test('two stale writers cannot overwrite each other; the loser receives the latest intact scene', async () => {
  const {files, io} = memoryIO();
  const firstStore = new CanvasStorage(io), secondStore = new CanvasStorage(io);
  const original = await firstStore.create('原版');
  const results = await Promise.allSettled([
    firstStore.save({...original, title: '窗口 A'}, original.revision),
    secondStore.save({...original, title: '窗口 B'}, original.revision),
  ]);
  const fulfilled = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const winner = (fulfilled[0] as PromiseFulfilledResult<CanvasScene>).value;
  const conflict = (rejected[0] as PromiseRejectedResult).reason;
  assert.ok(conflict instanceof CanvasConflictError);
  assert.deepEqual(conflict.latest, winner);
  assert.deepEqual(files.get(`canvas-${original.id}.json`), winner);
  await assert.rejects(firstStore.save(original, null), CanvasConflictError);
});

test('concurrent creation merges the fresh index instead of dropping another board', async () => {
  const {io} = memoryIO();
  const a = new CanvasStorage(io), b = new CanvasStorage(io);
  const boards = await Promise.all(Array.from({length: 10}, (_, index) => (index % 2 ? a : b).create(`画布 ${index}`)));
  const summaries = await a.list();
  assert.deepEqual(new Set(summaries.map(board => board.id)), new Set(boards.map(board => board.id)));
});

test('fresh reads detect externally changed revisions and do not overwrite malformed JSON', async () => {
  const {files, io, writes} = memoryIO();
  const store = new CanvasStorage(io);
  const scene = await store.create('原版');
  const external = {...scene, title: '外部修改', revision: newCanvasId()};
  files.set(`canvas-${scene.id}.json`, JSON.stringify(external));
  await assert.rejects(store.save({...scene, title: '过时窗口'}, scene.revision), error => error instanceof CanvasConflictError && error.latest.title === '外部修改');
  const count = writes.length;
  files.set(`canvas-${scene.id}.json`, '{damaged');
  await assert.rejects(store.load(scene.id), /JSON 已损坏/);
  await assert.rejects(store.save(scene, scene.revision), /JSON 已损坏/);
  assert.equal(writes.length, count);
  files.set('canvas-index.json', '');
  await assert.rejects(store.list(), /JSON 已损坏/);
});

test('an index failure reports the durable scene and permits revision-correct recovery', async () => {
  const {files, io} = memoryIO();
  let broken = true;
  const store = new CanvasStorage({
    read: io.read,
    write: async (name, value) => { if (name === 'canvas-index.json' && broken) throw new Error('disk error'); await io.write(name, value); },
  });
  let saved!: CanvasScene;
  await assert.rejects(store.create('可恢复'), error => {
    assert.ok(error instanceof CanvasStorageError);
    saved = error.savedScene;
    return true;
  });
  assert.deepEqual(await store.load(saved.id), saved);
  assert.ok(files.has(`canvas-${saved.id}.json`));
  broken = false;
  const recovered = await store.save(saved, saved.revision);
  assert.notEqual(recovered.revision, saved.revision);
  assert.deepEqual((await store.list()).map(board => board.id), [saved.id]);
});

test('a corrupt index is never replaced with an empty directory after a board save', async () => {
  const {files, io} = memoryIO();
  const corrupt = {version: 99, boards: []};
  files.set('canvas-index.json', corrupt);
  const store = new CanvasStorage(io);
  await assert.rejects(store.list(), /版本/);
  await assert.rejects(store.create('留下原件'), CanvasStorageError);
  assert.deepEqual(files.get('canvas-index.json'), corrupt);
});

test('JSON null is invalid persisted data, not a missing file that may be overwritten', async () => {
  const {files, io, writes} = memoryIO();
  const store = new CanvasStorage(io);
  const scene = createScene('null 原件');
  for (const invalid of [null, 'null']) {
    files.set(`canvas-${scene.id}.json`, invalid);
    const count = writes.length;
    await assert.rejects(store.load(scene.id), /格式/);
    await assert.rejects(store.save(scene, null), /格式/);
    assert.equal(writes.length, count);
    files.set('canvas-index.json', invalid);
    await assert.rejects(store.list(), /格式/);
  }
});

test('fresh IO distinguishes getFile 202/not-found from permission, disk and service failures', async () => {
  const originalFetch = globalThis.fetch;
  const io = createCanvasIO('siyuan-child-cards');
  const name = `canvas-${newCanvasId()}.json`;
  let response: Response;
  const requests: Array<{url: string; init?: RequestInit}> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({url: String(input), init});
    return response;
  }) as typeof fetch;
  try {
    response = new Response(JSON.stringify({code: 404, msg: 'not found', data: null}), {status: 202});
    assert.equal(await io.read(name), undefined);
    for (const code of [500, 503, 403, -3]) {
      response = new Response(JSON.stringify({code, msg: `getFile error ${code}`, data: null}), {status: 202});
      await assert.rejects(io.read(name), new RegExp(`getFile error ${code}`));
    }
    response = new Response('{invalid json', {status: 202});
    await assert.rejects(io.read(name), /损坏/);
    response = new Response(JSON.stringify({code: 0, data: null}), {status: 202});
    await assert.rejects(io.read(name), /无法读取/);
    response = new Response('', {status: 404});
    assert.equal(await io.read(name), undefined);
    const scene = populated();
    response = new Response(JSON.stringify(scene), {status: 200, headers: {'Content-Type': 'application/json'}});
    assert.deepEqual(await io.read(name), scene);
    for (const request of requests) {
      assert.equal(request.url, '/api/file/getFile');
      assert.equal(request.init?.method, 'POST');
      assert.equal(request.init?.cache, 'no-store');
      assert.deepEqual(JSON.parse(String(request.init?.body)), {path: `/data/storage/petal/siyuan-child-cards/${name}`});
    }
  } finally { globalThis.fetch = originalFetch; }
});
