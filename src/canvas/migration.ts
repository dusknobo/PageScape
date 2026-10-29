import { newCanvasId, normalizeScene } from './model';
import type { CanvasDestination, CanvasScene } from './types';

export const CANVAS_MIGRATION_MANIFEST = 'canvas-migration.json';
export const CANVAS_MIGRATION_BACKUPS = 'canvas-backups';
const INDEX = 'canvas-index.json';
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const DOC_ID = /^\d{14}-[a-z0-9]{7}$/;
const FILE = /^canvas-[a-zA-Z0-9_-]+\.json$/;
const HASH = /^[0-9a-f]{64}$/;

export interface CanvasMigrationFile {
  name: string;
  size: number;
  sha256: string;
  verified: boolean;
}
export interface CanvasMigrationBoard {
  legacyId: string;
  fileName: string;
  sourceSha256: string;
  stage: 'pending' | 'creating' | 'creation-uncertain' | 'created' | 'verified';
  reservedDocId?: string;
  docId?: string;
}
export interface CanvasMigrationManifest {
  version: 1;
  runId: string;
  stage: 'backing-up' | 'backup-verified' | 'migrating' | 'complete';
  createdAt: number;
  updatedAt: number;
  files: CanvasMigrationFile[];
  boards: CanvasMigrationBoard[];
  mapping: Record<string, string>;
  destination?: CanvasDestination;
  lastError?: string;
}

/**
 * All paths are relative to this plugin's storage directory. Implementations
 * must read fresh bytes, preserve backup bytes verbatim, and persist manifests
 * at canvas-migration.json. There is deliberately no legacy-write/delete API.
 */
export interface CanvasMigrationIO {
  listLegacy(): Promise<string[]>;
  readLegacy(name: string): Promise<Uint8Array>;
  readBackup(runId: string, name: string): Promise<Uint8Array | undefined>;
  writeBackup(runId: string, name: string, bytes: Uint8Array): Promise<void>;
  readManifest(): Promise<unknown | undefined>;
  writeManifest(manifest: CanvasMigrationManifest): Promise<void>;
}

export interface CanvasMigrationDocuments {
  allocateDocId(): string;
  findByLegacyId(legacyId: string): Promise<string[]>;
  /**
   * Create with the pre-reserved document ID and atomic legacy-ID marker in
   * the initial document content/attributes. Never overwrite an existing ID.
   * An uncertain request may be retried only with this same reserved ID.
   */
  createFromLegacy(scene: CanvasScene, legacyId: string, migrationId: string, reservedDocId: string): Promise<string>;
  /**
   * undefined means confirmed absence, never a network/parse/permission error.
   * If expectedLegacyId is supplied, reject documents with a different/missing
   * marker, including ordinary documents that happen to occupy the reserved ID.
   */
  load(docId: string, expectedLegacyId?: string): Promise<CanvasScene | undefined>;
}
export interface CanvasMigrationOptions {
  confirmed: true;
  destination?: CanvasDestination;
  onProgress?: (manifest: CanvasMigrationManifest) => void;
}

export class CanvasMigrationError extends Error {
  constructor(message: string, public readonly manifest?: CanvasMigrationManifest, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CanvasMigrationError';
  }
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const explain = (error: unknown) => error instanceof Error ? error.message : String(error || '操作失败');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validFile = (name: string) => FILE.test(name) && name !== CANVAS_MIGRATION_MANIFEST;

function destinationValue(value: unknown): CanvasDestination {
  if (!object(value) || typeof value.notebook !== 'string' || !DOC_ID.test(value.notebook) ||
    (value.parentId !== undefined && (typeof value.parentId !== 'string' || !DOC_ID.test(value.parentId))) ||
    Object.keys(value).some(key => key !== 'notebook' && key !== 'parentId')) {
    throw new Error('迁移保存位置无效，未创建或移动任何画布文档');
  }
  return { notebook: value.notebook, ...(value.parentId === undefined ? {} : { parentId: value.parentId as string }) };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array)) throw new Error('迁移备份必须使用完整原始字节');
  const hash = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Compare every supported content field, retaining array order and orphan IDs. */
export function sameMigratedCanvasContent(before: CanvasScene, after: CanvasScene): boolean {
  const content = (value: CanvasScene) => {
    const { id: _id, revision: _revision, updatedAt: _updatedAt, ...rest } = normalizeScene(value);
    return rest;
  };
  return canonical(content(before)) === canonical(content(after));
}

function decode(bytes: Uint8Array, name: string): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (cause) { throw new Error(`${name} 无法解析；完整原件和备份均保留`, { cause }); }
}

function manifestValue(raw: unknown): CanvasMigrationManifest | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { throw new Error('迁移清单损坏，未覆盖原清单'); }
  }
  if (!object(raw) || raw.version !== 1 || typeof raw.runId !== 'string' || !SAFE_ID.test(raw.runId) ||
    !['backing-up', 'backup-verified', 'migrating', 'complete'].includes(String(raw.stage)) ||
    typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt) || raw.createdAt < 0 ||
    typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0 ||
    !Array.isArray(raw.files) || !Array.isArray(raw.boards) || !object(raw.mapping)) {
    throw new Error('迁移清单格式无效，未覆盖原清单');
  }
  const names = new Set<string>();
  for (const file of raw.files) {
    if (!object(file) || typeof file.name !== 'string' || !validFile(file.name) || names.has(file.name) ||
      typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0 ||
      typeof file.sha256 !== 'string' || !HASH.test(file.sha256) || typeof file.verified !== 'boolean') {
      throw new Error('迁移文件清单无效，未覆盖原清单');
    }
    names.add(file.name);
  }
  const ids = new Set<string>();
  const targetIds = new Set<string>();
  const reservations = new Map<string, string>();
  for (const board of raw.boards) {
    if (!object(board) || typeof board.legacyId !== 'string' || !SAFE_ID.test(board.legacyId) || ids.has(board.legacyId) ||
      board.fileName !== `canvas-${board.legacyId}.json` || !names.has(board.fileName as string) ||
      typeof board.sourceSha256 !== 'string' || !HASH.test(board.sourceSha256) ||
      !['pending', 'creating', 'creation-uncertain', 'created', 'verified'].includes(String(board.stage)) ||
      (board.reservedDocId !== undefined && (typeof board.reservedDocId !== 'string' || !DOC_ID.test(board.reservedDocId))) ||
      (board.docId !== undefined && (typeof board.docId !== 'string' || !DOC_ID.test(board.docId))) ||
      ((board.stage === 'creating' || board.stage === 'creation-uncertain') && !board.reservedDocId) ||
      ((board.stage === 'created' || board.stage === 'verified') && !board.docId)) {
      throw new Error('迁移画布清单无效，未覆盖原清单');
    }
    const file = raw.files.find(file => object(file) && file.name === board.fileName) as Record<string, unknown>;
    if (file.sha256 !== board.sourceSha256) throw new Error('迁移画布与原始文件哈希不匹配');
    ids.add(board.legacyId);
    for (const target of [board.reservedDocId, board.docId]) {
      if (!target) continue;
      if (reservations.has(target as string) && reservations.get(target as string) !== board.legacyId) throw new Error('迁移文档预留 ID 重复');
      reservations.set(target as string, board.legacyId);
    }
    if (board.docId) {
      if (targetIds.has(board.docId as string) || raw.mapping[board.legacyId] !== board.docId) throw new Error('迁移映射重复或不一致');
      targetIds.add(board.docId as string);
    } else if (Object.hasOwn(raw.mapping, board.legacyId)) throw new Error('迁移映射缺少对应文档记录');
  }
  for (const [id, docId] of Object.entries(raw.mapping)) {
    if (!ids.has(id) || typeof docId !== 'string' || !DOC_ID.test(docId)) throw new Error('迁移映射无效');
  }
  if (raw.lastError !== undefined && typeof raw.lastError !== 'string') throw new Error('迁移错误记录无效');
  if (raw.destination !== undefined) destinationValue(raw.destination);
  if (raw.stage === 'backing-up' && (raw.boards.length || Object.keys(raw.mapping).length)) throw new Error('尚未验证的备份不能包含文档迁移记录');
  if (raw.stage !== 'backing-up' && raw.files.some(file => !(file as { verified: boolean }).verified)) throw new Error('迁移备份尚未全部验证');
  if (raw.stage !== 'backing-up' && raw.boards.length !== raw.files.filter(file => (file as { name: string }).name !== INDEX).length) throw new Error('迁移画布清单存在遗漏');
  if (raw.stage === 'complete' && raw.boards.some(board => (board as { stage: string }).stage !== 'verified')) throw new Error('迁移清单尚未完成内容校验');
  return copy(raw as unknown as CanvasMigrationManifest);
}

export async function loadCanvasMigrationManifest(io: Pick<CanvasMigrationIO, 'readManifest'>): Promise<CanvasMigrationManifest | undefined> {
  return manifestValue(await io.readManifest());
}

async function namesIn(io: CanvasMigrationIO): Promise<string[]> {
  const listed = await io.listLegacy();
  if (!Array.isArray(listed) || listed.some(name => typeof name !== 'string')) throw new Error('旧画布目录清单无效');
  if (listed.some(name => name.startsWith('canvas-') && name.endsWith('.json') && !FILE.test(name))) throw new Error('旧画布目录包含异常文件名，未开始迁移');
  return [...new Set(listed.filter(validFile))].sort();
}

async function sourceSnapshot(io: CanvasMigrationIO): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const name of await namesIn(io)) {
    const bytes = await io.readLegacy(name);
    if (!(bytes instanceof Uint8Array)) throw new Error(`${name} 未返回完整原始字节`);
    files.set(name, Uint8Array.from(bytes));
  }
  return files;
}

async function assertSourceUnchanged(io: CanvasMigrationIO, manifest: CanvasMigrationManifest): Promise<Map<string, Uint8Array>> {
  const snapshot = await sourceSnapshot(io);
  if (canonical([...snapshot.keys()]) !== canonical(manifest.files.map(file => file.name).sort())) {
    throw new Error('旧画布文件列表已改变，已停止迁移；不会静默迁移新增内容或覆盖已迁移文档');
  }
  for (const file of manifest.files) {
    const bytes = snapshot.get(file.name)!;
    if (bytes.byteLength !== file.size || await sha256Bytes(bytes) !== file.sha256) {
      throw new Error(`${file.name} 在建立备份后已改变，已停止迁移；原件、已有备份及已迁移文档均保留`);
    }
  }
  return snapshot;
}

function scenesIn(snapshot: Map<string, Uint8Array>): Map<string, CanvasScene> {
  const scenes = new Map<string, CanvasScene>();
  for (const [name, bytes] of snapshot) {
    if (name === INDEX) continue;
    const scene = normalizeScene(decode(bytes, name));
    if (name !== `canvas-${scene.id}.json`) throw new Error(`${name} 的文件名与画布 ID 不一致`);
    scenes.set(scene.id, scene);
  }
  const bytes = snapshot.get(INDEX);
  if (bytes) {
    const index = decode(bytes, INDEX);
    if (!object(index) || index.version !== 1 || !Array.isArray(index.boards)) throw new Error('旧画布索引格式无效，备份已保留但未创建文档');
    const ids = new Set<string>();
    for (const board of index.boards) {
      if (!object(board) || typeof board.id !== 'string' || !SAFE_ID.test(board.id) || ids.has(board.id) ||
        typeof board.title !== 'string' || board.title.length > 300 || typeof board.updatedAt !== 'number' ||
        !Number.isFinite(board.updatedAt) || board.updatedAt < 0 || !scenes.has(board.id)) {
        throw new Error('旧画布索引有重复、异常或缺少原文件的记录；备份已保留但未创建文档');
      }
      ids.add(board.id);
    }
  }
  return scenes;
}

let queue: Promise<void> = Promise.resolve();
async function locked<T>(action: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks?.request) return locks.request('siyuan-child-cards:canvas-document-migration', action);
  const task = queue.catch(() => undefined).then(action);
  queue = task.then(() => undefined, () => undefined);
  return task;
}

/** No migration is run until the caller explicitly supplies confirmed: true. */
export async function migrateLegacyCanvases(
  io: CanvasMigrationIO,
  docs: CanvasMigrationDocuments,
  options: CanvasMigrationOptions,
): Promise<CanvasMigrationManifest> {
  if (options?.confirmed !== true) throw new CanvasMigrationError('请先明确确认迁移，尚未读取或修改旧画布');
  let destination: CanvasDestination | undefined;
  try { destination = options.destination === undefined ? undefined : destinationValue(options.destination); }
  catch (cause) { throw new CanvasMigrationError(explain(cause), undefined, { cause }); }
  return locked(async () => {
    let manifest: CanvasMigrationManifest | undefined;
    const persist = async () => {
      if (!manifest) throw new Error('迁移清单尚未初始化');
      manifest.updatedAt = Date.now();
      await io.writeManifest(copy(manifest));
      const readback = manifestValue(await io.readManifest());
      if (!readback || canonical(readback) !== canonical(manifest)) throw new Error('迁移清单写后核对失败，未继续创建文档');
      try { options.onProgress?.(copy(manifest)); } catch { /* A UI callback cannot break a durable migration step. */ }
    };
    try {
      manifest = await loadCanvasMigrationManifest(io);
      let snapshot: Map<string, Uint8Array>;
      if (manifest) {
        if (manifest.destination && destination && canonical(manifest.destination) !== canonical(destination)) {
          throw new Error('此迁移批次已固定保存位置，不能改到其他笔记本或父文档；请沿用清单中的原位置恢复，避免重复文档 ID');
        }
        if (!manifest.destination && destination) {
          if (manifest.boards.some(board => board.reservedDocId || board.docId || board.stage !== 'pending')) {
            throw new Error('旧迁移清单没有记录保存位置，但已有文档创建尝试；请先人工核对原位置，不能另选位置重试');
          }
          manifest.destination = copy(destination);
          await persist();
        }
        snapshot = await assertSourceUnchanged(io, manifest);
      }
      else {
        snapshot = await sourceSnapshot(io);
        const files: CanvasMigrationFile[] = [];
        for (const [name, bytes] of snapshot) files.push({ name, size: bytes.byteLength, sha256: await sha256Bytes(bytes), verified: false });
        manifest = { version: 1, runId: newCanvasId(), stage: 'backing-up', createdAt: Date.now(), updatedAt: Date.now(), files, boards: [], mapping: {}, ...(destination ? { destination: copy(destination) } : {}) };
        await persist();
      }
      const hadError = manifest.lastError !== undefined;
      delete manifest.lastError;
      // Verify every backup on every invocation. Existing mismatched backups
      // are never overwritten, even when the manifest previously said verified.
      for (const file of manifest.files) {
        let backup = await io.readBackup(manifest.runId, file.name);
        if (backup === undefined) {
          await io.writeBackup(manifest.runId, file.name, Uint8Array.from(snapshot.get(file.name)!));
          backup = await io.readBackup(manifest.runId, file.name);
        }
        if (!(backup instanceof Uint8Array) || backup.byteLength !== file.size || await sha256Bytes(backup) !== file.sha256) {
          throw new Error(`${file.name} 的备份字节或 SHA256 校验失败，未继续创建文档，未覆盖已有备份`);
        }
        if (!file.verified) { file.verified = true; await persist(); }
      }
      // Parse all files only after the complete raw-byte backup has verified.
      // Include orphan canvas JSONs that are absent from canvas-index.json.
      const scenes = scenesIn(snapshot);
      if (manifest.stage === 'backing-up') {
        manifest.boards = [...scenes.values()].map(scene => ({ legacyId: scene.id, fileName: `canvas-${scene.id}.json`, sourceSha256: manifest!.files.find(file => file.name === `canvas-${scene.id}.json`)!.sha256, stage: 'pending' }));
        manifest.stage = 'backup-verified';
        await persist();
      }
      if (manifest.stage === 'complete') {
        if (hadError) await persist();
        return copy(manifest);
      }
      await assertSourceUnchanged(io, manifest);
      manifest.stage = 'migrating';
      await persist();
      for (const board of manifest.boards) {
        if (board.stage === 'verified') continue; // Later edits of migrated docs are legitimate.
        const scene = scenes.get(board.legacyId)!;
        const current = await io.readLegacy(board.fileName);
        if (await sha256Bytes(current) !== board.sourceSha256) throw new Error(`${board.fileName} 在迁移期间发生变化，未覆盖目标文档`);
        if (!board.docId) {
          const matches = await docs.findByLegacyId(board.legacyId);
          if (!Array.isArray(matches) || matches.some(id => typeof id !== 'string')) throw new Error('旧画布查重结果无效，未创建文档');
          const found = [...new Set(matches)];
          if (found.some(id => !DOC_ID.test(id)) || found.length > 1) throw new Error(`旧画布 ${board.legacyId} 对应多个或无效目标，已停止以避免重复创建`);
          let docId = found[0];
          if (docId && board.reservedDocId && docId !== board.reservedDocId) {
            const reserved = await docs.load(board.reservedDocId, board.legacyId);
            if (reserved) throw new Error(`旧画布 ${board.legacyId} 有两个已创建文档，需先核对映射`);
          }
          if (!docId && board.reservedDocId) {
            const reserved = await docs.load(board.reservedDocId, board.legacyId);
            if (reserved) docId = board.reservedDocId;
          }
          if (!docId) {
            if (!board.reservedDocId) {
              const reservedDocId = docs.allocateDocId();
              if (typeof reservedDocId !== 'string' || !DOC_ID.test(reservedDocId) ||
                manifest.boards.some(other => other !== board && (other.reservedDocId === reservedDocId || other.docId === reservedDocId))) {
                throw new Error('预分配的思源文档 ID 无效或重复，未创建文档');
              }
              board.reservedDocId = reservedDocId;
            }
            board.stage = 'creating';
            await persist(); // Record the fixed ID before sending any create request.
            try {
              docId = await docs.createFromLegacy(copy(scene), board.legacyId, manifest.runId, board.reservedDocId);
              if (docId !== board.reservedDocId) throw new Error('创建接口未使用预留文档 ID，已停止以避免重复创建');
            } catch (cause) {
              board.stage = 'creation-uncertain';
              await persist();
              throw new Error(`创建 ${scene.title} 的结果尚未确认；下次将先检查固定 ID ${board.reservedDocId}，不会另分配 ID 重建`, { cause });
            }
          }
          board.docId = docId;
          board.stage = 'created';
          manifest.mapping[board.legacyId] = docId;
          await persist(); // Even a later validation/read failure can resume by ID.
        }
        const loaded = await docs.load(board.docId, board.legacyId);
        if (!loaded) throw new Error(`迁移文档 ${board.docId} 暂不存在；保留映射，不自动创建替代文档`);
        if (loaded.id !== board.docId || !sameMigratedCanvasContent(scene, loaded)) {
          throw new Error(`迁移文档 ${board.docId} 与原画布内容不一致，未覆盖任一版本；请核对标题、卡片、连线与视口`);
        }
        board.stage = 'verified';
        await persist();
      }
      await assertSourceUnchanged(io, manifest);
      manifest.stage = 'complete';
      delete manifest.lastError;
      await persist();
      return copy(manifest);
    } catch (cause) {
      if (manifest) {
        manifest.lastError = explain(cause);
        try { await persist(); } catch { /* Keep the last durable journal and all reserved IDs. */ }
      }
      throw new CanvasMigrationError(explain(cause), manifest && copy(manifest), { cause });
    }
  });
}
