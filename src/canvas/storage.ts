import { createScene, newCanvasId, normalizeScene } from './model';
import type { CanvasScene, CanvasStorageIO, CanvasStore, CanvasSummary } from './types';

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const INDEX = 'canvas-index.json';
const queues = new Map<string, Promise<void>>();

export class CanvasConflictError extends Error {
  constructor(public latest: CanvasScene) {
    super('画布已在另一处修改。请加载最新版本或另存为副本；未覆盖已有版本。');
    this.name = 'CanvasConflictError';
  }
}

/** The board is durable even when its directory entry could not be updated. */
export class CanvasStorageError extends Error {
  constructor(public savedScene: CanvasScene, cause: unknown, message?: string) {
    super(message || `画布已保存，但画布列表更新失败。可通过画布 ID ${savedScene.id} 恢复，请重试保存。`, {cause});
    this.name = 'CanvasStorageError';
  }
}

function validId(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error('画布 ID 无效');
  return value;
}

function filename(id: string): string { return `canvas-${validId(id)}.json`; }

function decode(value: unknown, name: string): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); }
  catch (cause) { throw new Error(`${name} 的 JSON 已损坏，未覆盖原文件`, {cause}); }
}

function summaries(value: unknown): CanvasSummary[] {
  const index = decode(value, INDEX);
  if (index === undefined) return [];
  if (!index || typeof index !== 'object' || Array.isArray(index)) throw new Error('画布列表格式无效，未覆盖原文件');
  const object = index as Record<string, unknown>;
  if (object.version !== 1 || !Array.isArray(object.boards)) throw new Error('画布列表版本或内容无效，未覆盖原文件');
  if (object.boards.length > 10_000) throw new Error('画布列表过大，未截断或覆盖原文件');
  const ids = new Set<string>();
  return object.boards.map((value: unknown): CanvasSummary => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('画布列表条目无效');
    const item = value as Record<string, unknown>;
    const id = validId(item.id);
    if (ids.has(id)) throw new Error(`画布列表 ID 重复：${id}`);
    ids.add(id);
    if (typeof item.title !== 'string' || item.title.length > 300 ||
      typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt) || item.updatedAt < 0 ||
      item.updatedAt > 8_640_000_000_000_000) throw new Error('画布列表条目无效，未覆盖原文件');
    return {id, title: item.title, updatedAt: item.updatedAt};
  });
}

function sorted(boards: CanvasSummary[]): CanvasSummary[] {
  return boards.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/** Browser locks coordinate tabs; the queue fallback coordinates this JS realm. */
async function locked<T>(key: string, action: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks && typeof locks.request === 'function') return locks.request(`siyuan-child-cards:${key}`, action);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  const marker = next.then(() => undefined, () => undefined);
  queues.set(key, marker);
  try { return await next; }
  finally { if (queues.get(key) === marker) queues.delete(key); }
}

export class CanvasStorage implements CanvasStore {
  constructor(private io: CanvasStorageIO) {}

  async list(): Promise<CanvasSummary[]> {
    return locked('canvas-index', async () => sorted(summaries(await this.io.read(INDEX))));
  }

  async load(id: string): Promise<CanvasScene> {
    const name = filename(id);
    const value = decode(await this.io.read(name), name);
    if (value === undefined) throw new Error('画布文件不存在');
    const scene = normalizeScene(value);
    if (scene.id !== id) throw new Error('画布文件与其 ID 不匹配，未修改原文件');
    return scene;
  }

  async save(scene: CanvasScene, expectedRevision: string | null): Promise<CanvasScene> {
    const snapshot = normalizeScene(scene);
    if (expectedRevision !== null) validId(expectedRevision);
    return locked(`canvas:${snapshot.id}`, async () => {
      const name = filename(snapshot.id);
      const raw = decode(await this.io.read(name), name);
      if (raw !== undefined) {
        const latest = normalizeScene(raw);
        if (latest.id !== snapshot.id) throw new Error('画布文件与其 ID 不匹配，未覆盖原文件');
        if (expectedRevision === null || latest.revision !== expectedRevision) throw new CanvasConflictError(latest);
      } else if (expectedRevision !== null) {
        throw new Error('画布文件已不存在，请另存为副本；未创建替代文件');
      }
      const saved: CanvasScene = {...snapshot, revision: newCanvasId(), updatedAt: Date.now()};
      await this.io.write(name, saved);
      try {
        await locked('canvas-index', async () => {
          const boards = summaries(await this.io.read(INDEX));
          const metadata = {id: saved.id, title: saved.title, updatedAt: saved.updatedAt};
          const existing = boards.findIndex(board => board.id === saved.id);
          if (existing < 0) boards.push(metadata);
          else boards[existing] = metadata;
          if (boards.length > 10_000) throw new Error('画布列表已达到上限');
          await this.io.write(INDEX, {version: 1, boards: sorted(boards)});
        });
      } catch (cause) { throw new CanvasStorageError(saved, cause); }
      return saved;
    });
  }

  async create(title: string): Promise<CanvasScene> {
    return this.save(createScene(title), null);
  }

  async copy(scene: CanvasScene): Promise<CanvasScene> {
    const source = normalizeScene(scene);
    return this.save({
      ...source, id: newCanvasId(), revision: null,
      title: source.title.length <= 297 ? `${source.title} 副本` : source.title,
      updatedAt: Date.now(),
    }, null);
  }
}
