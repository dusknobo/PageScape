import { SiyuanApi } from './api';
import { PreviewCache } from './cache';
import { createPreviewRenderer, isPreviewEmpty } from './preview';
import { createGalleryView } from './view';
import type { CardData, DocInfo, DocumentContext, GalleryConfig, GalleryView, NoteChange } from './types';

const PAGE_SIZE = 20;
const CONCURRENCY = 3;

export class GalleryController {
  private view: GalleryView;
  private source?: DocInfo;
  private docs: DocInfo[] = [];
  private cards = new Map<string, CardData>();
  private visibleCount = PAGE_SIZE;
  private current?: AbortController;
  private generation = 0;
  private pageGeneration = 0;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private changed = new Set<string>();
  private structureChanged = false;
  private refreshes = new Map<string, AbortController>();
  private versions = new Map<string, number>();
  private sourceFailed = false;
  private pendingSourceId?: string;

  constructor(
    element: HTMLElement,
    private blockId: string,
    private config: GalleryConfig,
    setContent: (content: string) => boolean,
    open: (id: string) => void,
    private api: SiyuanApi,
    private cache: PreviewCache,
    private getSourceContext: () => DocumentContext | undefined = () => undefined,
  ) {
    this.view = createGalleryView({
      element, config,
      onConfig: next => setContent(JSON.stringify(next)),
      onRefresh: () => { void this.reload(true); },
      onLoadMore: () => {
        this.visibleCount += PAGE_SIZE;
        void this.loadCurrentPage();
      },
      onOpen: open,
      renderPreview: createPreviewRenderer,
    });
    this.view.setLoading();
    queueMicrotask(() => { if (!this.disposed) void this.reload(false); });
  }

  handleChange(change: NoteChange): void {
    if (this.disposed) return;
    const sourceId = this.getSourceContext()?.id || this.pendingSourceId || this.source?.id;
    const retrySource = (!this.source || this.sourceFailed) &&
      (sourceId ? change.ids.has(sourceId) : change.ids.size > 0);
    if (!this.config.autoRefresh && !retrySource) return;
    change.ids.forEach(id => {
      if (this.cards.has(id)) {
        this.changed.add(id);
        this.versions.set(id, (this.versions.get(id) || 0) + 1);
      }
    });
    this.structureChanged ||= (this.config.autoRefresh && change.structure) || retrySource;
    if (!this.structureChanged && !this.changed.size) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const ids = [...this.changed];
      this.changed.clear();
      if (this.structureChanged) {
        this.structureChanged = false;
        void this.reload(false);
      } else {
        ids.forEach(id => { void this.refreshCard(id); });
      }
    }, 500);
  }

  check(): void {
    if (!this.disposed && this.config.autoRefresh) void this.reload(true);
  }

  private async reload(force: boolean): Promise<void> {
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.changed.clear();
    this.structureChanged = false;
    this.current?.abort();
    this.refreshes.forEach(request => request.abort());
    this.refreshes.clear();
    const request = this.current = new AbortController();
    this.view.setStatus('正在同步子页面…');
    try {
      const source = await this.resolveSource(request.signal);
      const docs = await this.api.listChildren(source, request.signal);
      if (!this.live(generation)) return;
      if (this.source && source.id !== this.source.id) {
        this.visibleCount = PAGE_SIZE;
        this.cards.clear();
      }
      this.source = source;
      this.sourceFailed = false;
      this.docs = docs;
      const next = new Map<string, CardData>();
      docs.slice(0, this.visibleCount).forEach(doc => {
        if (force) this.cache.invalidate(doc.id);
        next.set(doc.id, { ...this.cards.get(doc.id), doc });
      });
      this.cards = next;
      this.paint();
      await this.loadCurrentPage(generation);
    } catch (error) { this.report(error, generation); }
  }

  private paint(): void {
    this.view.setCards(this.docs.slice(0, this.visibleCount).map(doc => this.cards.get(doc.id) || { doc }), this.docs.length > this.visibleCount);
  }

  private async resolveSource(signal: AbortSignal): Promise<DocInfo> {
    const retryDelays = [120, 300, 700];
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const context = this.getSourceContext();
      this.pendingSourceId = context?.id || this.source?.id;
      try {
        return await this.api.resolveDocument(context?.id || this.blockId, signal, context?.notebook);
      } catch (error) {
        // Only a missing, not-yet-indexed custom block merits this fallback.
        // Errors for a known host document (including locked notebooks) stay visible.
        if (context || isAbort(error) || attempt >= retryDelays.length ||
          !/block not found/i.test(message(error))) throw error;
        await abortableDelay(retryDelays[attempt], signal);
      }
    }
  }

  private async loadCurrentPage(expectedGeneration = this.generation): Promise<void> {
    const signal = this.current?.signal;
    if (!signal || signal.aborted || !this.live(expectedGeneration)) return;
    const pageGeneration = ++this.pageGeneration;
    const currentPage = () => this.live(expectedGeneration) && !signal.aborted && pageGeneration === this.pageGeneration;
    const docs = this.docs.slice(0, this.visibleCount);
    docs.forEach(doc => { if (!this.cards.has(doc.id)) this.cards.set(doc.id, { doc }); });
    this.paint();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, docs.length) }, async () => {
      while (cursor < docs.length && currentPage()) {
        const doc = docs[cursor++];
        const version = this.versions.get(doc.id) || 0;
        try {
          const card = await this.fetchCard(doc, signal);
          if (!currentPage() || this.refreshes.has(doc.id) || version !== (this.versions.get(doc.id) || 0)) continue;
          this.cards.set(doc.id, card);
          this.view.updateCard(card);
        } catch (error) {
          if (currentPage() && !this.refreshes.has(doc.id) && version === (this.versions.get(doc.id) || 0) && !isAbort(error)) {
            const card = { doc, error: message(error) };
            this.cards.set(doc.id, card);
            this.view.updateCard(card);
          }
        }
      }
    });
    await Promise.all(workers);
    if (currentPage()) {
      const failed = [...this.cards.values()].filter(card => card.error).length;
      this.view.setStatus(docs.length ? (failed ? `${failed} 个预览暂时无法加载，点击刷新重试` : `已同步 · ${this.docs.length} 个子页面`) : '当前文档没有子页面', failed > 0);
    }
  }

  private async fetchCard(doc: DocInfo, signal: AbortSignal): Promise<CardData> {
    const preview = await this.cache.get(doc, signal);
    const empty = isPreviewEmpty(preview.dom);
    const children = empty && doc.childCount > 0 ? await this.api.listChildren(doc, signal) : undefined;
    return { doc, preview: empty ? { ...preview, dom: '' } : preview, children };
  }

  private async refreshCard(id: string): Promise<void> {
    const doc = this.docs.find(item => item.id === id);
    if (!doc || !this.cards.has(id) || this.disposed) return;
    this.refreshes.get(id)?.abort();
    const request = new AbortController();
    this.refreshes.set(id, request);
    const generation = this.generation;
    const version = this.versions.get(id) || 0;
    const currentRequest = () => this.live(generation) && !request.signal.aborted &&
      this.refreshes.get(id) === request && version === (this.versions.get(id) || 0);
    try {
      const card = await this.fetchCard(doc, request.signal);
      if (!currentRequest()) return;
      this.cards.set(id, card);
      this.view.updateCard(card);
      this.view.setStatus('已同步 · 刚刚');
    } catch (error) {
      if (currentRequest() && !isAbort(error)) {
        const card = { doc, error: message(error) };
        this.cards.set(id, card);
        this.view.updateCard(card);
        this.view.setStatus('部分预览加载失败，点击刷新重试', true);
      }
    } finally {
      if (this.refreshes.get(id) === request) this.refreshes.delete(id);
    }
  }

  private live(generation: number): boolean { return !this.disposed && generation === this.generation; }
  private report(error: unknown, generation: number): void {
    if (this.live(generation) && !isAbort(error)) {
      this.sourceFailed = true;
      this.view.setStatus(`加载失败：${message(error)}，可点击刷新重试`, true);
    }
  }
  dispose(): void {
    this.disposed = true;
    ++this.generation;
    clearTimeout(this.timer);
    this.current?.abort();
    this.refreshes.forEach(request => request.abort());
    this.refreshes.clear();
    this.view.dispose();
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : '请求失败'; }
function isAbort(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError'; }

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
