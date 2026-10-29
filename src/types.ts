export interface GalleryConfig {
  version: 1;
  columns: 0 | 1 | 2 | 3 | 4;
  previewHeight: number;
  showImages: boolean;
  autoRefresh: boolean;
}

export interface DocInfo {
  id: string;
  title: string;
  icon: string;
  notebook: string;
  path: string;
  childCount: number;
}

export interface PreviewData {
  dom: string;
  eof: boolean;
}

export interface CardData {
  doc: DocInfo;
  preview?: PreviewData;
  children?: DocInfo[];
  error?: string;
}

export interface ViewOptions {
  element: HTMLElement;
  config: GalleryConfig;
  onConfig: (config: GalleryConfig) => boolean;
  onRefresh: () => void;
  onLoadMore: () => void;
  onOpen: (id: string) => void;
  renderPreview: (preview: PreviewData, target: HTMLElement, showImages: boolean) => (() => void);
}

export interface GalleryView {
  setLoading: () => void;
  setCards: (cards: CardData[], hasMore: boolean) => void;
  updateCard: (card: CardData) => void;
  setStatus: (message: string, error?: boolean) => void;
  dispose: () => void;
}

export interface NoteChange {
  ids: Set<string>;
  structure: boolean;
}

export interface DocumentContext {
  id: string;
  notebook?: string;
}
