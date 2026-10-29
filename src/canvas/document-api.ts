export class CanvasApiError extends Error {
  constructor(public code: number, message: string) { super(message); this.name = 'CanvasApiError'; }
}

export async function canvasRequest<T>(route: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(route, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`思源接口读取失败（HTTP ${response.status}）`);
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || !('code' in result)) throw new Error('思源返回了无效响应');
  const data = result as { code: number; msg?: string; data: T };
  if (data.code !== 0) throw new CanvasApiError(data.code, data.msg || '思源接口操作失败');
  return data.data;
}

export interface CanvasNotebook { id: string; name: string; closed: boolean; encrypted?: boolean; unlocked?: boolean }
export async function listCanvasNotebooks(): Promise<CanvasNotebook[]> {
  const data = await canvasRequest<{ notebooks: CanvasNotebook[] }>('/api/notebook/lsNotebooks');
  if (!Array.isArray(data.notebooks)) throw new Error('笔记本列表无效');
  return data.notebooks.filter(book => !book.closed && !book.encrypted);
}
