import type { DocInfo, PreviewData } from './types';

type Loader = (doc: DocInfo, signal: AbortSignal) => Promise<PreviewData>;
interface Entry {
  value?: PreviewData;
  time: number;
  request?: { controller: AbortController; promise: Promise<PreviewData>; users: number };
}

/** Share in-flight reads; cancel only after every view has detached. */
export class PreviewCache {
  private entries = new Map<string, Entry>();
  constructor(private loader: Loader, private ttl = 30_000, private capacity = 100) {}

  get(doc: DocInfo, signal: AbortSignal): Promise<PreviewData> {
    if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    let entry = this.entries.get(doc.id);
    if (entry?.request?.controller.signal.aborted) {
      this.entries.delete(doc.id);
      entry = undefined;
    }
    if (entry?.value && Date.now() - entry.time < this.ttl) return Promise.resolve(entry.value);
    if (!entry?.request) {
      entry = { time: 0 };
      const current = entry;
      const controller = new AbortController();
      const request = {
        controller, users: 0,
        promise: Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return this.loader(doc, controller.signal);
        }).then(value => {
          if (!controller.signal.aborted && this.entries.get(doc.id) === current) {
            current.value = value;
            current.time = Date.now();
          }
          return value;
        }).finally(() => {
          if (current.request === request) current.request = undefined;
          if (!current.value && this.entries.get(doc.id) === current) this.entries.delete(doc.id);
          this.trim();
        }),
      };
      current.request = request;
      this.entries.set(doc.id, current);
    }
    const request = entry.request!;
    request.users++;
    return new Promise<PreviewData>((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true;
        signal.removeEventListener('abort', abort);
        if (--request.users === 0 && !entry!.value) {
          // A new consumer must not join an already-cancelled request while its
          // rejection/finally callbacks are still waiting in the microtask queue.
          if (this.entries.get(doc.id) === entry) this.entries.delete(doc.id);
          request.controller.abort();
        }
        return true;
      };
      const abort = () => { if (release()) reject(new DOMException('Cancelled', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      request.promise.then(value => { if (release()) resolve(value); }, error => { if (release()) reject(error); });
      if (signal.aborted) abort();
    });
  }

  invalidate(id: string): void {
    this.entries.delete(id);
  }
  clear(): void {
    this.entries.forEach(entry => entry.request?.controller.abort());
    this.entries.clear();
  }
  private trim(): void {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.capacity) break;
      if (!entry.request) this.entries.delete(id);
    }
  }
}
