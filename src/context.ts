import { getAllEditor } from 'siyuan';
import type { DocumentContext } from './types';

const BLOCK_ID = /^\d{14}-[a-z0-9]{7}$/;

/** The host document already exists when a newly inserted custom block does not. */
export function getDocumentContext(element: HTMLElement): DocumentContext | undefined {
  const root = element.closest('.protyle-wysiwyg');
  if (!root) return;
  const host = getAllEditor().find(editor => editor.protyle?.wysiwyg?.element === root);
  const id = host?.protyle.block.rootID;
  if (!id || !BLOCK_ID.test(id)) return;
  const notebook = host?.protyle.notebookId;
  return { id, notebook: notebook && BLOCK_ID.test(notebook) ? notebook : undefined };
}

export function isDocumentReadonly(element: HTMLElement): boolean {
  const root = element.closest('.protyle-wysiwyg');
  const host = root && getAllEditor().find(editor => editor.protyle?.wysiwyg?.element === root);
  return !host || Boolean(host.protyle.disabled);
}
