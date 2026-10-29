import type {NoteChange} from "./types";

const BLOCK_ID = /^\d{14}-[a-z0-9]{7}$/;
const STRUCTURE_COMMANDS = new Set([
  "create", "createdailynote", "heading2doc", "li2doc", "docsImported",
  "removeDoc", "moveDoc", "moveDocs", "rename",
  "filetreeSortChanged", "docSortModeChanged",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Parse SiYuan v3.8.3 ws-main detail; malformed/unrelated messages are harmless. */
export function parseNoteChange(detail: unknown): NoteChange {
  const ids = new Set<string>();
  const message = record(detail);
  if (!message || typeof message.cmd !== "string") return {ids, structure: false};
  const data = record(message.data);
  const addId = (value: unknown) => {
    if (typeof value === "string" && BLOCK_ID.test(value)) ids.add(value);
  };
  const addIds = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(addId);
  };
  const addPath = (value: unknown) => {
    if (typeof value !== "string") return;
    const leaf = value.replace(/\/$/, "").split("/").pop();
    if (leaf) addId(leaf.replace(/\.sy$/, ""));
  };

  if (message.cmd === "savedoc") {
    addId(data?.rootID);
    return {ids, structure: false};
  }
  if (message.cmd === "transactions") {
    // Individual operations do not reliably carry a document root ID.
    addIds(record(message.context)?.rootIDs);
    return {ids, structure: false};
  }

  const structure = STRUCTURE_COMMANDS.has(message.cmd);
  if (!structure || !data) return {ids, structure};
  addId(data.id);
  addId(data.srcRootBlockID);
  addIds(data.ids);
  addIds(data.rootIDs);
  addIds(data.childIDs);
  addPath(data.path);
  addPath(data.parentPath);

  const addMove = (value: unknown) => {
    const move = record(value);
    if (!move) return;
    addPath(move.fromPath);
    addPath(move.toPath);
    addPath(move.newPath);
  };
  if (message.cmd === "moveDoc") addMove(data);
  if (message.cmd === "moveDocs" && Array.isArray(data.moves)) data.moves.forEach(addMove);
  return {ids, structure};
}
