import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, blockMarkdown, parseConfig } from '../src/config';
import { parseNoteChange } from '../src/events';
import { PreviewCache } from '../src/cache';
import type { DocInfo, PreviewData } from '../src/types';

const first = '20261017000001-abcdefg';
const second = '20261017000002-hijklmn';
const third = '20261017000003-opqrstu';
const doc: DocInfo = {
  id: first, title: '测试子页', icon: '', notebook: second,
  path: `/${first}.sy`, childCount: 0,
};
const preview = (text: string): PreviewData => ({ dom: `<p>${text}</p>`, eof: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('configuration defaults remain usable without a version field', () => {
  assert.deepEqual(parseConfig(''), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig('{}'), DEFAULT_CONFIG);
  const parsed = parseConfig('{"columns":2,"showImages":false,"autoRefresh":false}');
  assert.deepEqual(parsed, { ...DEFAULT_CONFIG, columns: 2, showImages: false, autoRefresh: false });
  parsed.columns = 4;
  assert.equal(DEFAULT_CONFIG.columns, 0, 'parsing must not mutate shared defaults');
});

test('configuration rejects malformed, non-object and future-version content', () => {
  for (const text of ['{', 'null', '[]', '"hello"', 'false', '12']) {
    assert.throws(() => parseConfig(text), undefined, `must reject ${text}`);
  }
  assert.throws(() => parseConfig('{"version":2}'), /更新版本/);
  assert.throws(() => parseConfig('{"version":0}'), /更新版本/);
});

test('configuration bounds layout inputs without coercing invalid booleans', () => {
  assert.equal(parseConfig('{"previewHeight":20}').previewHeight, 140);
  assert.equal(parseConfig('{"previewHeight":1000}').previewHeight, 400);
  assert.equal(parseConfig('{"previewHeight":200.6}').previewHeight, 201);
  assert.equal(parseConfig('{"previewHeight":"300"}').previewHeight, 200);
  assert.deepEqual(parseConfig('{"columns":20,"showImages":"false","autoRefresh":0}'), DEFAULT_CONFIG);
  for (const columns of [0, 1, 2, 3, 4]) {
    assert.equal(parseConfig(JSON.stringify({ columns })).columns, columns);
  }
});

test('inserted custom block contains an encoded plugin name and recoverable versioned settings', () => {
  const markdown = blockMarkdown('子页/卡片\n;;;');
  const lines = markdown.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `;;;${encodeURIComponent('子页/卡片\n;;;')}/child-cards`);
  assert.deepEqual(parseConfig(lines[1]), DEFAULT_CONFIG);
  assert.equal(lines[2], ';;;');
});

test('unknown or malformed websocket messages have no accidental document changes', () => {
  for (const detail of [undefined, null, [], 1, 'savedoc', {}, { cmd: 1 }, { cmd: 'unrelated', data: { id: first } }]) {
    const change = parseNoteChange(detail);
    assert.deepEqual([...change.ids], []);
    assert.equal(change.structure, false);
  }
  assert.deepEqual([...parseNoteChange({ cmd: 'savedoc', data: { rootID: 'invalid' } }).ids], []);
  assert.deepEqual([...parseNoteChange({ cmd: 'savedoc', data: [] }).ids], []);
});

test('content messages use document root IDs and deduplicate shared roots', () => {
  assert.deepEqual([...parseNoteChange({ cmd: 'savedoc', data: { rootID: first } }).ids], [first]);
  const change = parseNoteChange({
    cmd: 'transactions',
    context: { rootIDs: [first, first, second, null, 'not-a-block'] },
    data: [{ doOperations: [{ id: third, action: 'update' }] }],
  });
  assert.deepEqual([...change.ids], [first, second]);
  assert.equal(change.structure, false, 'ordinary updates must not reload every gallery structure');
  assert.deepEqual([...parseNoteChange({ cmd: 'transactions', context: { rootIDs: first } }).ids], []);
});

test('document-tree events signal structure changes even when no root is known', () => {
  for (const cmd of ['create', 'createdailynote', 'heading2doc', 'li2doc', 'docsImported', 'removeDoc', 'moveDoc', 'moveDocs', 'rename', 'filetreeSortChanged', 'docSortModeChanged']) {
    assert.equal(parseNoteChange({ cmd }).structure, true, cmd);
  }
  const change = parseNoteChange({ cmd: 'rename', data: { id: first, ids: [first, second], path: `/some/${second}.sy`, parentPath: `/${third}.sy/` } });
  assert.deepEqual([...change.ids], [first, second, third]);
});

test('move events discover old and new document IDs without treating arbitrary paths as IDs', () => {
  const moved = parseNoteChange({ cmd: 'moveDocs', data: {
    moves: [null, [], { fromPath: `/${first}.sy`, toPath: `/parent/${second}.sy`, newPath: `/${third}.sy` }, { fromPath: '/not-a-document.sy' }],
  } });
  assert.equal(moved.structure, true);
  assert.deepEqual([...moved.ids], [first, second, third]);
  const single = parseNoteChange({ cmd: 'moveDoc', data: { fromPath: `/${first}.sy`, toPath: `/${second}.sy` } });
  assert.deepEqual([...single.ids], [first, second]);
});

test('preview cache shares one in-flight read and later serves its cached result', async () => {
  const pending = deferred<PreviewData>();
  let reads = 0;
  const cache = new PreviewCache(async () => { reads++; return pending.promise; });
  const a = cache.get(doc, new AbortController().signal);
  const b = cache.get(doc, new AbortController().signal);
  await Promise.resolve(); // Loading may begin in a microtask to capture synchronous errors.
  assert.equal(reads, 1);
  const value = preview('shared');
  pending.resolve(value);
  assert.equal(await a, value);
  assert.equal(await b, value);
  assert.equal(await cache.get(doc, new AbortController().signal), value);
  assert.equal(reads, 1);
  cache.clear();
});

test('cancelling one gallery does not cancel another gallery using the same read', async () => {
  const pending = deferred<PreviewData>();
  let loaderSignal!: AbortSignal;
  const cache = new PreviewCache(async (_doc, signal) => { loaderSignal = signal; return pending.promise; });
  const a = new AbortController();
  const b = new AbortController();
  const readingA = cache.get(doc, a.signal);
  const readingB = cache.get(doc, b.signal);
  await Promise.resolve();
  const rejectedA = assert.rejects(readingA, { name: 'AbortError' });
  a.abort();
  await rejectedA;
  assert.equal(loaderSignal.aborted, false);
  const value = preview('still needed');
  pending.resolve(value);
  assert.equal(await readingB, value);
  assert.equal(loaderSignal.aborted, false, 'completed cached reads should not be aborted');
  cache.clear();
});

test('the last consumer cancelling aborts the underlying read', async () => {
  const pending = deferred<PreviewData>();
  let loaderSignal!: AbortSignal;
  const cache = new PreviewCache(async (_doc, signal) => { loaderSignal = signal; return pending.promise; });
  const controller = new AbortController();
  const reading = cache.get(doc, controller.signal);
  await Promise.resolve(); // Exercise an active underlying read rather than cancelling before it starts.
  const rejected = assert.rejects(reading, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.equal(loaderSignal.aborted, true);
  // A loader that ignores AbortSignal may still finish; that result must not become cached.
  pending.resolve(preview('cancelled result'));
  await new Promise<void>(resolve => setImmediate(resolve));
  cache.clear();
});

test('already-aborted consumers do not start reads or consume cached data', async () => {
  let reads = 0;
  const cache = new PreviewCache(async () => { reads++; return preview('value'); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(cache.get(doc, controller.signal), { name: 'AbortError' });
  assert.equal(reads, 0);
  await cache.get(doc, new AbortController().signal);
  await assert.rejects(cache.get(doc, controller.signal), { name: 'AbortError' });
  assert.equal(reads, 1);
  cache.clear();
});

test('an invalidated old request cannot overwrite a newer cached preview', async () => {
  const old = deferred<PreviewData>();
  const current = deferred<PreviewData>();
  let reads = 0;
  const cache = new PreviewCache(async () => (++reads === 1 ? old.promise : current.promise));
  const oldRead = cache.get(doc, new AbortController().signal);
  await Promise.resolve();
  cache.invalidate(doc.id);
  const newRead = cache.get(doc, new AbortController().signal);
  await Promise.resolve();
  assert.equal(reads, 2);
  const freshValue = preview('fresh');
  current.resolve(freshValue);
  assert.equal(await newRead, freshValue);
  old.resolve(preview('stale'));
  assert.equal((await oldRead).dom, '<p>stale</p>', 'existing consumer may finish its original request');
  assert.equal(await cache.get(doc, new AbortController().signal), freshValue);
  assert.equal(reads, 2, 'the newer cached value must survive the old completion');
  cache.clear();
});

test('old completion before the replacement request also cannot repopulate invalidated cache', async () => {
  const old = deferred<PreviewData>();
  const current = deferred<PreviewData>();
  let reads = 0;
  const cache = new PreviewCache(async () => (++reads === 1 ? old.promise : current.promise));
  const firstRead = cache.get(doc, new AbortController().signal);
  await Promise.resolve();
  cache.invalidate(doc.id);
  old.resolve(preview('old'));
  await firstRead;
  const secondRead = cache.get(doc, new AbortController().signal);
  await Promise.resolve();
  assert.equal(reads, 2);
  current.resolve(preview('new'));
  assert.equal((await secondRead).dom, '<p>new</p>');
  cache.clear();
});

test('a same-tick new consumer never joins the request aborted by the last previous consumer', async () => {
  const old = deferred<PreviewData>();
  const current = deferred<PreviewData>();
  const loaderSignals: AbortSignal[] = [];
  const cache = new PreviewCache(async (_doc, signal) => {
    loaderSignals.push(signal);
    return loaderSignals.length === 1 ? old.promise : current.promise;
  });
  const firstConsumer = new AbortController();
  const oldRead = cache.get(doc, firstConsumer.signal);
  await Promise.resolve();
  const oldRejected = assert.rejects(oldRead, { name: 'AbortError' });
  firstConsumer.abort();
  // Deliberately do not yield after abort: old rejection/finally callbacks have not run.
  const newRead = cache.get(doc, new AbortController().signal);
  await Promise.resolve();
  assert.equal(loaderSignals.length, 2);
  assert.equal(loaderSignals[0].aborted, true);
  assert.equal(loaderSignals[1].aborted, false);
  const fresh = preview('replacement request');
  old.resolve(preview('cancelled old request'));
  current.resolve(fresh);
  await oldRejected;
  assert.equal(await newRead, fresh);
  assert.equal(await cache.get(doc, new AbortController().signal), fresh);
  assert.equal(loaderSignals.length, 2);
  cache.clear();
});

test('synchronous loader failures reject the read and leave it retryable', async () => {
  let reads = 0;
  const value = preview('retry succeeded');
  const cache = new PreviewCache(() => {
    if (++reads === 1) throw new Error('temporary read failure');
    return Promise.resolve(value);
  });
  let firstRead!: Promise<PreviewData>;
  assert.doesNotThrow(() => { firstRead = cache.get(doc, new AbortController().signal); });
  await assert.rejects(firstRead, /temporary read failure/);
  assert.equal(await cache.get(doc, new AbortController().signal), value);
  assert.equal(reads, 2);
  cache.clear();
});
