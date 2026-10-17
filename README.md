# 观测站 · 流水线

言志系第 4 个仓库。这里只放观测站的**采集 / 生成 / 发布 / 校验**代码与云端心跳。

配置、运行时数据和公开日报**不在本仓库**，在 `OBSERVATORY_ROOT` 指向的仓库里（默认同级 `../言志`）。

## 为什么拆出来

拆分前这些脚本住在言志仓库，每次心跳都要 checkout 整个博客、装全站依赖、跑全站的 test/typecheck/build。
拆开后观测站只装自己的三个依赖（cheerio / dotenv / fast-xml-parser），言志仓库也不必再为观测站背 CI 与 secrets。

**刻意没有复制任何数据。** `config/observatory*.json`、`data/observatory/`、`content/daily/` 仍然全世界只有一份，
就在言志仓库。理由是 2026-10-08 那次事故：控台曾经冻结过一份 `scripts/observatory/` 副本，言志后来给候选的
`stats` 加了 `corroborationChannels` 字段，控台那份旧解析器把整份 300 条快照判废、页面回落到三天前的数据，
表现是「显示旧数据」而不是报错。结论写在这里：**共享语义的脚本只能有一个真源。**

## 数据在哪

| 内容 | 位置 |
|---|---|
| 代码 | 本仓库 `scripts/observatory/`、`workers/` |
| 配置 | `<OBSERVATORY_ROOT>/config/observatory{,.providers,.evergreen}.json` |
| 候选 / 预览 / 用量（运行时） | `<OBSERVATORY_ROOT>/data/observatory/` |
| 公开日报（进 git） | `<OBSERVATORY_ROOT>/content/daily/` |
| 密钥 | `<OBSERVATORY_ROOT>/.env.local` |
| 时效判级语义（与前端共享） | `<OBSERVATORY_ROOT>/lib/timeliness.ts` |

`OBSERVATORY_ROOT` 的解析顺序（见 `scripts/observatory/runtime.mjs` 顶部）：

1. 真实环境变量 `OBSERVATORY_ROOT`
2. 本仓库 `.env.local` 里的 `OBSERVATORY_ROOT`
3. 都没有 ⇒ 本仓库根（此时 `config/`、`data/`、`content/daily/` 必须在本仓库里）

相对路径按**本仓库根**解析而不是 cwd，所以 `../言志` 在本机和 CI 里含义一致。

## 本机运行

```powershell
cd "C:\Users\houdezaiwu\Desktop\言志工坊\观测站"
npm install
Copy-Item .env.example .env.local      # 里面已写好 OBSERVATORY_ROOT=../言志

npm run observatory:collect -- --date=2026-10-18
npm run observatory:generate -- --stage=final --date=2026-10-18
npm run observatory:verify
npm test
```

采集与生成会真的调用模型和搜索（按次计费），验证时优先用历史日期或只跑 `npm test`。

## 云端

`.github/workflows/observatory.yml` 每次心跳做四件事：

1. checkout 本仓库（代码）
2. checkout 言志仓库到 `yanzhi/`（数据真源），并把 `OBSERVATORY_ROOT` 指向它
3. 按心跳窗口决定采集 / 发布 / 空转，跑流水线与校验
4. 把 `content/daily/` 用 `git -C yanzhi` 提交推回言志

提交后 Cloudflare Workers Builds 检测到言志 `main` 更新，自动重建静态站 —— 与拆分前是同一条上线链路。

### 需要在本仓库配置的 secrets

GitHub 的 secrets 不能跨仓库读，所以下列密钥要在**本仓库**的 Repository secrets 里再配一份
（值抄自言志仓库现有配置）：

| Secret | 用途 |
|---|---|
| `YANZHI_PUSH_TOKEN` | 对言志仓库有 `contents: write`；用于 checkout 言志、推送 `content/daily/`、写候选快照分支、读发布状态 |
| `DEEPSEEK_API_KEY` | 生成模型（当前 activeLlm） |
| `DEEPSEEK_SEARCH_API_KEY` | 搜索通道（当前 activeSearch，2026-10-17 起） |
| `BRAVE_SEARCH_API_KEY` | 搜索通道（备用） |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` / `OBSERVATORY_CUSTOM_API_KEY` | 可选，切提供商时才需要 |

失败告警 issue 会开在**本仓库**（`notify-failure` job），搜索额度告警同理。

## 心跳兜底

`workers/observatory-heartbeat.mjs` 是独立的 Cloudflare Worker：GitHub 的 `schedule` 会延迟甚至整次丢弃，
它按 cron 兜底触发本仓库的 workflow。

```powershell
npm run heartbeat:deploy
```

它读两个 Cloudflare 变量：

- `GH_REPOSITORY` —— 改成 `wings-of-liberty-zdy/观测站仓库名`
- `GH_DISPATCH_TOKEN` —— GitHub 细粒度令牌，`Actions: Read and write`，只授本仓库

拆分后这两个变量必须改指向，否则兜底会继续去触发言志仓库那个已被删除的 workflow。

## 回退

第一步拆分（2026-10-17）不改任何数据格式，也不改言志前端与控台：

- 回到拆分前的代码布局：在**言志仓库** `git revert` 对应提交，脚本、workflow、`package.json` 的
  `observatory:*` 脚本与两个依赖会一起回来。
- 本仓库是纯新增，删掉目录即卸载。

## 与其它三个仓库的关系

| 仓库 | 负责 |
|---|---|
| 言志 | 公开站（含观测站页面 `/daily/`）、数据真源、`content/daily/` 的宿主 |
| **观测站（本仓库）** | 采集 / 生成 / 发布 / 校验流水线、心跳 Worker |
| 控台 | 本地审阅后台（观测站 Studio 前端 + 4318 API），经 `YANZHI_ROOT` 读写言志的数据根 |
| 器录 | 与观测站无关 |
