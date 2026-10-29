# 页境 · PageScape 0.7.0

让页面展开，让知识相连。

插件 ID、安装目录、源码和发布仓库统一为 `PageScape`。包含集市清单、语言键、预览图，以及旧版插件 ID 迁移工具。

包含正文子页预览卡片、共享正文 Canvas、子页自动跟随、搜索和小地图、分组折叠、树形布局、反向引用、模板、媒体卡片与导入导出。集市上架仍需维护者审核。

## 安装

下载本页的 `package.zip`，解压至思源工作空间 `data/plugins/PageScape/`，在插件设置中启用「页境 · PageScape」。文件夹中应直接包含 `plugin.json` 和 `index.js`。

从 0.6.x 升级：先保存并关闭旧编辑页、停用 `siyuan-child-cards`，再启用 PageScape。运行「迁移旧版插件 ID · Migrate Legacy Plugin ID」，检查数量后点击「备份并迁移」。备份位于 `data/storage/petal/PageScape/plugin-id-backups/`，旧存储原件保留；迁移只更换命名空间，保留块 ID、正文、画布和引用。只检查已打开且未加密的笔记本，其他笔记本可稍后再次迁移。

- `package.zip`：可直接安装的插件文件。
- `SHA256SUMS`：压缩包的 SHA-256 校验值。
- 主要支持桌面端与桌面浏览器，已在思源 3.8.8 验证。

完整说明见仓库 README。
