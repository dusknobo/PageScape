import { SiyuanApi } from '../api';
import { PreviewCache } from '../cache';
import { createPreviewRenderer, isPreviewEmpty } from '../preview';
import type { DocInfo, NoteChange } from '../types';
import { newCanvasId, normalizeScene } from './model';
import { pickCanvasDocuments } from './picker';
import { CanvasConflictError, CanvasStorageError } from './storage';
import { createCanvasView } from './view';
import { mountCanvasDocumentEditor } from './document-editor';
import type { CanvasDocumentEditor } from './document-editor';
import { createDocumentFromText, textDocumentTitle } from './document-actions';
import { uploadCanvasMedia } from './media';
import { importJsonCanvas } from './json-canvas';
import { canvasPreviewKey, resolveCanvasDocumentTarget } from './document-target';
import { canvasRequest } from './document-api';
import { appendTemplate, canvasVisibility, reconcileChildren } from './scene-features';
import { showTemplateLibrary } from './templates';
import type { CanvasControllerHost, CanvasScene, CanvasSession, CanvasStore, CanvasView, DocNode, FileNode, Point } from './types';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const explain = (error: unknown) => error instanceof Error ? error.message : String(error || '操作失败');
const DRAFT_PREFIX = 'scc-canvas-session-draft-v1:';
const DOCUMENT_ID = /^\d{14}-[a-z0-9]{7}$/;
// sessionStorage isolates windows; writer IDs also isolate two tabs of one board.
// After a window reload the sets are empty, so an abandoned draft can be claimed.
const activeWriters = new Set<string>();
const claimedDrafts = new Set<string>();
const followingRuns = new Map<string, Promise<void>>();
const activeCanvases = new Set<CanvasController>();
interface SceneStamp { id?: string; generation: number; editVersion: number }
interface Draft { key: string; baseRevision: string | null; scene: CanvasScene }

export class CanvasController implements CanvasSession {
  readonly ready: Promise<void>;
  private view: CanvasView;
  private scene?: CanvasScene;
  private persistedTitle?: string;
  private dirty = false;
  private paused = false;
  private disposed = false;
  private closing = false;
  private generation = 0;
  private editVersion = 0;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private changeTimer?: ReturnType<typeof setTimeout>;
  private followingTimer?: ReturnType<typeof setTimeout>;
  private saveTask?: Promise<void>;
  private transitionTask?: Promise<void>;
  private remoteTask?: Promise<void>;
  private disposeTask?: Promise<void>;
  private boardsVersion = 0;
  private writerId = newCanvasId();
  private loads = new Map<string, AbortController>();
  private loaded = new Set<string>();
  private changedIds = new Set<string>();
  private retryAll = false;
  private previewTask?: Promise<void>;
  private lifetime = new AbortController();
  private sceneLifetime = new AbortController();
  private mediaTask?: Promise<void>;
  private importTask?: Promise<void>;
  private nodeTasks = new Set<string>();
  private editors = new Map<HTMLElement, CanvasDocumentEditor>();
  private editorClosures = new Set<Promise<void>>();

  constructor(
    private element: HTMLElement,
    boardId: string | undefined,
    private host: CanvasControllerHost,
    private api: SiyuanApi,
    private cache: PreviewCache,
    private store: CanvasStore,
  ) {
    activeWriters.add(this.writerId);
    this.view = createCanvasView({
      element,
      inline: host.inline,
      isReadonly: host.isReadonly,
      onOpenCanvas: host.inline && host.openCanvas ? () => { void this.openStandalone(); } : undefined,
      onChange: scene => this.change(scene),
      onOpenDocument: host.openDocument,
      onAddDocument: () => { void this.addFromPicker(); },
      onImportChildren: () => { void this.importChildren(); },
      onChooseBoard: id => { void this.switchBoard(id); },
      onNewBoard: () => { void this.createBoard(); },
      onRenameBoard: title => {
        if (!this.scene || !title.trim()) return;
        if (title.trim().length > 300) { this.view.setStatus('画布名称最多 300 个字符，请缩短后重试', 'error'); return; }
        this.change({ ...this.scene, title: title.trim() });
        this.view.setScene(this.scene!);
        this.host.onTitle(this.scene!.title);
      },
      onSave: () => { this.paused = false; void this.flush(); },
      onReload: () => { void this.reload(); },
      onSaveCopy: () => { void this.saveCopy(); },
      onRefresh: () => this.check(),
      onFollowChildren: () => { void this.configureFollowing(); },
      onStopFollowing: () => this.stopFollowing(),
      onTemplates: host.templates ? () => this.openTemplates() : undefined,
      onReferences: host.showReferences,
      onMigrateLegacy: host.migrateLegacy ? () => { void this.migrateLegacy(); } : undefined,
      onImportCanvas: file => { void this.importCanvas(file); },
      onAddMedia: (files, point, replaceNodeId) => { void this.addMedia(files, point, replaceNodeId); },
      onEditDocument: (id, target) => this.editDocument(id, target),
      onConvertText: id => { void this.convertText(id); },
      onSwapDocument: id => { void this.swapDocument(id); },
      onDrop: (ids, point) => { void this.addDocumentIds(ids, point); },
      renderPreview: createPreviewRenderer,
    });
    element.addEventListener('focusin', this.recoverRemote, { signal: this.lifetime.signal });
    activeCanvases.add(this);
    this.ready = this.initialize(boardId);
  }

  private async initialize(boardId?: string): Promise<void> {
    await this.transition(async () => {
      this.view.setStatus('正在打开画布…');
      const stamp = this.stamp();
      try {
        const boards = await this.store.list();
        if (!this.current(stamp)) return;
        this.view.setBoards(boards);
        if (!boardId && !boards.length) {
          this.view.setStatus('暂无画布文档，请点击“新建”选择保存位置，或迁移旧画布');
          return;
        }
        const scene = await this.store.load(boardId || boards[0].id);
        if (await this.showScene(scene, true, stamp)) await this.refreshBoards();
      } catch (error) { if (this.current(stamp)) this.view.setStatus(`打开画布失败：${explain(error)}`, 'error'); }
    });
  }

  private stamp(): SceneStamp { return { id: this.scene?.id, generation: this.generation, editVersion: this.editVersion }; }
  private current(stamp: SceneStamp): boolean {
    return !this.disposed && !this.closing && stamp.id === this.scene?.id &&
      stamp.generation === this.generation && stamp.editVersion === this.editVersion;
  }
  private sameBoard(id: string, generation: number): boolean {
    return !this.disposed && !this.closing && this.scene?.id === id && this.generation === generation;
  }
  private readonly(): boolean { return Boolean(window.siyuan?.config?.readonly || window.siyuan?.isPublish || this.host.isReadonly?.()); }
  private canEdit(): boolean {
    if (this.disposed || this.closing) return false;
    if (!this.readonly()) return true;
    this.view.setStatus('当前工作空间为只读，无法修改画布', 'error');
    return false;
  }
  private canMutateScene(): boolean {
    if (!this.canEdit()) return false;
    if (!this.scene?.settings?.readOnly) return true;
    this.view.setStatus('画布已锁定，请先关闭只读设置', 'error');
    return false;
  }
  private async transition(action: () => Promise<void>): Promise<void> {
    if (this.disposed || this.closing) return;
    if (this.transitionTask) { this.view.setStatus('正在处理画布切换，请稍候'); return; }
    const task = Promise.resolve().then(action);
    this.transitionTask = task;
    try { await task; }
    finally { if (this.transitionTask === task) this.transitionTask = undefined; }
  }
  private changedDuringRead(stamp: SceneStamp): boolean {
    if (this.current(stamp)) return false;
    if (!this.disposed && !this.closing) this.view.setStatus('等待期间画布有新修改，已保留当前画布；请再次操作');
    return true;
  }

  private async showScene(scene: CanvasScene, recoverDraft = false, stamp = this.stamp()): Promise<boolean> {
    if (!this.current(stamp)) return false;
    let next = normalizeScene(scene);
    let draft: Draft | undefined;
    let dirty = false;
    let recoveredCopy = false;
    let deferredDraft = false;
    try {
      if (recoverDraft) {
        draft = this.readDraft(scene.id);
        if (draft) {
          // A draft means unsaved edits, even when a prior save finished later
          // than the edit. Only the base revision determines safe restoration.
          if (draft.baseRevision === scene.revision) {
            next = { ...draft.scene, revision: scene.revision };
            dirty = true;
          } else {
            if (this.readonly()) deferredDraft = true;
            else {
              next = await this.store.copy(clone(draft.scene));
              recoveredCopy = true;
            }
          }
        }
      }
      if (this.changedDuringRead(stamp)) return false;
      await this.closeEditors();
      if (this.changedDuringRead(stamp)) return false;
      this.sceneLifetime.abort(); this.sceneLifetime = new AbortController();
      clearTimeout(this.saveTimer);
      clearTimeout(this.changeTimer);
      this.scene = next;
      this.persistedTitle = recoveredCopy ? next.title : scene.title;
      this.dirty = dirty;
      this.paused = dirty && this.readonly();
      ++this.editVersion;
      // Remove the claimed key only after its contents are durable, either in
      // the new writer's draft or in the recovered disk copy.
      if (draft && !deferredDraft && (recoveredCopy || this.writeDraft())) {
        if (recoveredCopy || draft.key !== this.draftKey(scene.id)) this.removeDraft(draft.key);
      }
    } finally { if (draft) claimedDrafts.delete(draft.key); }
    ++this.generation;
    this.loads.forEach(load => load.abort());
    this.loads.clear();
    this.loaded.clear();
    this.changedIds.clear();
    this.retryAll = false;
    this.view.setScene(this.scene);
    this.host.onTitle(this.scene.title);
    this.host.onBoard(this.scene.id);
    this.view.setStatus(deferredDraft ? '当前为只读；已打开保存的画布，未保存草稿仍保留，恢复副本需在可写时重新打开' : recoveredCopy ? '原画布已有更新，未保存的修改已恢复为副本' : dirty ?
      (this.paused ? '已恢复未保存的修改；当前工作空间为只读，草稿仍保留' : '已恢复未保存的画布修改') : '已保存');
    if (this.dirty && !this.paused) this.scheduleSave();
    this.loadVisible();
    this.scheduleFollowing();
    return true;
  }

  private change(scene: CanvasScene): void {
    if (this.disposed || this.closing || !this.scene || scene.id !== this.scene.id) return;
    if (!this.canEdit()) { this.view.setScene(this.scene); return; }
    try {
      const locking = !this.scene.settings?.readOnly && scene.settings?.readOnly;
      const input = { ...scene };
      if (input.followParentId && input.followParentId === this.scene.followParentId) {
        const remaining = new Set(input.nodes.map(node => node.id));
        const excluded = new Set([...(this.scene.followExcluded || []), ...(input.followExcluded || [])]);
        for (const node of this.scene.nodes) if (node.kind === 'doc' && node.followedFrom === input.followParentId && !remaining.has(node.id)) excluded.add(node.docId);
        for (const node of input.nodes) if (node.kind === 'doc') excluded.delete(node.docId);
        input.followExcluded = [...excluded];
      }
      const next = normalizeScene({ ...input, revision: this.scene.revision, updatedAt: Date.now() });
      this.scene = next;
      if (locking) { this.sceneLifetime.abort(); this.sceneLifetime = new AbortController(); }
      if (next.settings?.readOnly) void this.closeEditors();
      const previewKeys = new Set(next.nodes.filter((node): node is DocNode => node.kind === 'doc').map(canvasPreviewKey));
      for (const key of this.loaded) if (!previewKeys.has(key)) this.loaded.delete(key);
      for (const [key, request] of this.loads) if (!previewKeys.has(key)) { request.abort(); this.loads.delete(key); }
      this.dirty = true;
      ++this.editVersion;
      this.writeDraft();
      this.host.onTitle(next.title);
      if (!this.paused) {
        this.view.setStatus('有修改，正在保存…');
        this.scheduleSave();
      }
      this.loadVisible();
    } catch (error) { this.view.setStatus(explain(error), 'error'); }
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    if (this.disposed || this.closing || this.paused) return;
    this.saveTimer = setTimeout(() => { void this.flush(); }, 450);
  }

  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (this.saveTask) return this.saveTask;
    if (this.disposed || !this.scene || !this.dirty || this.paused) return;
    if (this.readonly()) { this.paused = true; this.view.setStatus('当前工作空间为只读，未保存的草稿仍保留', 'error'); return; }
    this.saveTask = this.saveLoop();
    try { await this.saveTask; }
    finally { this.saveTask = undefined; }
    this.scheduleFollowing();
  }

  private async saveLoop(): Promise<void> {
    while (!this.disposed && this.scene && this.dirty && !this.paused) {
      const snapshot = clone(this.scene);
      const editVersion = this.editVersion;
      const generation = this.generation;
      this.view.setStatus('正在保存…');
      try {
        if (this.readonly()) throw new Error('当前工作空间为只读，无法保存画布');
        const saved = await this.store.save(snapshot, snapshot.revision);
        if (this.disposed || !this.scene || this.scene.id !== saved.id || generation !== this.generation) return;
        this.scene.revision = saved.revision;
        this.persistedTitle = saved.title;
        this.view.setRevision(saved.revision, saved.updatedAt);
        if (this.editVersion === editVersion) {
          this.scene.updatedAt = saved.updatedAt;
          this.dirty = false;
          this.clearDraft(saved.id);
          this.view.setStatus('已保存');
        } else this.writeDraft();
        void this.refreshBoards();
      } catch (error) {
        if (this.disposed || this.scene?.id !== snapshot.id || generation !== this.generation) return;
        if (error instanceof CanvasStorageError && error.savedScene && this.scene?.id === error.savedScene.id) {
          this.scene.revision = error.savedScene.revision;
          this.persistedTitle = error.savedScene.title;
          this.view.setRevision(error.savedScene.revision, error.savedScene.updatedAt);
          this.writeDraft();
        }
        this.paused = true;
        this.view.setStatus(error instanceof CanvasConflictError
          ? '另一窗口或设备已修改此画布。本地修改已保留，请另存副本或重载。'
          : `保存失败：${explain(error)}。本地修改已保留，可点击保存重试。`, error instanceof CanvasConflictError ? 'conflict' : 'error');
      }
    }
  }

  private async refreshBoards(): Promise<void> {
    const request = ++this.boardsVersion;
    try {
      const boards = await this.store.list();
      if (!this.disposed && !this.closing && request === this.boardsVersion) this.view.setBoards(boards);
    } catch (error) { if (!this.disposed && !this.closing && request === this.boardsVersion) this.view.setStatus(`画布列表读取失败：${explain(error)}`, 'error'); }
  }

  private async switchBoard(id: string): Promise<void> {
    if (id === this.scene?.id) return;
    await this.transition(async () => {
      try {
        await this.flush();
        if (this.closing || this.disposed) return;
        if (this.dirty) throw new Error('当前修改还未保存，请先另存副本');
        const stamp = this.stamp();
        const scene = await this.store.load(id);
        if (this.changedDuringRead(stamp)) return;
        await this.showScene(scene, true, stamp);
      } catch (error) {
        if (!this.disposed && !this.closing) {
          this.view.setStatus(explain(error), 'error');
          if (this.scene) this.view.setScene(this.scene);
        }
      }
    });
  }

  /** Opening a canvas from a document must finish saving the active canvas first. */
  async openBoard(id: string): Promise<void> {
    await this.ready;
    if (this.host.inline && id !== this.scene?.id) {
      await this.host.openCanvas?.(id); return;
    }
    await this.switchBoard(id);
  }

  async focusNode(id: string): Promise<void> { await this.ready; if (!this.disposed && !this.closing) this.view.focusNode(id); }

  private openTemplates(): void {
    if (!this.host.templates || !this.scene) return;
    const boardId = this.scene.id, generation = this.generation;
    showTemplateLibrary(this.element, this.host.templates, {
      signal: this.sceneLifetime.signal,
      snapshot: () => this.sameBoard(boardId, generation) && this.canMutateScene() ? clone(this.scene!) : undefined,
      apply: template => {
        if (!this.sameBoard(boardId, generation) || !this.canMutateScene()) return false;
        try {
          const merged = appendTemplate(this.scene!, template);
          this.change(merged.scene); this.view.setScene(this.scene!);
          if (merged.ids[0]) this.view.focusNode(merged.ids[0]);
          this.loadVisible(); return true;
        } catch (error) { this.view.setStatus(`添加模板失败：${explain(error)}`, 'error'); return false; }
      },
    });
  }

  private async configureFollowing(): Promise<void> {
    if (!this.scene || !this.canMutateScene()) return;
    const stamp = this.stamp();
    const ids = await pickCanvasDocuments({ anchor: this.element, mode: 'parent', initialDocId: this.scene.followParentId || this.host.initialDocId,
      title: '自动跟随子页', hint: '新子页自动加入，已有位置保留；移出的子页只标记，不删除卡片。', confirmLabel: '跟随此文档的子页', signal: this.sceneLifetime.signal });
    if (!ids?.[0] || !this.current(stamp) || !this.canMutateScene()) return;
    this.change({ ...this.scene!, followParentId: ids[0], followExcluded: [] }); this.view.setScene(this.scene!);
    await this.flush(); this.scheduleFollowing(50);
  }

  private stopFollowing(): void {
    if (!this.scene || !this.canMutateScene()) return;
    const next = clone(this.scene); const parent = next.followParentId;
    delete next.followParentId; delete next.followExcluded;
    for (const node of next.nodes) if (node.kind === 'doc' && node.followedFrom === parent) { delete node.followedFrom; delete node.detached; }
    clearTimeout(this.followingTimer); this.change(next); this.view.setScene(this.scene!);
  }

  private scheduleFollowing(delay = 500): void {
    clearTimeout(this.followingTimer);
    if (!this.scene?.followParentId || this.disposed || this.closing || this.paused || this.readonly() || this.scene.settings?.readOnly) return;
    this.followingTimer = setTimeout(() => { void this.synchronizeFollowing(); }, delay);
  }

  private async synchronizeFollowing(): Promise<void> {
    if (!this.scene?.followParentId || this.disposed || this.closing || this.paused || this.readonly() || this.scene.settings?.readOnly) return;
    if (this.dirty || this.saveTask || this.transitionTask) { this.scheduleFollowing(); return; }
    const boardId = this.scene.id;
    if ([...activeCanvases].some(peer => peer !== this && peer.scene?.id === boardId && (peer.dirty || peer.saveTask || peer.transitionTask))) {
      this.scheduleFollowing(); return;
    }
    const existing = followingRuns.get(boardId);
    if (existing) { await existing; await this.storageChanged(); this.scheduleFollowing(); return; }
    const update = async () => {
      const stamp = this.stamp(); const parentId = this.scene!.followParentId!;
      const latest = await this.store.load(boardId);
      if (!this.current(stamp) || this.dirty || this.saveTask) return;
      if (latest.revision !== this.scene!.revision) { await this.storageChanged(); this.scheduleFollowing(); return; }
      const parent = await this.api.resolveDocument(parentId, this.sceneLifetime.signal);
      const children = await this.api.listChildren(parent, this.sceneLifetime.signal);
      if (!this.current(stamp) || this.dirty || this.saveTask || this.readonly() || this.scene!.settings?.readOnly) return;
      const next = reconcileChildren(this.scene!, parentId, children.filter(doc => doc.id !== boardId));
      if (JSON.stringify(next.nodes) !== JSON.stringify(this.scene!.nodes)) {
        this.change(next); this.view.setScene(this.scene!); this.loadVisible(); await this.flush();
      }
    };
    const task = (async () => {
      try {
        if (navigator.locks) await navigator.locks.request(`scc-follow:${boardId}`, { ifAvailable: true }, async lock => { if (lock) await update(); });
        else await update();
      } catch (error) { if (!this.disposed && !this.closing && this.scene?.id === boardId) this.view.setStatus(`子页跟随暂未完成：${explain(error)}`, 'error'); }
    })();
    followingRuns.set(boardId, task);
    try { await task; } finally { if (followingRuns.get(boardId) === task) followingRuns.delete(boardId); }
  }

  private async openStandalone(): Promise<void> {
    await this.ready;
    await this.flush();
    if (!this.scene || this.disposed || this.closing) return;
    if (this.dirty) { this.view.setStatus('当前修改还未保存，请先保存或另存副本，再独立打开', 'error'); return; }
    try { await this.host.openCanvas?.(this.scene.id); }
    catch (error) { this.view.setStatus(`打开画布失败：${explain(error)}`, 'error'); }
  }

  /** The visible New action opens an independent document and keeps this canvas alive. */
  private async createBoard(): Promise<void> {
    await this.ready;
    if (!this.canEdit()) return;
    if (!this.host.newCanvas) { await this.newBoard(); return; }
    try { await this.host.newCanvas(); }
    catch (error) { if (!this.disposed && !this.closing) this.view.setStatus(`新建失败：${explain(error)}`, 'error'); }
  }

  private async newBoard(): Promise<void> {
    if (!this.canEdit()) return;
    await this.transition(async () => {
      try {
        await this.flush();
        if (this.closing || this.disposed) return;
        if (this.dirty) throw new Error('当前修改还未保存，请先另存副本');
        const stamp = this.stamp();
        if (!this.host.chooseDestination) throw new Error('当前窗口无法选择保存位置，请重新打开画布后重试');
        const destination = await this.host.chooseDestination(this.host.initialDocId, { title: '新画布', askTitle: true });
        if (this.changedDuringRead(stamp) || !destination || !this.canEdit()) return;
        const scene = await this.store.create(destination.title || '新画布', destination);
        if (!this.changedDuringRead(stamp)) await this.showScene(scene, false, stamp);
        await this.refreshBoards();
      } catch (error) { if (!this.disposed && !this.closing) this.view.setStatus(explain(error), 'error'); }
    });
  }

  private async reload(): Promise<void> {
    if (!this.scene) { await this.initialize(); return; }
    await this.transition(async () => {
      try {
        clearTimeout(this.saveTimer);
        await this.saveTask;
        if (!this.scene || this.closing || this.disposed) return;
        const stamp = this.stamp();
        if (this.dirty) {
          if (!this.canEdit()) return;
          await this.store.copy(clone(this.scene));
          if (this.changedDuringRead(stamp)) { await this.refreshBoards(); return; }
        }
        const scene = await this.store.load(this.scene.id);
        if (this.changedDuringRead(stamp)) return;
        const oldId = this.scene.id;
        if (await this.showScene(scene, false, stamp)) this.clearDraft(oldId);
        await this.refreshBoards();
      } catch (error) { if (!this.disposed && !this.closing) this.view.setStatus(`重载失败：${explain(error)}`, 'error'); }
    });
  }

  private async saveCopy(): Promise<void> {
    if (!this.scene || !this.canEdit()) return;
    await this.transition(async () => {
      try {
        clearTimeout(this.saveTimer);
        await this.saveTask;
        if (!this.scene || this.closing || this.disposed) return;
        const stamp = this.stamp();
        const oldId = this.scene.id;
        const destination = this.host.chooseDestination
          ? await this.host.chooseDestination(this.scene.id)
          : undefined;
        if (this.changedDuringRead(stamp) || destination === null || !this.canEdit()) return;
        const saved = await this.store.copy(clone(this.scene), destination);
        if (this.changedDuringRead(stamp)) { await this.refreshBoards(); return; }
        if (this.host.inline) {
          await this.host.openCanvas?.(saved.id);
          this.view.setStatus('已另存副本并独立打开，本文档仍显示原画布');
          await this.refreshBoards(); return;
        }
        if (await this.showScene(saved, false, stamp)) {
          this.clearDraft(oldId);
          this.view.setStatus('已另存为副本');
        }
        await this.refreshBoards();
      } catch (error) { if (!this.disposed && !this.closing) this.view.setStatus(`另存失败：${explain(error)}`, 'error'); }
    });
  }

  private async migrateLegacy(): Promise<void> {
    if (!this.host.migrateLegacy || !this.canEdit()) return;
    await this.transition(async () => {
      try {
        await this.flush();
        if (this.closing || this.disposed) return;
        if (this.dirty) throw new Error('当前修改还未保存，请先保存或另存副本，再迁移旧画布');
        const stamp = this.stamp();
        const id = await this.host.migrateLegacy!();
        if (this.changedDuringRead(stamp)) { await this.refreshBoards(); return; }
        if (!id) return;
        if (!DOCUMENT_ID.test(id)) throw new Error('迁移返回了无效文档 ID，原画布未切换');
        const scene = await this.store.load(id);
        if (!this.changedDuringRead(stamp)) {
          await this.showScene(scene, true, stamp);
          this.view.setStatus('旧画布已迁移为思源文档，原 JSON 文件仍保留');
        }
        await this.refreshBoards();
      } catch (error) { if (!this.disposed && !this.closing) this.view.setStatus(`迁移失败：${explain(error)}`, 'error'); }
    });
  }

  private async addFromPicker(): Promise<void> {
    if (!this.scene || !this.canMutateScene()) return;
    const id = this.scene?.id;
    const generation = this.generation;
    const ids = await pickCanvasDocuments({ anchor: this.element, mode: 'documents', signal: this.sceneLifetime.signal });
    if (ids?.length && this.sameBoard(id, generation)) await this.addDocumentIds(ids);
  }

  async importChildren(docId?: string): Promise<void> {
    if (!this.scene && this.canEdit()) await this.newBoard();
    const boardId = this.scene?.id;
    if (!boardId || !this.canMutateScene()) return;
    const generation = this.generation;
    try {
      const chosen = docId || (await pickCanvasDocuments({ anchor: this.element, mode: 'parent', initialDocId: this.host.initialDocId, signal: this.sceneLifetime.signal }))?.[0];
      if (!chosen || !this.sameBoard(boardId, generation)) return;
      const parent = await this.api.resolveDocument(chosen, this.lifetime.signal);
      const docs = await this.api.listChildren(parent, this.lifetime.signal);
      if (!this.sameBoard(boardId, generation)) return;
      this.addResolved(docs, this.view.getCenter());
      if (!docs.length) this.view.setStatus('这个文档没有可导入的子页');
    } catch (error) { if (this.sameBoard(boardId, generation)) this.view.setStatus(`导入失败：${explain(error)}`, 'error'); }
  }

  async addDocumentIds(ids: string[], point = this.view.getCenter()): Promise<void> {
    if (!this.scene || !this.canMutateScene()) return;
    const boardId = this.scene.id;
    const generation = this.generation;
    const unique = [...new Set(ids)].filter(id => /^\d{14}-[a-z0-9]{7}$/.test(id));
    if (unique.length > 200) { this.view.setStatus('一次最多添加 200 个文档，请分批添加', 'error'); return; }
    const docs: (DocInfo | undefined)[] = new Array(unique.length);
    let errors = 0;
    let cursor = 0;
    this.view.setStatus('正在添加文档…');
    await Promise.all(Array.from({ length: Math.min(3, unique.length) }, async () => {
      while (cursor < unique.length && this.sameBoard(boardId, generation)) {
        const index = cursor++;
        const id = unique[index];
        try { docs[index] = await this.api.resolveDocument(id, this.lifetime.signal); }
        catch { errors++; }
      }
    }));
    if (!this.sameBoard(boardId, generation)) return;
    this.addResolved(docs.filter((doc): doc is DocInfo => !!doc), point);
    if (errors) this.view.setStatus(`${errors} 个文档无法读取，请确认文档存在且笔记本已打开`, 'error');
  }

  private addResolved(docs: DocInfo[], point: Point): void {
    if (!this.scene || !docs.length || !this.canMutateScene()) return;
    const existing = new Set(this.scene.nodes.filter((node): node is DocNode => node.kind === 'doc').map(node => node.docId));
    const nodes: DocNode[] = [];
    for (const doc of docs) {
      if (existing.has(doc.id)) continue;
      existing.add(doc.id);
      const index = nodes.length;
      nodes.push({ id: newCanvasId(), kind: 'doc', docId: doc.id, title: doc.title,
        x: point.x + (index % 3) * 350 - 160, y: point.y + Math.floor(index / 3) * 290 - 120,
        width: 320, height: 250, color: 'neutral' });
    }
    if (!nodes.length) { this.view.setStatus('这些文档已在当前画布中'); return; }
    this.change({ ...this.scene, nodes: [...this.scene.nodes, ...nodes] });
    this.view.setScene(this.scene);
    this.loadVisible();
  }

  async importCanvas(file: File): Promise<void> {
    if (!this.canEdit()) return;
    if (this.importTask) { this.view.setStatus('正在导入画布，请稍候'); return; }
    const task = (async () => {
      try {
        if (!this.host.importCanvas) throw new Error('当前窗口暂不支持导入，请重新打开 Canvas');
        if (!/\.canvas$/i.test(file.name) || file.size > 20 * 1024 * 1024) throw new Error('请选择不超过 20 MB 的 .canvas 文件');
        const title = file.name.replace(/\.canvas$/i, '').trim().slice(0, 300) || '导入画布';
        const imported = importJsonCanvas(await file.text(), { title });
        if (!this.canEdit()) return;
        const created = await this.host.importCanvas(imported.scene, title);
        if (created && !this.disposed && !this.closing) {
          this.view.setStatus(imported.warnings.length ? `已导入为独立画布。${imported.warnings.join('；')}` : '已导入为独立画布，原画布保持不变');
          await this.refreshBoards();
        }
      } catch (error) { if (!this.disposed && !this.closing) this.view.setStatus(`导入失败：${explain(error)}`, 'error'); }
    })();
    this.importTask = task;
    try { await task; } finally { if (this.importTask === task) this.importTask = undefined; }
  }

  async addMedia(files: File[], point = this.view.getCenter(), replaceNodeId?: string): Promise<void> {
    if (!this.scene || !this.canMutateScene()) return;
    if (this.mediaTask) { this.view.setStatus('正在上传媒体，请稍候'); return; }
    const original = replaceNodeId ? this.scene.nodes.find(node => node.id === replaceNodeId) : undefined;
    if (replaceNodeId && original?.kind !== 'file') { this.view.setStatus('待替换的附件节点已不存在，原画布未修改', 'error'); return; }
    if (replaceNodeId && !files.length) return;
    if (replaceNodeId && files.length !== 1) { this.view.setStatus('替换附件时请选择一个文件，原附件未修改', 'error'); return; }
    const originalFile = original?.kind === 'file' ? { file: original.file, unresolved: original.unresolved } : undefined;
    const boardId = this.scene.id; const generation = this.generation;
    const signal = AbortSignal.any([this.lifetime.signal, this.sceneLifetime.signal]);
    const task = (async () => {
      try {
        if (!replaceNodeId && this.scene!.nodes.length + files.length > 2000) throw new Error('添加后会超过 2000 个节点，请分画布管理');
        this.view.setStatus('正在上传媒体…');
        const uploaded = await uploadCanvasMedia(files, boardId, signal);
        if (!this.sameBoard(boardId, generation) || !this.canMutateScene() || !this.scene) return;
        if (replaceNodeId) {
          const current = this.scene.nodes.find(node => node.id === replaceNodeId);
          if (current?.kind !== 'file' || current.file !== originalFile!.file || current.unresolved !== originalFile!.unresolved) throw new Error('上传期间原附件已变化，未替换或重建节点');
          const { unresolved: _unresolved, subpath: _subpath, ...base } = current;
          const replacement: FileNode = { ...base, ...uploaded[0] };
          const next = normalizeScene({ ...this.scene, nodes: this.scene.nodes.map(node => node.id === replaceNodeId ? replacement : node) });
          this.change(next); this.view.setScene(this.scene!);
          return;
        }
        const nodes: FileNode[] = uploaded.map((file, index) => ({
          id: newCanvasId(), kind: 'file', ...file, color: 'neutral',
          x: point.x + index % 3 * 350 - 160, y: point.y + Math.floor(index / 3) * 280 - 120,
          width: file.mediaType === 'video' ? 400 : 320, height: file.mediaType === 'audio' ? 140 : 250,
        }));
        const next = normalizeScene({ ...this.scene, nodes: [...this.scene.nodes, ...nodes] });
        this.change(next); this.view.setScene(this.scene!);
      } catch (error) { if (this.sameBoard(boardId, generation) && !signal.aborted) this.view.setStatus(`媒体上传失败：${explain(error)}。原画布内容已保留`, 'error'); }
    })();
    this.mediaTask = task;
    try { await task; } finally { if (this.mediaTask === task) this.mediaTask = undefined; }
  }

  async convertText(nodeId: string): Promise<void> {
    if (!this.scene || !this.canMutateScene() || this.nodeTasks.has(nodeId)) return;
    const original = this.scene.nodes.find(node => node.id === nodeId);
    if (original?.kind !== 'text' || !original.text.trim()) { this.view.setStatus('请先填写需要转换的便签正文'); return; }
    const boardId = this.scene.id; const generation = this.generation;
    const signal = AbortSignal.any([this.lifetime.signal, this.sceneLifetime.signal]);
    this.nodeTasks.add(nodeId);
    try {
      if (!this.host.chooseDestination) throw new Error('当前窗口无法选择文档保存位置');
      const proposed = textDocumentTitle(original.text);
      const destination = await this.host.chooseDestination(this.host.initialDocId, { title: proposed, askTitle: true, signal });
      if (!destination || !this.sameBoard(boardId, generation) || !this.canMutateScene()) return;
      let current = this.scene?.nodes.find(node => node.id === nodeId);
      if (current?.kind !== 'text' || current.text !== original.text) throw new Error('便签在等待期间有新修改，请再次转换');
      this.view.setStatus('正在创建原文文档…');
      const doc = await createDocumentFromText(original.text, destination.title || proposed, destination, signal);
      if (!this.sameBoard(boardId, generation) || !this.scene) return;
      current = this.scene.nodes.find(node => node.id === nodeId);
      if (current?.kind !== 'text' || current.text !== original.text || !this.canMutateScene()) {
        this.view.setStatus(`文档“${doc.title}”已创建；便签有新修改或画布已锁定，原便签未替换`); return;
      }
      const { text: _text, ...base } = current;
      const replacement: DocNode = { ...base, kind: 'doc', docId: doc.id, title: doc.title };
      const next = normalizeScene({ ...this.scene, nodes: this.scene.nodes.map(node => node.id === nodeId ? replacement : node) });
      this.change(next); this.view.setScene(this.scene!); this.loadVisible();
    } catch (error) { if (this.sameBoard(boardId, generation) && !signal.aborted) this.view.setStatus(`转换失败：${explain(error)}。原便签已保留`, 'error'); }
    finally { this.nodeTasks.delete(nodeId); }
  }

  async swapDocument(nodeId: string): Promise<void> {
    if (!this.scene || !this.canMutateScene() || this.nodeTasks.has(nodeId)) return;
    const original = this.scene.nodes.find(node => node.id === nodeId);
    if (!original || (original.kind !== 'doc' && !(original.kind === 'file' && original.unresolved))) return;
    const boardId = this.scene.id; const generation = this.generation;
    const signal = AbortSignal.any([this.lifetime.signal, this.sceneLifetime.signal]);
    this.nodeTasks.add(nodeId);
    try {
      const ids = await pickCanvasDocuments({ anchor: this.element, mode: 'parent', initialDocId: original.kind === 'doc' ? original.docId : undefined, signal,
        title: '替换文档', hint: '选择要放入此卡片的文档，卡片位置和连线会保留。', confirmLabel: '替换为此文档' });
      if (!ids?.[0] || !this.sameBoard(boardId, generation) || !this.canMutateScene()) return;
      const doc = await this.api.resolveDocument(ids[0], signal);
      if (!this.sameBoard(boardId, generation) || !this.scene || !this.canMutateScene()) return;
      const current = this.scene.nodes.find(node => node.id === nodeId);
      if (!current || current.kind !== original.kind || current.subpath !== original.subpath) return;
      if (original.kind === 'doc' && (current.kind !== 'doc' || current.docId !== original.docId)) return;
      if (original.kind === 'file' && (current.kind !== 'file' || current.file !== original.file || current.unresolved !== original.unresolved)) return;
      const replacement: DocNode = { id: current.id, kind: 'doc', docId: doc.id, title: doc.title,
        x: current.x, y: current.y, width: current.width, height: current.height, color: current.color,
        ...(current.groupId ? { groupId: current.groupId } : {}), ...(current.jsonCanvas ? { jsonCanvas: current.jsonCanvas } : {}) };
      this.change(normalizeScene({ ...this.scene, nodes: this.scene.nodes.map(node => node.id === nodeId ? replacement : node) }));
      this.view.setScene(this.scene!); this.loadVisible();
    } catch (error) { if (this.sameBoard(boardId, generation) && !signal.aborted) this.view.setStatus(`更换原文失败：${explain(error)}`, 'error'); }
    finally { this.nodeTasks.delete(nodeId); }
  }

  editDocument(id: string, target: HTMLElement): () => void {
    if (!this.scene || !this.canMutateScene() || !this.host.app || !target.isConnected) return () => {};
    const node = this.scene.nodes.find(node => node.kind === 'doc' && node.id === id) || this.scene.nodes.find(node => node.kind === 'doc' && node.docId === id);
    if (node?.kind !== 'doc') return () => {};
    if (this.host.inline) { this.host.openDocument(node.docId); return () => {}; }
    this.releaseEditor(target);
    try {
      const session = mountCanvasDocumentEditor(this.host.app, target, node.docId, {
        signal: this.sceneLifetime.signal, subpath: node.subpath,
        onError: error => { if (!this.disposed && !this.closing) this.view.setStatus(`原文编辑：${explain(error)}`, 'error'); },
        onClosed: () => {
          this.cache.invalidate(node.docId);
          for (const item of this.scene?.nodes || []) if (item.kind === 'doc' && item.docId === node.docId) this.loaded.delete(canvasPreviewKey(item));
          if (!this.disposed && !this.closing) this.loadVisible();
        },
      });
      this.editors.set(target, session);
      return () => this.releaseEditor(target, session);
    } catch (error) { this.view.setStatus(`原文编辑器无法打开：${explain(error)}`, 'error'); return () => {}; }
  }

  private releaseEditor(target: HTMLElement, expected?: CanvasDocumentEditor): void {
    const session = this.editors.get(target);
    if (!session || expected && session !== expected) return;
    this.editors.delete(target);
    const task = session.close(); this.editorClosures.add(task);
    void task.then(() => this.editorClosures.delete(task), error => {
      this.editorClosures.delete(task);
      if (!this.disposed && !this.closing) this.view.setStatus(`原文编辑器关闭失败：${explain(error)}`, 'error');
    });
  }

  private async closeEditors(): Promise<void> {
    for (const target of this.editors.keys()) this.releaseEditor(target);
    await Promise.all(this.editorClosures);
  }

  private visibleDocs(): DocNode[] {
    if (!this.scene) return [];
    const { x, y, zoom } = this.scene.viewport;
    const width = Math.max(this.element.clientWidth, 400);
    const height = Math.max(this.element.clientHeight, 400);
    const seen = new Set<string>();
    const visible = new Set(canvasVisibility(this.scene).nodes.map(node => node.id));
    return this.scene.nodes.filter((node): node is DocNode => {
      if (!visible.has(node.id)) return false;
      if (node.kind !== 'doc' || seen.has(canvasPreviewKey(node))) return false;
      if ((node.x + node.width) * zoom + x < -300 || node.x * zoom + x > width + 300 ||
        (node.y + node.height) * zoom + y < -300 || node.y * zoom + y > height + 300) return false;
      seen.add(canvasPreviewKey(node));
      return true;
    });
  }

  private loadVisible(): void {
    if (this.disposed || this.closing || !this.scene || this.previewTask) return;
    const generation = this.generation;
    const nodes = this.visibleDocs().filter(node => !this.loaded.has(canvasPreviewKey(node)) && !this.loads.has(canvasPreviewKey(node)));
    if (!nodes.length) return;
    let cursor = 0;
    this.previewTask = Promise.all(Array.from({ length: Math.min(3, nodes.length) }, async () => {
      while (cursor < nodes.length && !this.disposed && !this.closing && generation === this.generation) {
        await this.readPreview(nodes[cursor++], generation);
      }
    })).then(() => undefined).finally(() => {
      this.previewTask = undefined;
      if (!this.disposed && !this.closing) this.loadVisible();
    });
  }

  private async readPreview(node: DocNode, generation = this.generation): Promise<void> {
    const id = node.docId; const key = canvasPreviewKey(node);
    this.loads.get(key)?.abort();
    const request = new AbortController();
    this.loads.set(key, request);
    const current = () => !this.disposed && !this.closing && generation === this.generation && this.loads.get(key) === request && !request.signal.aborted;
    try {
      const doc = await this.api.resolveDocument(id, request.signal);
      let preview;
      if (node.subpath) {
        const target = await resolveCanvasDocumentTarget(doc, node.subpath, request.signal);
        const block = await canvasRequest<{ dom: string }>('/api/block/getBlockDOM', { id: target, notebook: doc.notebook }, request.signal);
        if (typeof block.dom !== 'string' || !block.dom) throw new Error('定位块未返回可显示正文');
        preview = { dom: block.dom, eof: true };
      } else preview = await this.cache.get(doc, request.signal);
      if (!current()) return;
      this.loaded.add(key);
      this.view.setPreview(key, { doc, preview: isPreviewEmpty(preview.dom) ? { ...preview, dom: '' } : preview });
    } catch (error) {
      if (current()) {
        this.loaded.add(key);
        this.view.setPreview(key, { error: `文档暂不可读：${explain(error)}` });
      }
    } finally { if (this.loads.get(key) === request) this.loads.delete(key); }
  }

  handleChange(change: NoteChange): void {
    if (this.disposed || this.closing || !this.scene) return;
    if (change.structure || change.ids.has(this.scene.id)) void this.storageChanged();
    if (change.structure || change.ids.has(this.scene.followParentId || '')) this.scheduleFollowing();
    const refs = new Set(this.scene.nodes.filter((node): node is DocNode => node.kind === 'doc').map(node => node.docId));
    for (const id of change.ids) {
      if (!refs.has(id)) continue;
      for (const item of this.scene.nodes) if (item.kind === 'doc' && item.docId === id) {
        const key = canvasPreviewKey(item); this.loads.get(key)?.abort(); this.loads.delete(key); this.loaded.delete(key);
      }
      this.cache.invalidate(id);
      this.changedIds.add(id);
    }
    this.retryAll ||= change.structure;
    if (!this.retryAll && !this.changedIds.size) return;
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      if (this.retryAll) {
        this.loaded.clear();
        for (const node of this.scene?.nodes || []) if (node.kind === 'doc') {
          const key = canvasPreviewKey(node); this.loads.get(key)?.abort(); this.loads.delete(key);
          this.cache.invalidate(node.docId);
        }
        this.retryAll = false;
      }
      this.changedIds.clear();
      this.loadVisible();
    }, 500);
  }

  check(): void {
    if (this.disposed || this.closing) return;
    void this.storageChanged();
    this.scheduleFollowing();
    this.loaded.clear();
    for (const node of this.visibleDocs()) {
      const key = canvasPreviewKey(node);
      this.loads.get(key)?.abort();
      this.loads.delete(key);
      this.cache.invalidate(node.docId);
    }
    this.loadVisible();
  }

  private recoverRemote = (): void => { void this.storageChanged(); };

  async storageChanged(): Promise<void> {
    if (this.remoteTask) return this.remoteTask;
    if (!this.scene || this.disposed || this.closing || this.saveTask || this.transitionTask) return;
    const task = this.checkRemote();
    this.remoteTask = task;
    try { await task; }
    finally { if (this.remoteTask === task) this.remoteTask = undefined; }
  }

  private async checkRemote(): Promise<void> {
    if (!this.scene) return;
    const stamp = this.stamp();
    const revision = this.scene.revision;
    const title = this.persistedTitle ?? this.scene.title;
    try {
      const latest = await this.store.load(this.scene.id);
      // A focus-triggered read must never replace edits or a save that happened
      // while the read was in flight, including a save that already completed.
      if (!this.current(stamp) || !this.scene || this.scene.revision !== revision || this.saveTask || this.transitionTask) return;
      if (latest.revision !== this.scene.revision || latest.title !== title) {
        if (this.dirty) {
          this.paused = true;
          clearTimeout(this.saveTimer);
          this.view.setStatus('其他窗口已更新此画布，本地修改已保留，请另存副本或重载', 'conflict');
        } else await this.showScene(latest, false, stamp);
      }
      await this.refreshBoards();
    } catch (error) { if (this.current(stamp)) this.view.setStatus(`画布同步检查失败：${explain(error)}`, 'error'); }
  }

  private draftKey(id: string): string { return `${DRAFT_PREFIX}${this.writerId}:${id}`; }
  private writeDraft(): boolean {
    if (!this.scene) return false;
    try {
      sessionStorage.setItem(this.draftKey(this.scene.id), JSON.stringify({ baseRevision: this.scene.revision, scene: this.scene }));
      return true;
    } catch { return false; /* Disk saving still runs when browser storage is unavailable. */ }
  }
  private readDraft(id: string): Draft | undefined {
    try {
      const own = this.draftKey(id);
      const keys = [own];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (!key || key === own || !key.startsWith(DRAFT_PREFIX) || !key.endsWith(`:${id}`)) continue;
        const writer = key.slice(DRAFT_PREFIX.length, -id.length - 1);
        if (!activeWriters.has(writer)) keys.push(key);
      }
      for (const key of keys) {
        if (claimedDrafts.has(key)) continue;
        try {
          const data = JSON.parse(sessionStorage.getItem(key) || 'null');
          if (!data || (data.baseRevision !== null && typeof data.baseRevision !== 'string')) continue;
          const scene = normalizeScene(data.scene);
          if (scene.id !== id) continue;
          claimedDrafts.add(key);
          return { key, baseRevision: data.baseRevision, scene };
        } catch { /* A broken draft cannot replace a valid saved board; keep it untouched. */ }
      }
    } catch { /* Browser storage can be unavailable. */ }
    return undefined;
  }
  private removeDraft(key: string): void { try { sessionStorage.removeItem(key); } catch { /* Keep the draft on failure. */ } }
  private clearDraft(id: string): void { this.removeDraft(this.draftKey(id)); }

  async dispose(): Promise<void> {
    if (this.disposeTask) return this.disposeTask;
    if (this.disposed) return;
    this.closing = true;
    clearTimeout(this.saveTimer);
    clearTimeout(this.changeTimer);
    clearTimeout(this.followingTimer);
    this.lifetime.abort();
    this.sceneLifetime.abort();
    this.loads.forEach(load => load.abort());
    this.loads.clear();
    this.disposeTask = this.close();
    return this.disposeTask;
  }

  private async close(): Promise<void> {
    try {
      // Let already-started copy/load operations finish, but their scene guards
      // prevent them from committing once closing is set.
      await this.transitionTask;
      await this.closeEditors();
      await this.flush();
      if (this.dirty && this.scene && !this.readonly()) {
        await this.store.copy(clone(this.scene));
        this.clearDraft(this.scene.id);
      }
    } catch { /* The synchronous browser draft remains available next time. */ }
    finally {
      this.disposed = true;
      ++this.generation;
      activeWriters.delete(this.writerId);
      activeCanvases.delete(this);
      this.view.dispose();
    }
  }
}
