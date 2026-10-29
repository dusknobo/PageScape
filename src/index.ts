import { Menu, Plugin, getActiveEditor, getFrontend, openMobileFileById, openTab, saveLayout, showMessage } from 'siyuan';
import type { Custom, Protyle } from 'siyuan';
import { SiyuanApi } from './api';
import { PreviewCache } from './cache';
import { BLOCK_TYPE, DEFAULT_CONFIG, blockMarkdown, parseConfig } from './config';
import { GalleryController } from './controller';
import { parseNoteChange } from './events';
import { getDocumentContext } from './context';
import { CanvasController } from './canvas/controller';
import { CanvasDocumentStore } from './canvas/document-store';
import { CANVAS_DOCUMENT_BLOCK, SIYUAN_ID, parseCanvasDocument } from './canvas/document-format';
import { createCanvasDocumentCard } from './canvas/document-card';
import { InlineCanvas } from './canvas/inline';
import { CANVAS_REFERENCE_BLOCK, canvasReferenceMarkdown, chooseCanvasReference, parseCanvasReference } from './canvas/embed';
import { CanvasTemplateLibrary } from './canvas/templates';
import { showCanvasReferences } from './canvas/references';
import { chooseCanvasDestination } from './canvas/destination';
import { createCanvasMigrationIO } from './canvas/migration-io';
import { loadCanvasMigrationManifest, migrateLegacyCanvases } from './canvas/migration';
import type { CanvasMigrationIO, CanvasMigrationManifest } from './canvas/migration';
import type { CanvasDestination, CanvasScene } from './canvas/types';
import './styles.css';
import './canvas/styles.css';

const ICON = 'icon-siyuan-child-cards';
const CANVAS_ICON = 'icon-siyuan-child-canvas';
type Toolbar = Parameters<Plugin['updateProtyleToolbar']>[0];

export default class ChildCardsPlugin extends Plugin {
  private api = new SiyuanApi();
  private cache = new PreviewCache((doc, signal) => this.api.getPreview(doc, signal));
  private views = new Set<GalleryController>();
  private canvases = new Map<Element, CanvasController>();
  private inlineCanvases = new Map<Element, Map<string, InlineCanvas>>();
  private inlineViews(): InlineCanvas[] { return [...this.inlineCanvases.values()].flatMap(views => [...views.values()]); }
  private canvasStore?: CanvasDocumentStore;
  private templateLibrary?: CanvasTemplateLibrary;
  private migrationIO?: CanvasMigrationIO;
  private migrationTask?: Promise<CanvasMigrationManifest>;
  private creationTask?: Promise<void>;
  private lifetime = new AbortController();
  private checkTimer?: ReturnType<typeof setTimeout>;
  private layoutTimer?: ReturnType<typeof setTimeout>;
  private persistLayout = (): void => {
    clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => { this.layoutTimer = undefined; saveLayout(() => {}); }, 200);
  };
  private onMessage = (event: CustomEvent) => {
    const change = parseNoteChange(event.detail);
    change.ids.forEach(id => this.cache.invalidate(id));
    this.views.forEach(view => view.handleChange(change));
    this.canvases.forEach(view => view.handleChange(change));
    this.inlineViews().forEach(view => view.controller.handleChange(change));
  };
  private onFocus = () => {
    if (document.visibilityState === 'hidden') return;
    clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.views.forEach(view => view.check());
      this.canvases.forEach(view => { view.check(); void view.storageChanged(); });
      this.inlineViews().forEach(view => view.controller.check());
    }, 250);
  };

  onload(): void {
    this.addIcons(`<symbol id="${ICON}" viewBox="0 0 32 32"><path d="M3 4h11v10H3zm15 0h11v10H18zM3 18h11v10H3zm15 0h11v10H18z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol><symbol id="${CANVAS_ICON}" viewBox="0 0 32 32"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2" y="4" width="11" height="9" rx="2"/><rect x="19" y="19" width="11" height="9" rx="2"/><path d="M8 13v10h11M15 20l4 3-4 3"/></g></symbol>`);
    this.migrationIO = createCanvasMigrationIO(this.name);
    this.canvasStore = new CanvasDocumentStore(this.name, undefined, undefined, async oldId => {
      const manifest = await loadCanvasMigrationManifest(this.migrationIO!);
      return manifest?.boards.find(board => board.legacyId === oldId && board.stage === 'verified') ? manifest.mapping[oldId] : undefined;
    });
    this.templateLibrary = new CanvasTemplateLibrary(this.canvasStore);
    const plugin = this;
    this.addTab({
      type: 'canvas',
      init(this: Custom) {
        this.data ||= {};
        const custom = this;
        const controller = new CanvasController(this.element as HTMLElement, this.data.boardId, {
          app: plugin.app,
          templates: plugin.templateLibrary,
          showReferences: id => plugin.showReferences(id, custom.element as HTMLElement),
          openDocument: plugin.openDocument,
          initialDocId: this.data.initialDocId,
          chooseDestination: (initial, options) => chooseCanvasDestination(custom.element as HTMLElement, initial, options),
          newCanvas: () => plugin.newCanvas(custom.element as HTMLElement),
          importCanvas: (scene, title) => plugin.importCanvas(scene, title, custom.element as HTMLElement),
          migrateLegacy: async () => {
            const destination = await chooseCanvasDestination(custom.element as HTMLElement);
            if (!destination) return undefined;
            const result = await plugin.migrateCanvases(destination);
            return Object.values(result.mapping)[0];
          },
          onTitle: title => {
            if (custom.tab.title === `Canvas · ${title}`) return;
            custom.tab.updateTitle(`Canvas · ${title}`); plugin.persistLayout();
          },
          onBoard: id => {
            if (custom.data.boardId === id) return;
            custom.data.boardId = id; plugin.persistLayout();
          },
        }, plugin.api, plugin.cache, plugin.canvasStore!);
        plugin.canvases.set(this.element, controller);
      },
      beforeDestroy(this: Custom) { void plugin.canvases.get(this.element)?.flush(); },
      destroy(this: Custom) {
        const controller = plugin.canvases.get(this.element);
        plugin.canvases.delete(this.element);
        void controller?.dispose();
      },
      resize(this: Custom) { plugin.canvases.get(this.element)?.check(); },
      update(this: Custom) { void plugin.canvases.get(this.element)?.storageChanged(); },
    });
    this.addTopBar({ id: 'child-canvas', icon: CANVAS_ICON, title: 'Canvas 画布 · 新建 / 打开',
      callback: event => {
        const menu = new Menu('child-canvas-actions');
        menu.addItem({ label: '新建 Canvas · New Canvas', click: () => { void this.newCanvas(); } });
        menu.addItem({ label: '打开已有 Canvas · Open Canvas', click: () => { void this.openCanvas(); } });
        menu.addItem({ label: '插入或引用 Canvas · Embed Canvas', click: () => { const editor = getActiveEditor(); if (editor) void this.insertCanvas(editor); else showMessage('请先打开要插入画布的文档。'); } });
        menu.addItem({ label: '查看当前文档的画布引用', click: () => this.showActiveReferences() });
        menu.open({ x: event.clientX, y: event.clientY });
      } });
    this.customBlockRenders[CANVAS_DOCUMENT_BLOCK] = {
      render: ({ element, content }) => {
        const context = () => getDocumentContext(element);
        const open = () => {
          const doc = context();
          if (!doc) { showMessage('请在所属文档中打开画布概要。'); return; }
          void this.openCanvasDocument(doc.id);
        };
        try {
          const payload = parseCanvasDocument(content); const doc = context();
          const inline = doc && this.mountInlineCanvas(element, doc.id);
          if (inline) return inline;
          return createCanvasDocumentCard({ element, scene: { ...payload.scene, ...(doc ? { id: doc.id } : {}) }, onOpen: open });
        } catch (error) {
          return createCanvasDocumentCard({ element, error: `画布数据不可读：${error instanceof Error ? error.message : String(error)}。请从文档历史恢复，原内容未重置。`, onOpen: open });
        }
      },
    };
    this.customBlockRenders[CANVAS_REFERENCE_BLOCK] = {
      render: ({ element, content }) => {
        try {
          const docId = parseCanvasReference(content);
          const inline = this.mountInlineCanvas(element, docId);
          if (inline) return inline;
          return createCanvasDocumentCard({ element, onOpen: () => { void this.openCanvasDocument(docId); } });
        } catch (error) {
          return createCanvasDocumentCard({ element, error: `画布引用不可读：${error instanceof Error ? error.message : String(error)}`, onOpen: () => {} });
        }
      },
    };
    this.customBlockRenders[BLOCK_TYPE] = {
      render: ({ element, content, setContent }) => {
        const block = element.closest<HTMLElement>('[data-type="NodeCustomBlock"]');
        const id = block?.getAttribute('data-node-id');
        if (!id) { element.textContent = '无法识别卡片块，请重新打开文档。'; return; }
        try {
          const config = parseConfig(content);
          const view = new GalleryController(element, id, config, setContent, this.openDocument, this.api, this.cache, () => getDocumentContext(element));
          this.views.add(view);
          return () => { this.views.delete(view); view.dispose(); };
        } catch (error) {
          const text = document.createElement('p');
          text.textContent = `子页卡片：${error instanceof Error ? error.message : '设置无效'}`;
          const reset = document.createElement('button');
          reset.className = 'b3-button b3-button--outline';
          reset.type = 'button'; reset.textContent = '重置此卡片设置';
          reset.onclick = () => { if (!setContent(JSON.stringify(DEFAULT_CONFIG))) showMessage('当前文档只读，无法保存设置。'); };
          element.replaceChildren(text, reset);
          return () => { reset.onclick = null; };
        }
      },
    };
    this.protyleSlash = [{
      id: 'insert-child-cards',
      filter: ['子页卡片', '子页面', '子文档', 'cards', 'childcards', 'child cards', 'childpages', 'child pages', 'children', 'gallery'],
      html: `<div class="b3-list-item__first"><svg class="b3-list-item__graphic"><use xlink:href="#${ICON}"></use></svg><span class="b3-list-item__text">子页卡片 · Child Cards</span></div>`,
      callback: protyle => this.insert(protyle),
    }, {
      id: 'embed-child-canvas', filter: ['embedcanvas', 'inlinecanvas', 'embed canvas', '插入画布', '引用画布', '嵌入画布'],
      html: `<div class="b3-list-item__first"><svg class="b3-list-item__graphic"><use xlink:href="#${CANVAS_ICON}"></use></svg><span class="b3-list-item__text">插入或引用 Canvas · Embed Canvas</span></div>`,
      callback: protyle => { void this.insertCanvas(protyle); },
    }, {
      id: 'new-child-canvas', filter: ['newcanvas', 'new canvas', '新建画布', '新建canvas', '新建 Canvas'],
      html: `<div class="b3-list-item__first"><svg class="b3-list-item__graphic"><use xlink:href="#${CANVAS_ICON}"></use></svg><span class="b3-list-item__text">新建 Canvas 画布</span></div>`,
      callback: () => { void this.newCanvas(); },
    }, {
      id: 'open-child-canvas', filter: ['canvas', '画布', '白板', 'infinite canvas'],
      html: `<div class="b3-list-item__first"><svg class="b3-list-item__graphic"><use xlink:href="#${CANVAS_ICON}"></use></svg><span class="b3-list-item__text">打开 Canvas 画布</span></div>`,
      callback: () => { void this.openCanvas(); },
    }];
    this.addCommand({ langKey: 'insertChildCards', hotkey: '', callback: this.insertAtActiveEditor });
    if (this.i18n.insertChildCards !== 'Insert Child Cards') {
      this.addCommand({ langKey: 'insertChildCardsEnglish', hotkey: '', callback: this.insertAtActiveEditor });
    }
    this.addCommand({ langKey: 'openCanvas', hotkey: '', callback: () => { void this.openCanvas(); } });
    this.addCommand({ langKey: 'embedCanvas', hotkey: '', callback: () => { const editor = getActiveEditor(); if (editor) void this.insertCanvas(editor); else showMessage('请先打开要插入画布的文档。'); } });
    this.addCommand({ langKey: 'canvasReferences', hotkey: '', callback: () => this.showActiveReferences() });
    this.addCommand({ langKey: 'newCanvas', hotkey: '', callback: () => { void this.newCanvas(); } });
    this.addCommand({ langKey: 'importChildrenToCanvas', hotkey: '', callback: () => { void this.importCurrentChildren(); } });
    this.addCommand({ langKey: 'migrateCanvasDocuments', hotkey: '', callback: () => { void this.migrateFromActive(); } });
    this.addCommand({ langKey: 'openDocumentCanvas', hotkey: '', callback: () => {
      const id = getActiveEditor()?.protyle.block.rootID;
      if (id) {
        const views = this.inlineViews().filter(view => view.anchor.dataset.canvasHost === id && view.anchor.getClientRects().length);
        const focused = views.find(view => view.anchor.contains(document.activeElement));
        void this.openCanvasDocument((focused || views[0])?.docId || id);
      } else showMessage('请先打开包含 Canvas 画布的文档。');
    } });
    if (this.i18n.openCanvas !== 'Open Canvas') {
      this.addCommand({ langKey: 'openCanvasEnglish', hotkey: '', callback: () => { void this.openCanvas(); } });
      this.addCommand({ langKey: 'importChildrenToCanvasEnglish', hotkey: '', callback: () => { void this.importCurrentChildren(); } });
    }
    if (this.i18n.newCanvas !== 'New Canvas') {
      this.addCommand({ langKey: 'newCanvasEnglish', hotkey: '', callback: () => { void this.newCanvas(); } });
    }
    this.eventBus.on('ws-main', this.onMessage);
    this.eventBus.on('switch-protyle', this.onFocus);
    window.addEventListener('focus', this.onFocus);
    document.addEventListener('visibilitychange', this.onFocus);
  }

  updateProtyleToolbar(toolbar: Toolbar): Toolbar {
    return [...toolbar, {
      name: 'insert-child-cards', icon: ICON, tip: '插入子页卡片 · Insert Child Cards', tipPosition: 'n',
      click: protyle => this.insert(protyle),
    }, {
      name: 'embed-child-canvas', icon: CANVAS_ICON, tip: '插入或引用 Canvas · Embed Canvas', tipPosition: 'n',
      click: protyle => { void this.insertCanvas(protyle); },
    }, {
      name: 'canvas-references', icon: CANVAS_ICON, tip: '画布反向引用 · Canvas References', tipPosition: 'n',
      click: protyle => { const id = protyle.protyle.block.rootID; if (id) this.showReferences(id); },
    }];
  }

  private mountInlineCanvas(element: HTMLElement, docId: string): (() => void) | undefined {
    const host = getDocumentContext(element); const editor = element.closest('.protyle-wysiwyg');
    const blockId = element.closest('[data-type="NodeCustomBlock"]')?.getAttribute('data-node-id');
    if (!host || !editor || !blockId || !SIYUAN_ID.test(blockId) || ['mobile', 'browser-mobile'].includes(getFrontend())) return;
    let views = this.inlineCanvases.get(editor);
    if (!views) { views = new Map(); this.inlineCanvases.set(editor, views); }
    let view = views.get(blockId);
    if (view && view.docId !== docId) { void view.dispose(); view = undefined; this.inlineCanvases.set(editor, views); }
    if (!view) {
      const created: InlineCanvas = new InlineCanvas({ element, docId, hostDocId: host.id, blockId, api: this.api, cache: this.cache, store: this.canvasStore!,
        host: {
          app: this.app, openDocument: this.openDocument, onTitle: () => {}, onBoard: () => {},
          templates: this.templateLibrary, showReferences: id => this.showReferences(id, created.anchor),
          openCanvas: id => this.openCanvasDocument(id),
          chooseDestination: (initial, options) => chooseCanvasDestination(created.anchor, initial, options),
          importCanvas: (scene, title) => this.importCanvas(scene, title, created.anchor), newCanvas: () => this.newCanvas(created.anchor),
        },
        onDispose: () => {
          if (views!.get(blockId) === created) views!.delete(blockId);
          if (!views!.size && this.inlineCanvases.get(editor) === views) this.inlineCanvases.delete(editor);
        },
      });
      views.set(blockId, created); view = created;
    }
    return view?.attach(element);
  }

  private async insertCanvas(protyle: Protyle): Promise<void> {
    const editor = protyle.protyle; const hostId = editor.block.rootID;
    const wysiwyg = editor.wysiwyg?.element;
    if (editor.disabled || !editor.lute || !wysiwyg || !hostId) { showMessage('当前文档只读或尚未就绪，无法插入画布。'); return; }
    const selection = document.getSelection();
    const range = selection?.rangeCount && wysiwyg.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.getRangeAt(0).cloneRange() : undefined;
    try {
      const id = await chooseCanvasReference(document.body, this.canvasStore!, this.lifetime.signal, async () => {
        const destination = await chooseCanvasDestination(document.body, hostId, { title: '新画布', askTitle: true, signal: this.lifetime.signal });
        return destination ? (await this.canvasStore!.create(destination.title || '新画布', destination)).id : undefined;
      });
      if (!id || this.lifetime.signal.aborted) return;
      if (editor.disabled || !wysiwyg.isConnected || editor.block.rootID !== hostId) { showMessage('原文档已切换或只读，画布未插入。'); return; }
      if (range?.commonAncestorContainer.isConnected) { selection?.removeAllRanges(); selection?.addRange(range); }
      protyle.insert(editor.lute.Md2BlockDOM(canvasReferenceMarkdown(this.name, id)), true);
    } catch (error) { showMessage(`插入画布失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  private showActiveReferences(): void {
    const id = getActiveEditor()?.protyle.block.rootID;
    if (id) this.showReferences(id); else showMessage('请先打开要查看引用的文档。');
  }

  private showReferences(id: string, anchor = document.body): void {
    showCanvasReferences(anchor, this.canvasStore!, id, { pluginName: this.name, signal: this.lifetime.signal,
      openDocument: this.openDocument, openCanvas: async (docId, nodeId) => { const canvas = await this.openCanvas(undefined, docId); await canvas?.focusNode(nodeId); } });
  }

  private insert(protyle: Protyle): void {
    const editor = protyle.protyle;
    if (editor.disabled || !editor.lute) { showMessage('当前文档只读，无法插入卡片。'); return; }
    protyle.insert(editor.lute.Md2BlockDOM(blockMarkdown(this.name)), true);
  }

  private insertAtActiveEditor = (): void => {
    const editor = getActiveEditor();
    if (editor) this.insert(editor);
    else showMessage('请先打开要插入卡片的文档。');
  };

  private openDocument = (id: string): void => {
    const frontend = getFrontend();
    if (frontend === 'mobile' || frontend === 'browser-mobile') openMobileFileById(this.app, id);
    else void openTab({ app: this.app, doc: { id } }).catch(error => showMessage(`打开文档失败：${String(error)}`));
  };

  private async openCanvas(initialDocId = getActiveEditor()?.protyle.block.rootID, boardId?: string, openNewTab = false): Promise<CanvasController | undefined> {
    const frontend = getFrontend();
    if (frontend === 'mobile' || frontend === 'browser-mobile') {
      showMessage('独立 Canvas 目前支持桌面端和桌面浏览器。'); return;
    }
    try {
      const opened = Object.values(this.getOpenedTab()).flat().filter(tab => this.canvases.has(tab.element));
      const candidates = boardId ? opened.filter(tab => tab.data?.boardId === boardId) : opened;
      const existing = openNewTab ? undefined : candidates.find(tab => tab.element.getClientRects().length > 0) || candidates[0];
      const tab = await openTab({ app: this.app, openNewTab: openNewTab && !existing, custom: {
        id: this.name + 'canvas', icon: CANVAS_ICON, title: existing?.tab.title || 'Canvas',
        data: existing?.data || { initialDocId, ...(boardId ? { boardId } : {}) },
      } });
      const controller = this.canvases.get((tab.model as Custom).element);
      await controller?.ready;
      return controller;
    } catch (error) { showMessage(`打开画布失败：${String(error)}`); }
  }

  /** Creating a canvas never reuses another canvas's tab data or document ID. */
  private async newCanvas(anchor?: HTMLElement, initialDocId = anchor ? undefined : getActiveEditor()?.protyle.block.rootID): Promise<void> {
    if (this.creationTask) return this.creationTask;
    if (['mobile', 'browser-mobile'].includes(getFrontend())) { showMessage('新建 Canvas 目前支持桌面端和桌面浏览器。'); return; }
    this.creationTask = (async () => {
      try {
        const books = await this.canvasStore!.list();
        const names = new Set(books.map(board => board.title));
        let title = '新画布'; let suffix = 2;
        while (names.has(title)) title = `新画布 ${suffix++}`;
        if ((anchor && !anchor.isConnected) || this.lifetime.signal.aborted) return;
        const element = anchor?.isConnected ? anchor : document.body;
        const destination = await chooseCanvasDestination(element, initialDocId, { title, askTitle: true, signal: this.lifetime.signal });
        if (!destination || !element.isConnected || this.lifetime.signal.aborted) return;
        const scene = await this.canvasStore!.create(destination.title || title, destination);
        if (!this.lifetime.signal.aborted) await this.openCanvas(initialDocId, scene.id, true);
      } catch (error) { showMessage(`新建画布失败：${error instanceof Error ? error.message : String(error)}`); }
    })();
    try { await this.creationTask; } finally { this.creationTask = undefined; }
  }

  /** Import into a new document; a cancelled dialog leaves the source canvas intact. */
  private async importCanvas(scene: CanvasScene, title: string, anchor: HTMLElement): Promise<boolean> {
    if (this.creationTask) throw new Error('已有画布创建操作正在进行，请完成后重试');
    if (!anchor.isConnected || this.lifetime.signal.aborted) return false;
    let imported = false;
    const task = (async () => {
      const destination = await chooseCanvasDestination(anchor, undefined, { title, askTitle: true, signal: this.lifetime.signal });
      if (!destination || !anchor.isConnected || this.lifetime.signal.aborted) return;
      const saved = await this.canvasStore!.copy(scene, destination);
      imported = true;
      if (!this.lifetime.signal.aborted) await this.openCanvas(undefined, saved.id, true);
    })();
    this.creationTask = task;
    try { await task; return imported; } finally { if (this.creationTask === task) this.creationTask = undefined; }
  }

  private async importCurrentChildren(): Promise<void> {
    const id = getActiveEditor()?.protyle.block.rootID;
    if (!id) { showMessage('请先打开要导入子页的父文档。'); return; }
    const controller = await this.openCanvas(id);
    await controller?.importChildren(id);
  }

  private async openCanvasDocument(docId: string): Promise<void> {
    if (!SIYUAN_ID.test(docId)) { showMessage('画布文档 ID 无效'); return; }
    const controller = await this.openCanvas(undefined, docId);
    await controller?.openBoard(docId);
  }

  private async migrateFromActive(): Promise<void> {
    const controller = await this.openCanvas();
    if (!controller) return;
    const element = [...this.canvases].find(([, view]) => view === controller)?.[0] as HTMLElement | undefined;
    if (!element) return;
    try {
      await controller.flush();
      const destination = await chooseCanvasDestination(element);
      if (!destination) return;
      const result = await this.migrateCanvases(destination);
      const first = Object.values(result.mapping)[0]; if (first) await controller.openBoard(first);
    } catch (error) { showMessage(`迁移失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Explicitly invoked migration. The legacy files have no write/delete path. */
  async migrateCanvases(destination: CanvasDestination): Promise<CanvasMigrationManifest> {
    if (this.migrationTask) return this.migrationTask;
    const store = this.canvasStore!;
    this.migrationTask = (async () => {
      const existing = await loadCanvasMigrationManifest(this.migrationIO!);
      const fixedDestination = existing?.destination || destination;
      return migrateLegacyCanvases(this.migrationIO!, {
      allocateDocId: () => store.allocateDocId(),
      findByLegacyId: id => store.findByLegacyId(id),
      createFromLegacy: async (scene, legacyId, runId, reservedId) => (await store.importLegacy(scene, legacyId, runId, reservedId, fixedDestination)).id,
      // SiYuan's -1/checkBlockExist=false cannot prove absence (locked or unindexed).
      // Throwing preserves an uncertain journal instead of creating duplicate IDs.
      load: (id, legacyId) => store.load(id, legacyId),
      }, { confirmed: true, destination: fixedDestination });
    })();
    try {
      const result = await this.migrationTask;
      showMessage(`已将 ${result.boards.length} 张画布迁移为思源文档。原 JSON 和校验备份均保留。`);
      return result;
    } finally { this.migrationTask = undefined; }
  }

  async onDataChanged(): Promise<void> {
    this.cache.clear();
    this.views.forEach(view => view.check());
    await Promise.all(this.inlineViews().map(view => view.controller.storageChanged()));
    const manifest = await loadCanvasMigrationManifest(this.migrationIO!);
    const opened = Object.values(this.getOpenedTab()).flat();
    await Promise.all([...this.canvases].map(async ([element, view]) => {
      const oldId = opened.find(tab => tab.element === element)?.data?.boardId;
      if (manifest?.stage === 'complete' && typeof oldId === 'string' && !SIYUAN_ID.test(oldId) && manifest.mapping[oldId]) await view.openBoard(manifest.mapping[oldId]);
      else await view.storageChanged();
    }));
  }

  async onunload(): Promise<void> {
    this.lifetime.abort();
    this.eventBus.off('ws-main', this.onMessage);
    this.eventBus.off('switch-protyle', this.onFocus);
    window.removeEventListener('focus', this.onFocus);
    document.removeEventListener('visibilitychange', this.onFocus);
    clearTimeout(this.checkTimer);
    if (this.layoutTimer) { clearTimeout(this.layoutTimer); this.layoutTimer = undefined; saveLayout(() => {}); }
    this.views.forEach(view => view.dispose());
    this.views.clear();
    await Promise.all([...this.canvases.values()].map(view => view.dispose()));
    this.canvases.clear();
    await Promise.all(this.inlineViews().map(view => view.dispose()));
    this.inlineCanvases.clear();
    this.cache.clear();
  }
}
