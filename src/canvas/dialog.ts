export function canvasDialog(anchor: HTMLElement, title: string, signal?: AbortSignal) {
  const doc = anchor.ownerDocument;
  const lifetime = new AbortController();
  const overlay = doc.createElement('div'); overlay.className = 'scv-dialog-overlay scv-feature-overlay';
  const panel = doc.createElement('section'); panel.className = 'scv-dialog scv-feature-dialog';
  panel.contentEditable = 'false';
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', title); panel.setAttribute('aria-modal', 'true');
  const heading = doc.createElement('strong'); heading.textContent = title;
  const status = doc.createElement('p'); status.className = 'scv-feature-status'; status.setAttribute('role', 'status');
  panel.append(heading); overlay.append(panel); anchor.append(overlay);
  const previous = doc.activeElement;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const close = () => { if (lifetime.signal.aborted) return; lifetime.abort(); overlay.remove(); resolveClosed(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  const button = (label: string, callback: () => void) => {
    const element = doc.createElement('button'); element.type = 'button'; element.className = 'scv-button'; element.textContent = label;
    element.addEventListener('click', callback, { signal: lifetime.signal }); return element;
  };
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,[tabindex="0"]')].filter(element => !element.hidden);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    event.stopPropagation();
  }, { signal: lifetime.signal });
  for (const type of ['pointerdown', 'click', 'input', 'change', 'paste']) panel.addEventListener(type, event => event.stopPropagation(), { signal: lifetime.signal });
  overlay.addEventListener('pointerdown', event => { if (event.target === overlay) close(); }, { signal: lifetime.signal });
  signal?.addEventListener('abort', close, { once: true, signal: lifetime.signal });
  if (signal?.aborted) close();
  return { doc, panel, status, close, button, signal: lifetime.signal, closed };
}
