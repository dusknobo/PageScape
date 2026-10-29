# 开发与贡献

## 项目结构

```text
src/                 插件入口与正文子页卡片
src/canvas/          画布视图、模型、保存、引用、模板和导航
i18n/                命令名称
scripts/             构建、校验、安装、迁移及示例生成
tests/               数据模型与隔离编辑器测试
docs/                使用说明、演示图片及发布说明
```

Node.js 22+：

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify:package
```

单元测试可在 Windows、Linux 和 macOS 运行，不访问个人笔记。CI 在 Node.js 22 和 24 上执行类型检查、单元测试与打包校验。

## 编辑器集成测试

当前主要在 Windows、Microsoft Edge 和思源 3.8.8 验证。集成测试要求端口 `6807` 对应本项目 `.test-workspace`；每个测试会先核对工作空间路径，拒绝写入其他目录。

1. 创建 `.test-workspace`、`.test-home` 和 `.qa` 目录。
2. 使用思源内核 `serve` 启动该工作空间，端口 `6807`，测试授权码为 `child-cards-isolated-test`；`--home-dir` 使用 `.test-home`，`--wd` 指向思源安装的 `resources` 目录。
3. 构建后运行相应测试。

```sh
npm run build
npm run test:canvas-documents
npm run test:canvas-safety
npm run test:canvas-inline
npm run test:canvas-features
npm run test:canvas-parity
```

`test:canvas-safety` 使用 `test:canvas-documents` 生成的隔离测试夹具。测试截图和记录放在 `.qa/`，不提交到仓库。

## 修改与发布

- 保持内部 ID `siyuan-child-cards`，更改显示名称时不要更换旧文档使用的命名空间。
- 保存和导入失败应保留原内容；不要用空场景修复损坏的持久化数据。
- 自定义块中不嵌套 Protyle；文档原文编辑保留在独立 Canvas 中。
- 新增持久化字段时同步维护模型校验、JSON Canvas 交换和必要测试。
- 发布时更新 `plugin.json`、`package.json`、锁文件和更新记录，并创建与版本一致的 `vX.Y.Z` 标签。

### 主仓库与集市发布仓库

主仓库为 `dusknobo/PageScape`，集市从 `dusknobo/siyuan-child-cards` 的 Latest Release 获取安装包。两边使用同一提交和标签；`plugin.json.url` 指向集市发布仓库，以符合清单规则并保留原有插件 ID。

首次配置发布远端：

```sh
git remote add bazaar https://github.com/dusknobo/siyuan-child-cards.git
```

每次发布，将经过验证的 `main` 和同一个版本标签推送到两个远端。两边的发布工作流都会重新检查并生成 `package.zip`；必须确认集市发布仓库也有成功的 Release 才算完成更新。不要只更新主仓库的 Release。

## 界面示例

```sh
npm run docs:screenshot
```

该命令使用真实画布视图组件与专门编写的演示内容生成 `docs/images/overview.png` 和集市用的 `preview.png`，需要本机 Microsoft Edge。它不会连接思源内核或读取用户笔记。
