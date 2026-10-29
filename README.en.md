# PageScape · 页境

**Let pages unfold. Let knowledge connect.**

[中文说明](README.md) · [Download](https://github.com/dusknobo/PageScape/releases/latest) · [Changelog](https://github.com/dusknobo/PageScape/blob/main/CHANGELOG.md)

PageScape is a SiYuan plugin for live child-document previews and editable, document-backed canvases. Use a canvas inside a note or open it in a dedicated tab. Multiple notes can embed the same canvas.

![PageScape interface with demonstration content](docs/images/overview.png)

## Features

- **Live child cards:** preview direct child documents inside the parent note, with configurable columns, height and images.
- **Shared inline Canvas:** insert an existing canvas or create one at the cursor; all references share the same source layout.
- **Document, text and media cards:** Markdown notes, document fragments, images, PDFs, audio, video and web links.
- **Layout tools:** multi-selection, copy/paste, undo/redo, colors, alignment, distribution, grid and connection-based tree layouts.
- **Groups and connections:** collapsible groups, background images, labeled edges, directional arrows, reconnection and endpoint navigation.
- **Follow children:** automatically add new child documents without moving existing cards. Removed children are marked; manually removed cards stay excluded.
- **Navigation:** search card titles, text and loaded previews, use a minimap and jump to groups.
- **Reverse references:** find canvases that reference a document and notes that embed a canvas, then jump to the result.
- **Templates:** built-in study, paper-reading and module templates; save custom templates as native SiYuan canvas documents.
- **Document-backed storage:** automatic saving, save-copy, conflict protection, JSON Canvas import/export and PNG export.

## Install

Version **0.6.1**. Minimum SiYuan version: **3.8.3**. Tested with **3.8.8**, primarily on desktop and desktop browsers. This repository has not yet been submitted to the SiYuan marketplace.

1. Download `package.zip` from the [latest release](https://github.com/dusknobo/PageScape/releases/latest).
2. Extract it into `<workspace>/data/plugins/siyuan-child-cards/`.
3. Check that `plugin.json` and `index.js` are directly inside that folder, then enable **PageScape** in SiYuan.

Disable the plugin before replacing its files when updating. The internal package ID remains **`siyuan-child-cards`** so existing custom blocks, references and legacy storage continue to work. The display name and repository name are PageScape.

## Quick start

| Entry | Action |
| --- | --- |
| `/cards` or `/childcards` | Insert live child-document preview cards |
| `/embedcanvas` or `/inlinecanvas` | Insert or reference an editable canvas at the cursor |
| `/newcanvas` | Create a new canvas document and dedicated tab |
| `/canvas` | Open an existing canvas |

Use the compact toolbar for common actions. **More tools** expands following, layout, attachment, settings and export controls. Current canvas tool labels are primarily Chinese; English slash commands and command-palette entries are available.

Double-click a text card to edit it. In a dedicated Canvas tab, document cards can open a native editor that edits the original document. In an inline canvas, double-clicking a document card opens its source document.

## Storage and scope

- Each canvas is owned by a native SiYuan document. Embed blocks store a reference to that document, rather than another copy of the scene.
- Deleting a reference or removing a card does not delete the source document.
- Canvas documents use SiYuan's configured document history and synchronization. PageScape does not configure a server or enable synchronization itself.
- Search covers card metadata, text notes and loaded document previews, rather than the full text of every referenced document.
- Reverse-reference results cover readable canvases in open notebooks and are separate from SiYuan's native backlink statistics.
- JSON Canvas exchange preserves layout and SiYuan-specific metadata; it does not convert a SiYuan workspace into an Obsidian vault.
- Mobile currently shows summaries. Freehand drawing and live collaborative editing are not included.

See the [detailed Chinese manual](https://github.com/dusknobo/PageScape/blob/main/docs/USAGE.zh-CN.md) for editing, templates, migration and recovery behavior.

## Development

Node.js 22 or newer:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify:package
```

`dist/` contains installable files; `package.zip` is the release archive. Tests, caches, notes, credentials and local runtime state are excluded from the package. See [CONTRIBUTING.md](https://github.com/dusknobo/PageScape/blob/main/CONTRIBUTING.md) for isolated editor tests.

## License

[MIT](https://github.com/dusknobo/PageScape/blob/main/LICENSE).
