import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  candidateId,
  canonicalUrl,
  cleanText,
  dateInTimeZone,
  observatoryPaths,
  projectRoot,
  readConfig,
  readProviderConfig,
} from "../scripts/observatory/runtime.mjs";
import {
  collectEvergreenCatalog,
  countAcronyms,
  matchKeywordDirections,
  matchesBlockedKeywords,
  sourceDiversityReport,
  takeWithSourceCap,
  toolRepositoryRejection,
} from "../scripts/observatory/content-policy.mjs";
import { buildMaterialsFromCandidates } from "../scripts/observatory/distillation.mjs";
import {
  WEEKLY_SECTION_TYPES,
  parseWeeklyIssue,
  weeklyEntriesToCandidates,
  weeklyIssueNumber,
} from "../scripts/observatory/weekly.mjs";
import { validateIssueDocument, validateNewsItem } from "../scripts/observatory/validate.mjs";
import { generateStructured, salvageItemsArray } from "../scripts/observatory/providers.mjs";
import {
  annotateCandidatePool,
  hasConsumedEvergreenConflict,
  rankCandidates,
  readEvergreenHistory,
  requiredDailyTypes,
} from "../scripts/observatory/ranking.mjs";
import {
  buildSearchQuery,
  collectCorroborations,
  isLikelySameEvent,
  parseGoogleNewsFeed,
  selectCorroborationSeeds,
  titleOverlap,
} from "../scripts/observatory/corroboration.mjs";
import { classifySearchFailure, searchStatusReport } from "../scripts/observatory/search-health.mjs";
import { RECENCY, recencyScore, scoreBreakdown, scoreCandidate } from "../scripts/observatory/scoring.mjs";

// 时效标签的判级语义由言志前端的 `lib/timeliness.ts` 定义：观测站写进日报的 level 必须与前端
// 渲染出来的标签是同一套。这里按 projectRoot 载入那份唯一真源，不在本仓库复制第二份
// （2026-10-08 的候选池判废事故正是副本分叉造成的）。该模块只有 type-only import，可被 node 直接载入。
const { getNewsTimeliness } = await import(
  pathToFileURL(path.join(projectRoot, "lib", "timeliness.ts")).href
);

test("formats calendar dates in the configured timezone", () => {
  const instant = new Date("2026-08-29T16:30:00.000Z");
  assert.equal(dateInTimeZone(instant, "Asia/Shanghai"), "2026-08-30");
  assert.equal(dateInTimeZone(instant, "UTC"), "2026-08-29");
});

test("canonical URLs remove tracking parameters and fragments", () => {
  assert.equal(
    canonicalUrl("https://Example.COM/path?utm_source=test&id=42#section"),
    "https://example.com/path?id=42",
  );
});

test("labels timeliness against the issue date instead of the current date", () => {
  assert.equal(getNewsTimeliness("2026-08-30T20:00:00.000Z", "2026-08-31").level, "fresh");
  assert.equal(getNewsTimeliness("2026-08-29T00:00:00.000Z", "2026-08-31").level, "recent");
  assert.equal(getNewsTimeliness("2026-08-25T00:00:00.000Z", "2026-08-31").level, "week");
  assert.equal(getNewsTimeliness("2026-08-01T00:00:00.000Z", "2026-08-31").level, "background");
  assert.equal(getNewsTimeliness("2026-09-01T00:00:00.000Z", "2026-08-31").level, "future");
});

test("today's news outrank week-old news by a wide margin", () => {
  const issueDate = "2026-09-11";
  const today = recencyScore({ publishedAt: "2026-09-11T08:00:00+08:00" }, issueDate);
  const shanghaiMidnight = recencyScore({ publishedAt: "2026-09-10T16:00:00.000Z" }, issueDate);
  const yesterday = recencyScore({ publishedAt: "2026-09-10T20:00:00+08:00" }, issueDate);
  const week = recencyScore({ publishedAt: "2026-09-05T08:00:00+08:00" }, issueDate);
  const evergreen = recencyScore({ evergreen: true, publishedAt: "2026-09-11T08:00:00+08:00" }, issueDate);
  assert.equal(today, RECENCY.today);
  assert.equal(shanghaiMidnight, RECENCY.today);
  assert.equal(yesterday, RECENCY.yesterday);
  assert.equal(week, RECENCY.week);
  assert.equal(evergreen, 0);
  assert.ok(today >= week * 10);
});

test("today recency outweighs a typical topic-weight gap", async () => {
  const config = await readConfig();
  const preferences = { topicAdjustments: {}, sourceTrust: {} };
  const todayGeopolitics = scoreCandidate({
    topicHint: "geopolitics",
    publishedAt: "2026-09-11T08:00:00+08:00",
    source: { trust: 0.9 },
  }, config, preferences, "2026-09-11");
  const weekAi = scoreCandidate({
    topicHint: "ai",
    publishedAt: "2026-09-05T08:00:00+08:00",
    source: { trust: 0.9 },
  }, config, preferences, "2026-09-11");
  assert.ok(todayGeopolitics > weekAi);
});

test("score breakdown exposes numeric sources that sum to the total", async () => {
  const config = await readConfig();
  const preferences = { topicAdjustments: { ai: 1 }, sourceTrust: { openai: "trusted" } };
  const candidate = {
    topicHint: "ai",
    typeHint: "opportunity",
    subtopicHint: "disease-control",
    publishedAt: "2026-09-11T08:00:00+08:00",
    source: { id: "openai", trust: 0.9 },
  };
  const breakdown = scoreBreakdown(candidate, config, preferences, "2026-09-11");
  const summed = breakdown.parts.reduce((total, part) => total + part.points, 0);
  assert.equal(breakdown.total, scoreCandidate(candidate, config, preferences, "2026-09-11"));
  assert.equal(Math.round(summed * 10) / 10, breakdown.total);
  assert.ok(breakdown.parts.some((part) => part.key === "topic" && part.points === 20));
  assert.ok(breakdown.parts.some((part) => part.key === "recency" && part.points === RECENCY.today));
  assert.ok(breakdown.parts.some((part) => part.key === "trusted" && part.points === 12));
});

test("annotated candidate pool ranks by score and marks tonight's shortlist", async () => {
  const config = await readConfig();
  const preferences = { topicAdjustments: {}, sourceTrust: {}, actions: [] };
  const history = { keys: new Set(["ai-tip:used"]) };
  const pool = [
    {
      id: "old-ai",
      title: "一周前的高权重主题",
      excerpt: "旧闻",
      url: "https://a.example/old",
      publishedAt: "2026-09-05T08:00:00+08:00",
      source: { id: "a", trust: 0.9 },
      topicHint: "ai",
      laneHint: "focus",
      typeHint: "news",
    },
    {
      id: "today-world",
      title: "今日国际局势新闻",
      excerpt: "今日见报",
      url: "https://b.example/today",
      publishedAt: "2026-09-12T08:00:00+08:00",
      source: { id: "b", trust: 0.9 },
      topicHint: "geopolitics",
      laneHint: "horizon",
      typeHint: "news",
    },
    {
      id: "tip",
      title: "今天该怎么用模型",
      excerpt: "常青技巧",
      url: "https://c.example/tip",
      publishedAt: "2026-09-12T08:00:00+08:00",
      source: { id: "c", trust: 0.95 },
      topicHint: "ai",
      laneHint: "focus",
      typeHint: "ai-tip",
      evergreen: true,
      evergreenKey: "ai-tip:fresh",
    },
    {
      id: "know",
      title: "上下文窗口不是记忆",
      excerpt: "知本：窗口只约束这一次请求。",
      url: "https://k.example/know",
      publishedAt: "2026-09-12T08:00:00+08:00",
      source: { id: "k", trust: 0.95 },
      topicHint: "ai",
      laneHint: "focus",
      typeHint: "ai-know",
      evergreen: true,
      evergreenKey: "ai-know:fresh",
    },
    {
      id: "tool",
      title: "一个新的本地工具",
      excerpt: "常青工具",
      url: "https://d.example/tool",
      publishedAt: "2026-09-12T08:00:00+08:00",
      source: { id: "d", trust: 0.95 },
      topicHint: "engineering",
      laneHint: "focus",
      typeHint: "tool-pick",
      evergreen: true,
      evergreenKey: "tool-pick:fresh",
    },
    {
      id: "used-tip",
      title: "已经用过的技巧",
      excerpt: "重复常青",
      url: "https://c.example/used",
      publishedAt: "2026-09-12T08:00:00+08:00",
      source: { id: "c", trust: 0.95 },
      topicHint: "ai",
      laneHint: "focus",
      typeHint: "ai-tip",
      evergreen: true,
      evergreenKey: "ai-tip:used",
    },
    {
      id: "focus-today",
      title: "今日工程发布",
      excerpt: "今日见报",
      url: "https://e.example/today",
      publishedAt: "2026-09-12T09:00:00+08:00",
      source: { id: "e", trust: 0.9 },
      topicHint: "engineering",
      laneHint: "focus",
      typeHint: "release",
    },
  ];
  const annotated = annotateCandidatePool(pool, config, preferences, history, "2026-09-12");
  const scores = annotated.items.map((item) => item.score);
  assert.deepEqual(scores, [...scores].sort((left, right) => right - left));
  assert.ok(annotated.items[0].score > annotated.items.at(-1).score);
  assert.equal(annotated.items.find((item) => item.id === "used-tip")?.publishCandidate, false);
  const selected = annotated.items.filter((item) => item.publishCandidate);
  assert.ok(selected.some((item) => item.id === "tip"));
  assert.ok(selected.some((item) => item.id === "know"));
  assert.ok(selected.some((item) => item.id === "tool"));
  assert.ok(selected.some((item) => item.id === "today-world"));
  assert.ok(selected.every((item) => item.publishReason));
  assert.ok(
    annotated.items.find((item) => item.id === "today-world")?.scoreBreakdown
      .some((part) => part.label.includes("今日见报")),
  );
});

test("candidate ids are stable and source-sensitive", () => {
  const first = candidateId("https://example.com/a", "A title");
  assert.equal(first, candidateId("https://example.com/a#fragment", "A title"));
  assert.notEqual(first, candidateId("https://example.com/b", "A title"));
  assert.match(first, /^[a-f0-9]{20}$/);
});

test("feed text cleaning removes executable markup", () => {
  assert.equal(
    cleanText("<p>Hello&nbsp;world</p><script>alert(1)</script>"),
    "Hello world",
  );
});

test("AI 知本 becomes required only from its own start date", async () => {
  const config = await readConfig();
  assert.deepEqual(requiredDailyTypes(config, "2026-09-13"), ["ai-tip", "tool-pick"]);
  assert.deepEqual(requiredDailyTypes(config, "2026-09-14"), ["ai-tip", "ai-know", "tool-pick"]);
});

test("topic weights form a complete profile", async () => {
  const config = await readConfig();
  const sum = Object.values(config.topics).reduce((total, topic) => total + topic.weight, 0);
  assert.equal(sum, 100);
  assert.deepEqual(Object.keys(config.topics), [
    "ai",
    "robotics",
    "postgraduate",
    "internship",
    "engineering",
    "geopolitics",
    "world",
  ]);
  assert.equal(config.topics.geopolitics.label, "国际局势");
  assert.equal(config.topics.geopolitics.weight, 10);
  assert.equal(config.topics.world.weight, 5);
  assert.equal(config.topics.internship.label, "岗位市场");
  assert.doesNotMatch(config.topics.internship.label, /实习/);
});

test("disease control stays pinned and restricted to approved regions", async () => {
  const config = await readConfig();
  assert.equal(config.pinnedSubtopics["disease-control"].parentTopic, "world");
  assert.ok(config.pinnedSubtopics["disease-control"].weightBoost > 0);
  assert.deepEqual(config.healthPolicy.allowedRegions, ["全国", "重庆", "大连", "北京", "广州", "上海", "哈尔滨"]);
  assert.ok(config.healthSources.some((source) => source.region === "全国"));
  assert.ok(config.healthSources.every((source) => config.healthPolicy.allowedRegions.includes(source.region)));
});

test("active providers resolve to declared adapters", async () => {
  const providers = await readProviderConfig();
  assert.ok(providers.llmProviders[providers.activeLlm]);
  assert.ok(providers.searchProviders[providers.activeSearch]);
});

test("sample issue respects identity and source invariants", async () => {
  const issue = JSON.parse(
    await fs.readFile(path.join(observatoryPaths.publicIssues, "2026-08-30.json"), "utf8"),
  );
  const validated = validateIssueDocument(issue, { source: "sample", storage: "public", minimumItems: 6 });
  assert.equal(validated.schemaVersion, 1);
  assert.equal(new Set(validated.items.map((item) => item.id)).size, validated.items.length);
  assert.equal(validated.items.filter((item) => item.featured).length, 1);
  assert.equal(validated.items.find((item) => item.id === "disease-control-surveillance").subtopic, "disease-control");
  assert.ok(validated.items.every((item) => item.sources.length > 0));
  assert.ok(
    validated.items
      .filter((item) => item.reviewStatus === "automated")
      .every((item) => !/[我俺咱]/.test(`${item.reason}${item.question}`)),
  );
});

test("strict issue validation rejects impossible dates and duplicate sources", async () => {
  const issue = JSON.parse(
    await fs.readFile(path.join(observatoryPaths.publicIssues, "2026-08-30.json"), "utf8"),
  );
  const invalidDate = { ...issue, date: "2026-02-31" };
  assert.throws(() => validateIssueDocument(invalidDate, { source: "invalid-date", storage: "public" }));
  const duplicateSource = structuredClone(issue);
  duplicateSource.items[0].sources[1].url = duplicateSource.items[0].sources[0].url;
  assert.throws(() => validateIssueDocument(duplicateSource, { source: "duplicate-source", storage: "public" }));
});

test("evergreen catalog keeps distinct keys even when entries share a source URL", () => {
  const catalog = {
    schemaVersion: 1,
    aiTips: [
      { id: "one", title: "技巧一", excerpt: "说明一", url: "https://example.com/guide", sourceName: "Example" },
      { id: "two", title: "技巧二", excerpt: "说明二", url: "https://example.com/guide", sourceName: "Example" },
    ],
    aiKnows: [
      { id: "know", title: "知本", excerpt: "说明", url: "https://example.com/know", sourceName: "Example" },
    ],
    toolPicks: [
      { id: "tool", title: "工具", excerpt: "说明", url: "https://tools.example.org/tool", sourceName: "Tools" },
    ],
  };
  const items = collectEvergreenCatalog(catalog, "2026-09-08T00:00:00.000Z");
  assert.equal(items.length, 4);
  assert.equal(new Set(items.map((item) => item.evergreenKey)).size, 4);
  assert.deepEqual(items.map((item) => item.typeHint), ["ai-tip", "ai-tip", "ai-know", "tool-pick"]);
});

test("evergreen ranking skips unused keys that reuse a published source URL", async () => {
  const config = await readConfig();
  const preferences = { topicAdjustments: {}, sourceTrust: {}, actions: [] };
  const shared = "https://platform.openai.com/docs/guides/safety-best-practices";
  const history = {
    keys: new Set(["ai-know:human-gate-for-irreversible"]),
    urls: new Set([shared]),
  };
  const pool = [
    {
      id: "shared-url-tip",
      title: "高风险结论设置人工确认点",
      excerpt: "医疗、财务、账号权限和公开发布等任务不能完全自动决定。",
      url: `${shared}?utm_source=retry`,
      publishedAt: "2026-09-17T08:00:00+08:00",
      source: { id: "openai-safety", trust: 0.95, url: shared },
      topicHint: "ai",
      laneHint: "focus",
      typeHint: "ai-tip",
      evergreen: true,
      evergreenKey: "ai-tip:human-review-risk",
    },
    {
      id: "fresh-tip",
      title: "模型输出 JSON 后仍要程序校验",
      excerpt: "JSON 能成功解析不代表内容正确。程序还要检查必填字段、枚举值和数量范围。",
      url: "https://api-docs.deepseek.com/guides/json_mode",
      publishedAt: "2026-09-17T08:00:00+08:00",
      source: { id: "deepseek-json", trust: 0.95 },
      topicHint: "ai",
      laneHint: "focus",
      typeHint: "ai-tip",
      evergreen: true,
      evergreenKey: "ai-tip:validate-model-json",
    },
    {
      id: "fresh-know",
      title: "推理是在用已训练好的模型",
      excerpt: "你每次提问走的是推理：已有权重保持不动，只根据当前输入生成下文。",
      url: "https://developers.google.com/machine-learning/glossary#inference",
      publishedAt: "2026-09-17T08:00:00+08:00",
      source: { id: "google-ml", trust: 0.95 },
      topicHint: "ai",
      laneHint: "focus",
      typeHint: "ai-know",
      evergreen: true,
      evergreenKey: "ai-know:inference-is-not-training",
    },
    {
      id: "fresh-tool",
      title: "一个新的本地工具",
      excerpt: "常青工具推荐条目。",
      url: "https://docs.astral.sh/ruff/",
      publishedAt: "2026-09-17T08:00:00+08:00",
      source: { id: "ruff", trust: 0.95 },
      topicHint: "engineering",
      laneHint: "focus",
      typeHint: "tool-pick",
      evergreen: true,
      evergreenKey: "tool-pick:ruff",
    },
    {
      id: "today-world",
      title: "今日国际局势新闻",
      excerpt: "今日见报",
      url: "https://b.example/today",
      publishedAt: "2026-09-17T08:00:00+08:00",
      source: { id: "b", trust: 0.9 },
      topicHint: "geopolitics",
      laneHint: "horizon",
      typeHint: "news",
    },
    {
      id: "today-eng",
      title: "今日工程发布",
      excerpt: "今日见报",
      url: "https://e.example/today",
      publishedAt: "2026-09-17T09:00:00+08:00",
      source: { id: "e", trust: 0.9 },
      topicHint: "engineering",
      laneHint: "focus",
      typeHint: "release",
    },
    {
      id: "today-ai",
      title: "今日模型发布",
      excerpt: "今日见报",
      url: "https://a.example/today",
      publishedAt: "2026-09-17T09:30:00+08:00",
      source: { id: "a", trust: 0.9 },
      topicHint: "ai",
      laneHint: "focus",
      typeHint: "news",
    },
  ];
  const annotated = annotateCandidatePool(pool, config, preferences, history, "2026-09-17");
  assert.equal(annotated.items.find((item) => item.id === "shared-url-tip")?.publishCandidate, false);
  assert.equal(annotated.items.find((item) => item.id === "fresh-tip")?.publishCandidate, true);
  assert.equal(annotated.items.find((item) => item.id === "fresh-know")?.publishCandidate, true);
  assert.equal(
    hasConsumedEvergreenConflict(
      [{ evergreen: true, evergreenKey: "ai-tip:human-review-risk", sources: [{ url: shared }] }],
      history,
    ),
    true,
  );
});

test("readEvergreenHistory records published evergreen source URLs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "evergreen-history-"));
  try {
    await fs.writeFile(path.join(directory, "2026-09-15.json"), JSON.stringify({
      items: [
        {
          evergreen: true,
          evergreenKey: "ai-know:human-gate-for-irreversible",
          sources: [{ url: "https://platform.openai.com/docs/guides/safety-best-practices?utm_source=x" }],
        },
      ],
    }));
    const history = await readEvergreenHistory(directory);
    assert.equal(history.keys.has("ai-know:human-gate-for-irreversible"), true);
    assert.equal(history.urls.has("https://platform.openai.com/docs/guides/safety-best-practices"), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("source balancing caps candidate concentration and reports issue concentration", () => {
  const candidates = [
    ...Array.from({ length: 4 }, (_, index) => ({ id: `a${index}`, url: `https://a.example/${index}` })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: `b${index}`, url: `https://b.example/${index}` })),
    { id: "c0", url: "https://c.example/0" },
  ];
  const selected = takeWithSourceCap(candidates, 6, 2);
  assert.equal(selected.length, 5);
  assert.equal(selected.filter((item) => item.url.includes("a.example")).length, 2);
  const report = sourceDiversityReport(
    candidates.slice(0, 6).map((candidate) => ({ sources: [{ url: candidate.url, primary: true }] })),
    { maximumPrimarySourceRatio: 0.4, minimumDistinctPrimarySources: 4 },
  );
  assert.ok(report.problems.length >= 1);
  assert.equal(report.largestSource, "a.example");
});

test("current policy rejects application prompts and incomplete market observations", async () => {
  const config = await readConfig();
  const issue = JSON.parse(
    await fs.readFile(path.join(observatoryPaths.publicIssues, "2026-08-30.json"), "utf8"),
  );
  const market = structuredClone(issue.items.find((item) => item.type === "opportunity"));
  market.opportunity.mode = "apply";
  assert.throws(() => validateNewsItem(market, "market", issue.updatedAt, {
    enforceCurrentPolicy: true,
    editorialRules: config.editorialRules,
    healthPolicy: config.healthPolicy,
  }), /observe mode/);
  market.opportunity.mode = "observe";
  market.opportunity.location = "来源未说明";
  market.opportunity.compensation = "来源未说明";
  market.opportunity.responsibilities = ["了解岗位的主要工作"];
  market.opportunity.requirements = ["了解常见技能要求"];
  assert.equal(validateNewsItem(market, "market", issue.updatedAt, {
    enforceCurrentPolicy: true,
    editorialRules: config.editorialRules,
    healthPolicy: config.healthPolicy,
  }).opportunity.mode, "observe");
});

test("current health policy requires approved region, evidence, and actionable advice", async () => {
  const config = await readConfig();
  const issue = JSON.parse(
    await fs.readFile(path.join(observatoryPaths.publicIssues, "2026-08-30.json"), "utf8"),
  );
  const health = structuredClone(issue.items.find((item) => item.subtopic === "disease-control"));
  health.region = "全国";
  health.healthEvidence = "monitoring";
  delete health.healthAdvice;
  assert.throws(() => validateNewsItem(health, "health", issue.updatedAt, {
    enforceCurrentPolicy: true,
    editorialRules: config.editorialRules,
    healthPolicy: config.healthPolicy,
  }), /watch, symptom, and action advice/);
  health.healthAdvice = {
    watchFor: "关注官方监测到的近期呼吸道病原变化。",
    symptoms: "出现发热、咳嗽等症状时，结合接触史考虑呼吸道感染，但不能仅凭症状诊断。",
    action: "先休息并减少接触他人；持续高热、呼吸困难或明显加重时及时就医。",
  };
  assert.equal(validateNewsItem(health, "health", issue.updatedAt, {
    enforceCurrentPolicy: true,
    editorialRules: config.editorialRules,
    healthPolicy: config.healthPolicy,
  }).region, "全国");
  health.region = "成都";
  assert.throws(() => validateNewsItem(health, "health", issue.updatedAt, {
    enforceCurrentPolicy: true,
    editorialRules: config.editorialRules,
    healthPolicy: config.healthPolicy,
  }), /outside the configured scope/);
});

test("plain-language acronym counter limits dense summaries", () => {
  assert.equal(countAcronyms("GPT 与 MCP 可配合使用"), 2);
  assert.equal(countAcronyms("An Alien Mind is an English title"), 0);
  assert.equal(countAcronyms("这句话没有拉丁缩写"), 0);
});

test("GitHub 工具发现挡掉关键词堆砌与政治宣传仓库", async () => {
  const config = await readConfig();
  const settings = config.toolDiscovery;
  // 真实样本：2026-09-27 与 2026-09-30 两期日刊曾把这两个仓库当工具发布出去。
  assert.equal(
    toolRepositoryRejection(
      { name: "china-dictatorship", description: "反中共政治宣传库。Anti Chinese government propaganda." },
      settings,
    ),
    "命中阻断词",
  );
  assert.equal(
    toolRepositoryRejection(
      { name: "china-dictatroship-7", description: "反中共政治宣传库的备份 backup。" },
      settings,
    ),
    "命中阻断词",
  );
  // 描述里全是政治内容、没有任何工具语义的仓库，靠 intent 闸门拦下。
  assert.equal(
    toolRepositoryRejection(
      { name: "OpenPacketFix_", description: "大陆修宪香港恶法台湾武统等都是大策划中共窃国所犯下的滔天罪恶" },
      settings,
    ),
    "不像工具",
  );
  assert.equal(toolRepositoryRejection({ name: "no-description", description: "" }, settings), "缺少仓库描述");
  // 正常工具必须放行 —— 闸门过严会退化成候选枯竭，那是另一种事故。
  assert.equal(
    toolRepositoryRejection({ name: "playwright-mcp", description: "MCP server for browser automation" }, settings),
    null,
  );
  assert.equal(
    toolRepositoryRejection({ name: "wokwi", description: "Online embedded simulator for Arduino and ESP32" }, settings),
    null,
  );
  assert.equal(
    toolRepositoryRejection({ name: "ripgrep", description: "Recursively search directories for a regex pattern" }, null),
    null,
  );
});

test("同一份阻断词清单也用于网页搜索结果", async () => {
  const config = await readConfig();
  const blocked = config.toolDiscovery.blockedKeywords;
  assert.equal(matchesBlockedKeywords("反中共政治宣传库 propaganda 备份", blocked), true);
  assert.equal(matchesBlockedKeywords("cirosantilli/china-dictatroship-7", blocked), true);
  assert.equal(matchesBlockedKeywords("一个用于机器人仿真的开源工具", blocked), false);
  assert.equal(matchesBlockedKeywords("", blocked), false);
  assert.equal(matchesBlockedKeywords("任意文本", []), false);
});

test("工具发现结果会作为 tool 素材进入蒸馏", () => {
  const config = {
    skillDistillation: {
      materialFeedIds: ["github-tool-discovery", "github-changelog"],
      materialsPerFeed: 2,
    },
  };
  const materials = buildMaterialsFromCandidates(
    [
      {
        id: "a",
        title: "playwright-mcp",
        excerpt: "MCP server for browser automation",
        url: "https://github.com/microsoft/playwright-mcp",
        source: { id: "github-tool-discovery", name: "GitHub Repository" },
      },
      {
        id: "b",
        title: "changelog",
        excerpt: "note",
        url: "https://github.blog/changelog/x",
        source: { id: "github-changelog", name: "GitHub Changelog" },
      },
      {
        id: "c",
        title: "other",
        excerpt: "x",
        url: "https://example.com/c",
        source: { id: "unlisted-feed", name: "Other" },
      },
    ],
    config,
  );
  assert.equal(materials.length, 2);
  assert.equal(materials.find((material) => material.id === "a").kind, "tool");
  assert.equal(materials.find((material) => material.id === "b").kind, "feed");
});

test("阮一峰周刊按小节解析成条目，配图与投稿署名被剥掉", () => {
  const markdown = [
    "# 科技爱好者周刊（第 999 期）：示例",
    "",
    "## 封面图",
    "",
    "![](https://cdn.beekka.com/x.webp)",
    "",
    "## 科技动态",
    "",
    "1、[人形机器人学会拧螺丝](https://example.com/robot)",
    "",
    "![](https://cdn.beekka.com/a.webp)",
    "",
    "研究团队让机械臂在不重新训练的情况下适应新工具。",
    "",
    "2、[某某网页模板](https://example.com/html)（英文）",
    "",
    "讲 HTML 模板该怎么写。",
    "",
    "## 工具",
    "",
    "1、[PlotJuggler](https://github.com/facontidavide/PlotJuggler)",
    "",
    "时间序列可视化工具。（[@someone](https://github.com/ruanyf/weekly/issues/1) 投稿）",
  ].join("\n");
  const entries = parseWeeklyIssue(markdown, { sections: ["科技动态", "工具"] });

  assert.equal(entries.length, 3);
  assert.equal(entries[0].section, "科技动态");
  assert.equal(entries[0].index, 1);
  assert.equal(entries[0].title, "人形机器人学会拧螺丝");
  assert.equal(entries[0].url, "https://example.com/robot");
  assert.match(entries[0].excerpt, /机械臂/);
  assert.doesNotMatch(entries[0].excerpt, /beekka/);
  assert.equal(entries[1].title, "某某网页模板");
  assert.match(entries[1].excerpt, /（英文）/);
  assert.equal(entries[2].section, "工具");
  assert.doesNotMatch(entries[2].excerpt, /投稿|@someone/);
  // 未列入配置的小节整段不参与
  assert.equal(entries.some((entry) => entry.section === "封面图"), false);

  assert.equal(weeklyIssueNumber("docs/issue-413.md"), 413);
  assert.equal(weeklyIssueNumber("docs/README.md"), null);
  assert.equal(WEEKLY_SECTION_TYPES["工具"], "tool-pick");
});

test("周刊条目只保留命中关键词方向的部分，并按方向归主题", async () => {
  const config = await readConfig();
  const directions = config.keywordSignals.directions;
  const entries = parseWeeklyIssue(
    [
      "## 科技动态",
      "",
      "1、[人形机器人学会拧螺丝](https://example.com/robot)",
      "",
      "研究团队让机械臂适应新工具。",
      "",
      "2、[某地旅游攻略](https://example.com/travel)",
      "",
      "与本站主题无关的游记。",
      "",
      "## 工具",
      "",
      "1、[某可视化工具](https://example.com/viz)",
      "",
      "一个命令行调试器与格式化工具。",
    ].join("\n"),
    { sections: ["科技动态", "工具"] },
  );
  const candidates = weeklyEntriesToCandidates(entries, {
    repo: "ruanyf/weekly",
    branch: "master",
    issueNumber: 999,
    discoveredAt: "2026-10-02T00:00:00.000Z",
    publishedAt: "2026-10-02T00:00:00.000Z",
    directions,
    requireKeywordMatch: true,
  });

  // 游记不命中任何方向，被挡掉；两条技术条目留下
  assert.equal(candidates.length, 2);
  assert.equal(candidates.some((item) => item.url.includes("travel")), false);
  const robot = candidates.find((item) => item.url.includes("robot"));
  assert.equal(robot.topicHint, "robotics");
  assert.equal(robot.typeHint, "news");
  assert.ok(robot.keywordDirections.includes("embodied-robotics"));
  // 工具小节 → tool-pick，且必须带 evergreen 标记与含期号的唯一 key
  const tool = candidates.find((item) => item.url.includes("viz"));
  assert.equal(tool.typeHint, "tool-pick");
  assert.equal(tool.evergreen, true);
  assert.equal(tool.evergreenKey, "tool-pick:weekly-999-1");
  assert.equal(tool.source.id, "ruanyf-weekly");
});

test("关键词方向既给留存加分，也有上限", async () => {
  const config = await readConfig();
  const directions = config.keywordSignals.directions;
  const matched = matchKeywordDirections("某高校发布 2027 年考研招生简章，机器人工程方向推免名额增加", directions);
  assert.deepEqual(matched.map((entry) => entry.id), ["postgraduate"]);
  assert.equal(matchKeywordDirections("与任何方向都无关的一句话", directions).length, 0);

  const base = {
    topicHint: "postgraduate",
    typeHint: "news",
    source: { trust: 0.5 },
    publishedAt: "2026-10-02T00:00:00Z",
  };
  const hit = scoreBreakdown({ ...base, title: "考研复试经验", excerpt: "初试与复试流程" }, config, {}, "2026-10-02");
  const miss = scoreBreakdown({ ...base, title: "无关标题", excerpt: "无关内容" }, config, {}, "2026-10-02");
  const keywordPart = hit.parts.find((entry) => entry.key === "keywords");

  assert.ok(keywordPart.points > 0);
  assert.ok(keywordPart.points <= config.keywordSignals.maximumMatchBoost);
  assert.equal(hit.total - miss.total, keywordPart.points);
  // 加分仍是「分值」而不是「覆盖」：标题命中按倍数计，但不越过上限
  assert.ok(keywordPart.points < RECENCY.today);
  assert.equal(hit.parts.reduce((sum, entry) => sum + entry.points, 0), hit.total);
});

test("升学方向把保研类候选降权，考研类不受影响", async () => {
  const config = await readConfig();
  const directions = config.keywordSignals.directions;
  // 保研口径的词不再是方向命中词：纯保研内容匹配不到任何方向（周刊筛选据此挡掉它）
  assert.equal(matchKeywordDirections("CS保研DDL：汇总夏令营与预推免截止日期", directions).length, 0);

  const base = {
    topicHint: "postgraduate",
    typeHint: "news",
    source: { trust: 0.5 },
    publishedAt: "2026-10-02T00:00:00Z",
  };
  const kaoyan = scoreBreakdown({ ...base, title: "某校发布考研招生简章", excerpt: "初试科目与复试线调整" }, config, {}, "2026-10-02");
  const baoyan = scoreBreakdown({ ...base, title: "保研经验贴与推免夏令营", excerpt: "预推免截止日期速查" }, config, {}, "2026-10-02");
  const mixed = scoreBreakdown({ ...base, title: "推免比例上升，统考名额缩减", excerpt: "考研统考考生关注" }, config, {}, "2026-10-02");
  const part = (breakdown) => breakdown.parts.find((entry) => entry.key === "keywords");

  assert.equal(part(kaoyan).points, config.keywordSignals.maximumMatchBoost);
  assert.ok(part(baoyan).points < 0);
  assert.ok(part(baoyan).points >= -config.keywordSignals.maximumDemoteBoost);
  assert.match(part(baoyan).label, /降权词/);
  // 同主题、同来源、同时效的三条稿子，只靠关键词分就能把考研与保研分开
  assert.ok(kaoyan.total > mixed.total && mixed.total > baoyan.total);
  // 降权不是硬删：同时讲推免与统考的稿子仍然留在候选池里，只是分数被压低
  assert.match(part(mixed).label, /命中关键词方向.*降权词/);
});

test("truncated model output still yields the complete items", () => {
  const truncated = '{"items":[{"candidateIds":["a"],"title":"甲","summary":"第一条完整内容，含换行\\n与\\"引号\\"。"},{"candidateIds":["b"],"title":"乙","summary":"第二条被截断';
  const salvaged = salvageItemsArray(truncated);
  assert.ok(salvaged);
  assert.equal(salvaged.length, 1);
  assert.equal(salvaged[0].title, "甲");
  // 没有 items 数组时不猜测，交回原有错误路径。
  assert.equal(salvageItemsArray('{"error":"nope"'), null);
  assert.equal(salvageItemsArray("not json at all"), null);
});

test("OpenAI-compatible adapter keeps API keys in headers and reads usage", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-key");
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      assert.equal(parsed.max_tokens, 123);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        choices: [{ message: { content: '{"items":[]}' } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const previousKey = process.env.OBSERVATORY_TEST_API_KEY;
  process.env.OBSERVATORY_TEST_API_KEY = "test-key";
  try {
    const result = await generateStructured({
      activeLlm: "custom",
      llmProviders: {
        custom: {
          label: "Test",
          protocol: "openai-compatible",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          model: "test-model",
          apiKeyEnv: "OBSERVATORY_TEST_API_KEY",
          inputCnyPerMillion: 1,
          outputCnyPerMillion: 2,
        },
      },
    }, [{ role: "user", content: "test" }], 10_000, 123);
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, unmetered: false });
    assert.equal(result.estimatedCny, 0.000025);
  } finally {
    if (previousKey === undefined) delete process.env.OBSERVATORY_TEST_API_KEY;
    else process.env.OBSERVATORY_TEST_API_KEY = previousKey;
    await new Promise((resolve) => server.close(resolve));
  }
});
test("同题判据只认跨站点的同一事件", () => {
  const seed = {
    id: "seed",
    title: "Mistral releases Mistral Large 4 open weight model",
    url: "https://mistral.ai/news/large-4",
  };
  assert.equal(
    isLikelySameEvent(seed, {
      title: "Mistral's Large 4 open-weight model ships",
      url: "https://techcrunch.com/2026/10/06/mistral-large-4",
    }),
    true,
  );
  // 同一家媒体的两条不算交叉核验。
  assert.equal(
    isLikelySameEvent(seed, {
      title: "Mistral releases Mistral Large 4 open weight model",
      url: "https://mistral.ai/news/large-4-cn",
    }),
    false,
  );
  // 实测误判样本：两份不同事的「指南」共享 model/guide，不能算同一事件。
  assert.equal(
    isLikelySameEvent(
      { id: "s", title: "A model guide for the GPT-6 family", url: "https://openai.com/index/gpt-6-guide" },
      { title: "The Ultimate Guide to AI Model Deployment - Anaconda", url: "https://www.anaconda.com/blog/ai-model-deployment" },
    ),
    false,
  );
  // 榜单页与站点首页不是报道。
  assert.equal(
    isLikelySameEvent(seed, { title: "Mistral Large 4 open weight model", url: "https://news.example.com/best-llm-2026" }),
    false,
  );
  assert.equal(
    isLikelySameEvent(seed, { title: "Mistral Large 4 open weight model", url: "https://news.example.com/" }),
    false,
  );
  // 中文标题走两字切片。
  assert.equal(
    isLikelySameEvent(
      { id: "z", title: "百万年薪抢人，机器人人才挑战来了", url: "https://www.stcn.com/article/detail/123.html" },
      { title: "百万年薪抢人，机器人人才挑战来了！哪些岗位最热门？", url: "https://m.voc.com.cn/x/123" },
    ),
    true,
  );
  // 相似度与共享词都返回，便于在上层调门槛。
  const overlap = titleOverlap("Mistral Large 4 open weight model", "Mistral Large 4 open-weight model ships");
  assert.ok(overlap.shared >= 4);
  assert.ok(overlap.score > 0.5);
});

test("检索词按标题语种构造", () => {
  assert.deepEqual(
    buildSearchQuery({ title: "百万年薪抢人，机器人人才挑战来了" }),
    { language: "zh", query: "百万年薪抢人，机器人人才挑战来了" },
  );
  const english = buildSearchQuery({ title: "Mistral releases Mistral Large 4 open weight model" });
  assert.equal(english.language, "en");
  assert.match(english.query, /^mistral/);
  // 停用词不参与检索：用它们做交集只会把不相关页面捞回来。
  assert.ok(!/releases/.test(english.query));
});

test("Google 新闻 RSS 只留下能定位到媒体原文的条目", () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>百万年薪抢人，机器人人才挑战来了 - 证券时报</title>
    <link>https://news.google.com/rss/articles/CBMiabc?oc=5</link>
    <description>&lt;a href="https://www.stcn.com/article/detail/123.html"&gt;百万年薪抢人&lt;/a&gt;&amp;nbsp;&lt;font color="#6f6f6f"&gt;证券时报&lt;/font&gt;</description>
    <pubDate>Mon, 06 Oct 2026 10:00:00 GMT</pubDate>
    <source url="https://www.stcn.com">证券时报</source></item>
  <item><title>只有标题的条目</title>
    <link>https://news.google.com/rss/articles/CBMixyz?oc=5</link>
    <description>没有原文链接</description>
    <source url="https://example.com">Example</source></item>
  </channel></rss>`;
  const entries = parseGoogleNewsFeed(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, "https://www.stcn.com/article/detail/123.html");
  assert.equal(entries[0].sourceName, "证券时报");
  assert.equal(entries[0].publishedAt, "2026-10-06T10:00:00.000Z");
  // 摘要里不能残留转义后的 HTML 源码。
  assert.ok(!/&lt;|href=/.test(entries[0].excerpt));
});

test("同题反查命中挂到种子上，且不单独占候选席位", async () => {
  const hits = [
    {
      title: "Mistral's Large 4 open-weight model ships",
      url: "https://techcrunch.com/2026/10/06/mistral-large-4",
      created_at: "2026-10-06T09:00:00.000Z",
      points: 120,
    },
    // 同一站点：不算交叉核验。
    {
      title: "Mistral's Large 4 open-weight model ships again",
      url: "https://mistral.ai/news/large-4-cn",
      created_at: "2026-10-06T09:05:00.000Z",
      points: 4,
    },
    // 榜单页：话题相近但不是同一事件。
    {
      title: "The best open source LLM guide 2026",
      url: "https://list.example/best-llm",
      created_at: "2026-10-06T08:00:00.000Z",
      points: 3,
    },
  ];
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ hits }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const config = await readConfig();
  config.corroboration = {
    ...config.corroboration,
    channels: {
      ...config.corroboration.channels,
      hackernews: {
        ...config.corroboration.channels.hackernews,
        endpoint: `http://127.0.0.1:${port}/api/v1/search`,
      },
      // 测试里只走本地桩：免密钥通道不外呼，付费通道也不许开。
      googlenews: { ...config.corroboration.channels.googlenews, enabled: false },
      brave: { ...config.corroboration.channels.brave, enabled: false },
    },
  };
  const pool = [
    {
      id: "seed",
      title: "Mistral releases Mistral Large 4 open weight model",
      excerpt: "官方发布",
      url: "https://mistral.ai/news/large-4",
      publishedAt: "2026-10-06T08:00:00.000Z",
      source: { id: "mistral", trust: 0.9 },
      topicHint: "ai",
      laneHint: "focus",
      typeHint: "release",
    },
    {
      id: "other",
      title: "GitHub Actions 支持 Ubuntu 26",
      excerpt: "同日工程变更",
      url: "https://github.blog/changelog/ubuntu-26",
      publishedAt: "2026-10-06T08:10:00.000Z",
      source: { id: "github-changelog", trust: 0.9 },
      topicHint: "engineering",
      laneHint: "focus",
      typeHint: "release",
    },
  ];
  const preferences = { topicAdjustments: {}, sourceTrust: {}, trackedQuestions: [], actions: [] };
  const history = { keys: new Set(), urls: new Set() };
  try {
    // 种子现在直接来自短名单，不再由反查自己去猜谁会入选（2026-10-19 改动）。
    const seeds = selectCorroborationSeeds(pool, config);
    assert.equal(seeds.length, 2);
    const { matches, stats } = await collectCorroborations({
      seeds,
      config,
      providerConfig: { activeSearch: "off", searchProviders: { off: { baseUrl: "", apiKeyEnv: "" } } },
      discoveredAt: "2026-10-06T12:00:00.000Z",
      knownUrls: pool.map((candidate) => candidate.url),
    });
    assert.equal(matches.length, 1);
    // 通道计数要能说清「问了几次、跳过几次、取回几条、命中几条」——0 命中时靠它分辨原因。
    assert.equal(stats.channels.hackernews.queries, 2);
    assert.equal(stats.channels.hackernews.skipped, 0);
    assert.equal(stats.channels.hackernews.results, 6);
    assert.equal(stats.channels.hackernews.matched, 1);
    assert.equal(stats.channels.hackernews.failures, 0);
    assert.equal(stats.channels.googlenews, undefined);
    assert.equal(matches[0].corroboratesSeed, "seed");
    assert.equal(matches[0].discoveredBy, "corroboration-hackernews");
    assert.equal(matches[0].source.id, "web-techcrunch.com");
    assert.equal(matches[0].source.trust, 0.6);
    // 佐证候选继承种子的主题与分线，否则它会跑进别的栏目。
    assert.equal(matches[0].topicHint, "ai");
    assert.equal(matches[0].laneHint, "focus");
    // 佐证候选不能自己占一个候选席位。
    const ranked = rankCandidates([...pool, ...matches], config, preferences, history, "2026-10-06");
    assert.ok(ranked.length > 0);
    assert.ok(!ranked.some((candidate) => candidate.corroboratesSeed));
    assert.ok(ranked.some((candidate) => candidate.id === "seed"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("反查种子取自最终短名单，同主题最多两条且不重复", async () => {
  /*
   * 2026-10-19 把反查从 collect 挪到 generate 之后，种子就是 selectCandidates() 的产物。
   * 这条用例钉住四件事：① 顺序＝短名单顺序，不再自己重排；② 常青栏目、过短标题、
   * 榜单页不上场；③ 同主题默认最多 2 条，避免同题集中的一天被一个主题吃光额度；
   * ④ 每一轮不会把上一轮取过的种子再取一遍（perTopicCap≥2 时才会暴露的重复 bug）。
   */
  const config = await readConfig();
  config.corroboration = {
    ...config.corroboration,
    enabled: true,
    maximumSeeds: 5,
    maximumSeedsPerTopic: 2,
    minimumTitleCharacters: 12,
  };
  const make = (id, topicHint, title, url, extra = {}) => ({
    id,
    topicHint,
    title,
    url,
    excerpt: "摘要",
    publishedAt: "2026-10-18T08:00:00.000Z",
    source: { id: `src-${id}`, trust: 0.8 },
    laneHint: "focus",
    typeHint: "news",
    ...extra,
  });
  const shortlist = [
    make("pg1", "postgraduate", "中科院自动化所硕士统考复试与录取口径", "https://ia.cas.cn/a"),
    make("pg2", "postgraduate", "中国科学技术大学自动化系硕士招生简章", "https://auto.ustc.edu.cn/b"),
    make("pg3", "postgraduate", "清华大学自动化系硕士研究生招生目录", "https://tsinghua.edu.cn/c"),
    make("ai1", "ai", "微软首席执行官谈让视窗系统更安全地运行智能体", "https://techmeme.com/d"),
    make("ai2", "ai", "从候选里挑推理句子：受限模型少走弯路", "https://machinelearning.apple.com/e", { evergreen: true }),
    make("short", "ai", "短标题", "https://example.com/f"),
    make("list", "world", "全球机器人公司榜单", "https://example.com/best-robots"),
  ];
  const seeds = selectCorroborationSeeds(shortlist, config);
  assert.deepEqual(seeds.map((seed) => seed.id), ["pg1", "ai1", "pg2"]);
  assert.equal(new Set(seeds).size, seeds.length);
  // 关掉 corroboration 就一条都不查。
  assert.deepEqual(
    selectCorroborationSeeds(shortlist, { ...config, corroboration: { ...config.corroboration, enabled: false } }),
    [],
  );
});

test("DeepSeek 复核通道：POST + Bearer、只认 results[]、空手而归不计费", async () => {
  /*
   * 2026-10-17 加：分工定为「Brave 发现、DeepSeek 复核」。
   * 这条用例盯三件事：① 必须走 POST + Bearer（不是 Brave 的 GET + X-Subscription-Token）；
   * ② 响应体只有 results[]，字段名是 summary / site_name / authority / rerank_score / date；
   * ③ 计费口径「有结果才计一次成功请求」——空手而归记 0 元。
   */
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        auth: request.headers.authorization,
        body,
      });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        results: [
          {
            title: "Mistral ships the Large 4 open-weight model",
            url: "https://news.example.com/mistral-large-4",
            site_name: "Example News",
            summary: "第二家媒体对同一次发布的报道。",
            authority: 3,
            rerank_score: 1.8,
            date: "2026-10-06T09:00:00.000Z",
          },
          // 缺 url 的条目必须被丢掉，不能进池。
          { title: "缺少链接的条目", site_name: "Example" },
        ],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  // 账本指向临时目录：这条用例会真的走 reserve/settle，不能写进仓库里的月度账本。
  const originalUsageDir = observatoryPaths.usage;
  const usageDir = await fs.mkdtemp(path.join(os.tmpdir(), "obs-usage-"));
  observatoryPaths.usage = usageDir;
  process.env.OBSERVATORY_TEST_DEEPSEEK_KEY = "test-key";
  const seed = {
    id: "seed",
    title: "Mistral releases Mistral Large 4 open weight model",
    excerpt: "官方发布",
    url: "https://mistral.ai/news/large-4",
    publishedAt: "2026-10-06T08:00:00.000Z",
    source: { id: "mistral", trust: 0.9 },
    topicHint: "ai",
    laneHint: "focus",
    typeHint: "release",
  };
  try {
    const config = await readConfig();
    config.corroboration = {
      ...config.corroboration,
      channels: {
        ...config.corroboration.channels,
        // 只留 DeepSeek 这一条付费/外呼通道，其余全关，免得出网。
        hackernews: { ...config.corroboration.channels.hackernews, enabled: false },
        googlenews: { ...config.corroboration.channels.googlenews, enabled: false },
        brave: { ...config.corroboration.channels.brave, enabled: false },
        deepseek: { ...config.corroboration.channels.deepseek, enabled: true, perPage: 5 },
      },
    };
    const { matches, stats } = await collectCorroborations({
      seeds: [seed],
      config,
      providerConfig: {
        activeSearch: "off",
        searchProviders: {
          off: { baseUrl: "", apiKeyEnv: "" },
          deepseek: {
            label: "DeepSeek Search",
            protocol: "deepseek",
            baseUrl: `http://127.0.0.1:${port}/v1/tools/search`,
            apiKeyEnv: "OBSERVATORY_TEST_DEEPSEEK_KEY",
            cnyPerThousand: 5,
          },
        },
      },
      discoveredAt: "2026-10-06T12:00:00.000Z",
      knownUrls: [seed.url],
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].auth, "Bearer test-key");
    // 英文标题按 buildSearchQuery 取开头两个特征词，不是整句。
    assert.equal(JSON.parse(requests[0].body).query, buildSearchQuery(seed).query);
    assert.equal(JSON.parse(requests[0].body).count, 5);
    assert.equal(stats.channels.deepseek.queries, 1);
    assert.equal(stats.channels.deepseek.results, 1);
    assert.equal(stats.channels.deepseek.matched, 1);
    assert.equal(matches[0].discoveredBy, "corroboration-deepseek");
    assert.equal(matches[0].source.name, "Example News");
    assert.equal(matches[0].publishedAt, "2026-10-06T09:00:00.000Z");
    // 有结果 = 一次成功请求 × 5 元 / 1000。
    const [ledgerFile] = await fs.readdir(usageDir);
    const ledger = JSON.parse(await fs.readFile(path.join(usageDir, ledgerFile), "utf8"));
    const events = ledger.events.filter((event) => event.provider === "deepseek");
    assert.equal(events.length, 1);
    assert.equal(events[0].estimatedCny, 0.005);
    assert.equal(ledger.reservedTotalCny, 0);
  } finally {
    observatoryPaths.usage = originalUsageDir;
    delete process.env.OBSERVATORY_TEST_DEEPSEEK_KEY;
    await fs.rm(usageDir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("中文种子在 Hacker News 上计为「跳过」而不是「查询过」", async () => {
  /*
   * 云端首跑时统计里 hackernews 是「查询 5 / 取回 0」，看起来像通道没结果，
   * 实际是中文标题根本不适用该通道。两者在统计里必须分开，否则诊断会走错方向。
   * 这里不发任何请求，所以不需要桩服务器。
   */
  const config = await readConfig();
  config.corroboration = {
    ...config.corroboration,
    channels: {
      ...config.corroboration.channels,
      googlenews: { ...config.corroboration.channels.googlenews, enabled: false },
      brave: { ...config.corroboration.channels.brave, enabled: false },
    },
  };
  const seeds = [
    {
      id: "zh-seed",
      title: "百万年薪抢人，机器人人才挑战来了",
      excerpt: "岗位观察",
      url: "https://www.stcn.com/article/detail/123.html",
      publishedAt: "2026-10-06T08:00:00.000Z",
      source: { id: "web-stcn.com", trust: 0.55 },
      topicHint: "internship",
      laneHint: "focus",
      typeHint: "opportunity",
    },
  ];
  const { matches, stats } = await collectCorroborations({
    seeds,
    config,
    providerConfig: { activeSearch: "off", searchProviders: { off: { baseUrl: "", apiKeyEnv: "" } } },
    discoveredAt: "2026-10-06T12:00:00.000Z",
    knownUrls: [],
  });
  assert.equal(matches.length, 0);
  assert.equal(stats.channels.hackernews.queries, 0);
  assert.equal(stats.channels.hackernews.skipped, 1);
  assert.equal(stats.channels.hackernews.results, 0);
});

test("搜索失败分三类：额度、限流、其它", () => {
  // 额度用尽时正文常常不是 JSON，所以判据不能只看状态码。
  assert.equal(classifySearchFailure(402, ""), "quota");
  assert.equal(classifySearchFailure(429, '{"error":"You have exceeded your monthly quota"}'), "quota");
  assert.equal(classifySearchFailure(403, "Plan limit reached"), "quota");
  // 每秒 1 次的限流是暂时性的，和额度不是一回事。
  assert.equal(classifySearchFailure(429, "Too Many Requests"), "rate-limit");
  assert.equal(classifySearchFailure(401, "invalid token"), "unauthorized");
  assert.equal(classifySearchFailure(500, "server error"), "other");
});

test("搜索健康度把额度耗尽报成需要告警", () => {
  const rejected = searchStatusReport({
    date: "2026-10-06",
    stats: { searchEnabled: true, searchRequests: 6, searchAdded: 0, searchFailures: 6, searchRejected: 6 },
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /额度/);
  // 关闭搜索（无密钥或主动关闭）不是故障，不该开告警。
  assert.equal(searchStatusReport({ stats: { searchEnabled: false } }).ok, true);
  // 失败一条不影响整体，不告警。
  assert.equal(
    searchStatusReport({
      stats: { searchEnabled: true, searchRequests: 6, searchAdded: 40, searchFailures: 1, searchRejected: 0 },
    }).ok,
    true,
  );
  // 全部失败但不是额度原因（例如密钥被停用）同样要报。
  const broken = searchStatusReport({
    stats: { searchEnabled: true, searchRequests: 6, searchAdded: 0, searchFailures: 6, searchRejected: 0 },
  });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /搜索全部失败/);
  // 没有候选池文件时按「没发出请求」处理。
  assert.equal(searchStatusReport(null).ok, true);
});
