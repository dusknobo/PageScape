import type { DocInfo, NoteChange, PreviewData } from '../types';
import type { App } from 'siyuan';

export interface Point { x: number; y: number }
export interface CanvasViewport extends Point { zoom: number }
export type NodeColor = 'neutral' | 'red' | 'blue' | 'green' | 'orange' | 'yellow' | 'cyan' | 'purple' | `#${string}`;
export type NodeSide = 'top' | 'right' | 'bottom' | 'left';
export type NodeEnd = 'none' | 'arrow';
export interface CanvasSettings { snapToGrid?: boolean; snapToObjects?: boolean; readOnly?: boolean }
export interface BaseNode extends Point {
  id: string;
  kind: 'doc' | 'text' | 'group' | 'file' | 'link';
  width: number;
  height: number;
  color: NodeColor;
  groupId?: string;
  jsonCanvas?: Record<string, unknown>;
}
export interface DocNode extends BaseNode { kind: 'doc'; docId: string; title: string; subpath?: string; followedFrom?: string; detached?: boolean }
export interface TextNode extends BaseNode { kind: 'text'; text: string }
export interface FileNode extends BaseNode { kind: 'file'; file: string; subpath?: string; name?: string; mediaType?: 'image' | 'pdf' | 'audio' | 'video' | 'file'; unresolved?: boolean }
export interface LinkNode extends BaseNode { kind: 'link'; url: string; title?: string }
export interface GroupNode extends BaseNode { kind: 'group'; title: string; background?: string; backgroundStyle?: 'cover' | 'ratio' | 'repeat'; collapsed?: boolean }
export type CanvasNode = DocNode | TextNode | GroupNode | FileNode | LinkNode;
export interface CanvasEdge { id: string; from: string; to: string; label: string; color: NodeColor; fromSide?: NodeSide; toSide?: NodeSide; fromEnd?: NodeEnd; toEnd?: NodeEnd; jsonCanvas?: Record<string, unknown> }
export interface CanvasScene {
  version: 1;
  id: string;
  title: string;
  revision: string | null;
  updatedAt: number;
  viewport: CanvasViewport;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  settings?: CanvasSettings;
  jsonCanvas?: Record<string, unknown>;
  followParentId?: string;
  followExcluded?: string[];
}
export interface CanvasTemplate { id: string; name: string; updatedAt: number; nodes: CanvasNode[]; edges: CanvasEdge[]; builtin?: boolean }
export interface CanvasTemplates {
  list(): Promise<CanvasTemplate[]>;
  save(name: string, scene: CanvasScene): Promise<CanvasTemplate>;
  remove(id: string): Promise<void>;
}
export interface CanvasSummary { id: string; title: string; updatedAt: number }
export interface CanvasDestination { notebook: string; parentId?: string; title?: string }
export interface CanvasPreview { doc?: DocInfo; preview?: PreviewData; error?: string }

export interface CanvasViewOptions {
  element: HTMLElement;
  inline?: boolean;
  isReadonly?: () => boolean;
  onOpenCanvas?: () => void;
  onChange: (scene: CanvasScene) => void;
  onOpenDocument: (id: string) => void;
  onAddDocument: () => void;
  onImportChildren: () => void;
  onChooseBoard: (id: string) => void;
  onNewBoard: () => void;
  onRenameBoard: (title: string) => void;
  onSave: () => void;
  onReload: () => void;
  onSaveCopy: () => void;
  onRefresh: () => void;
  onFollowChildren?: () => void;
  onStopFollowing?: () => void;
  onTemplates?: () => void;
  onReferences?: (id: string) => void;
  onMigrateLegacy?: () => void;
  onImportCanvas?: (file: File) => void;
  onAddMedia?: (files: File[], point?: Point, replaceNodeId?: string) => void;
  onEditDocument?: (id: string, target: HTMLElement) => (() => void);
  onConvertText?: (nodeId: string) => void;
  onSwapDocument?: (nodeId: string) => void;
  onDrop: (ids: string[], point: Point) => void;
  renderPreview: (preview: PreviewData, target: HTMLElement, showImages: boolean) => (() => void);
}
export interface CanvasView {
  setScene: (scene: CanvasScene) => void;
  setRevision: (revision: string | null, updatedAt: number) => void;
  setBoards: (boards: CanvasSummary[]) => void;
  setPreview: (docId: string, preview: CanvasPreview) => void;
  setStatus: (message: string, tone?: 'normal' | 'error' | 'conflict') => void;
  getCenter: () => Point;
  focusNode: (id: string) => void;
  dispose: () => void;
}
export interface CanvasStorageIO {
  read: (name: string) => Promise<unknown>;
  write: (name: string, value: unknown) => Promise<void>;
}
export interface CanvasStore {
  list: () => Promise<CanvasSummary[]>;
  load: (id: string) => Promise<CanvasScene>;
  save: (scene: CanvasScene, expectedRevision: string | null) => Promise<CanvasScene>;
  create: (title: string, destination?: CanvasDestination) => Promise<CanvasScene>;
  copy: (scene: CanvasScene, destination?: CanvasDestination) => Promise<CanvasScene>;
}
export interface CanvasControllerHost {
  app?: App;
  inline?: boolean;
  isReadonly?: () => boolean;
  openCanvas?: (id: string) => Promise<void>;
  openDocument: (id: string) => void;
  onTitle: (title: string) => void;
  onBoard: (id: string) => void;
  initialDocId?: string;
  chooseDestination?: (initialDocId?: string, options?: { title?: string; askTitle?: boolean; signal?: AbortSignal }) => Promise<CanvasDestination | null>;
  newCanvas?: () => Promise<void>;
  migrateLegacy?: () => Promise<string | undefined>;
  importCanvas?: (scene: CanvasScene, title: string) => Promise<boolean>;
  templates?: CanvasTemplates;
  showReferences?: (id: string) => void;
}
export interface CanvasSession {
  handleChange: (change: NoteChange) => void;
  check: () => void;
  storageChanged: () => Promise<void>;
  flush: () => Promise<void>;
  dispose: () => Promise<void>;
}
