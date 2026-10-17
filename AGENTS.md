# 观测站 · 工作区

> 工作区级预设，配合全局 `~/.dsh/AGENTS.md` 使用。本文件只约束此工作区。

## 本工作区是什么

**「观测站」**：言志系第 4 个仓库。只放观测站的采集 / 生成 / 发布 / 校验代码与云端心跳。

**数据不在这里。** 配置、运行时数据和公开日报都在 `OBSERVATORY_ROOT` 指向的仓库里（默认同级 `../言志`）。
权威说明见本仓库 `README.md`。

## 硬约束

- **不要在本仓库复制 `config/`、`data/observatory/`、`content/daily/` 或 `lib/timeliness.ts`。**
  它们是言志仓库里的唯一真源。2026-10-08 的候选池判废事故就是副本分叉造成的：
  表现是「显示旧数据」，不是报错，很难定位。
- **不要在脚本里写 `process.cwd()` 或相对上跳定位数据**。一律走 `scripts/observatory/runtime.mjs`
  导出的 `projectRoot` / `repositoryDir` / `observatoryPaths`，这样本机与 CI 的根解析规则一致。
- **不要直接读 `GITHUB_REPOSITORY`** 来决定写哪个仓库。GitHub Actions 会自动把它注入成当前仓库；
  写言志的东西一律用 `OBSERVATORY_GITHUB_REPOSITORY`（见 `sync-candidates.mjs` 的 `targetRepository()`）。
- 改完 `scripts/observatory/` 跑 `npm test`（3 个文件，秒级；需要 `OBSERVATORY_ROOT` 那个仓库在场）。
- 密钥只读 `<OBSERVATORY_ROOT>/.env.local`，永远不提交 `.env.local`。
- 采集与生成真的花钱（模型与搜索按次计费）。验证优先用 `--date=<历史日期>` 或只跑单测，
  不要为了确认能跑通就反复跑完整流水线。
- 执行有风险操作（推送到言志、删数据、改 CI）前先确认。

## 行为准则

- 优先中文。
- 命名：古风雅致、直接明了、不超过四字。
- 代码风格匹配 `scripts/observatory/` 既有写法（`node:` 前缀、`path.join`、显式抛错、注释写「为什么」）。
