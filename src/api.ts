import type {DocInfo, PreviewData} from "./types";

const BLOCK_ID = /^\d{14}-[a-z0-9]{7}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !BLOCK_ID.test(value)) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function requirePath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") ||
    value.includes("..") || value.includes("\\") || value.includes("\0")) {
    throw new Error("文档路径无效");
  }
  return value;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// File-tree names come from document IAL; getBlockInfo already unescapes its title.
function decodeTreeName(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? whole;
    const hex = entity[1].toLowerCase() === "x";
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code) : whole;
  });
}

async function post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
    signal,
  });
  signal?.throwIfAborted();
  if (!response.ok) throw new Error(`思源读取失败（HTTP ${response.status}）`);
  const result = record(await response.json());
  signal?.throwIfAborted();
  if (!result || typeof result.code !== "number") throw new Error("思源返回了无效响应");
  if (result.code !== 0) {
    throw new Error(string(result.msg) || `思源读取失败（${result.code}）`);
  }
  const data = record(result.data);
  if (!data) throw new Error("思源响应缺少数据");
  return data;
}

export class SiyuanApi {
  async resolveDocument(blockId: string, signal?: AbortSignal, notebook?: string): Promise<DocInfo> {
    requireId(blockId, "块 ID");
    const data = await post("/api/block/getBlockInfo", {
      id: blockId,
      ...(notebook ? {notebook: requireId(notebook, "笔记本 ID")} : {}),
    }, signal);
    return {
      id: requireId(data.rootID, "文档 ID"),
      notebook: requireId(data.box, "笔记本 ID"),
      path: requirePath(data.path),
      title: string(data.rootTitle) || "未命名文档",
      icon: string(data.rootIcon),
      childCount: 0,
    };
  }

  async listChildren(parent: DocInfo, signal?: AbortSignal): Promise<DocInfo[]> {
    const notebook = requireId(parent.notebook, "笔记本 ID");
    const data = await post("/api/filetree/listDocsByPath", {
      notebook,
      path: requirePath(parent.path),
      showHidden: false,
      maxListCount: 0,
      ignoreMaxListHint: true,
    }, signal);
    if (!Array.isArray(data.files)) throw new Error("思源返回了无效子文档列表");
    // Omit sort so SiYuan resolves the parent's inherited/native sorting mode.
    return data.files.map((value: unknown): DocInfo => {
      const file = record(value);
      if (!file) throw new Error("思源返回了无效文档信息");
      const count = file.subFileCount;
      return {
        id: requireId(file.id, "子文档 ID"),
        notebook,
        path: requirePath(file.path),
        title: decodeTreeName(string(file.name).replace(/\.sy$/, "")) || "未命名文档",
        icon: string(file.icon),
        childCount: typeof count === "number" && Number.isFinite(count)
          ? Math.max(0, Math.floor(count)) : 0,
      };
    });
  }

  async getPreview(doc: DocInfo, signal?: AbortSignal): Promise<PreviewData> {
    const data = await post("/api/filetree/getDoc", {
      id: requireId(doc.id, "文档 ID"),
      notebook: requireId(doc.notebook, "笔记本 ID"),
      index: 0,
      mode: 0,
      size: 64,
      highlight: false,
    }, signal);
    if (typeof data.content !== "string") throw new Error("思源返回了无效文档内容");
    return {dom: data.content, eof: data.eof === true};
  }
}
