/**
 * 阮一峰《科技爱好者周刊》(github.com/ruanyf/weekly) 的解析。
 *
 * 为什么单独一个模块：周刊是一份**广度很大**的中文科技摘要，每周五更新，
 * 正文全是 Markdown，条目形如 `1、[标题](链接)` 后跟若干段说明、中间夹配图。
 * 它的价值不在于「又多一个 RSS」，而在于它天然覆盖本站常规订阅之外的题材，
 * 正好让「关键词方向」有东西可挑 —— 所以这里只负责**解析成结构化条目**，
 * 要不要留下、归到哪个主题，交给调用方（collect.mjs）配合 keywordSignals 决定。
 *
 * 纯函数、不联网，方便单测。
 */
import { matchKeywordDirections } from "./content-policy.mjs";
import { candidateId, canonicalUrl, cleanText } from "./runtime.mjs";

const headingPattern = /^##\s+(.+?)\s*$/;
const entryPattern = /^(\d+)\s*[、.．]\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
const imageLinePattern = /^!\[[^\]]*\]\([^)]*\)\s*$/;
const markdownLinkPattern = /\[([^\]]+)\]\([^)]*\)/g;
/** 条目末尾的「（[@someone](...) 投稿）」——对读者没信息量，去掉。 */
const contributionCreditPattern = /（\s*@[^）]{0,60}投稿\s*）/g;
/** 标题后面常跟的「（英文）」这类语种标注，保留；但去掉行尾多余空白。 */
const trailingWhitespacePattern = /\s+$/;

function cleanInline(value) {
  return String(value ?? "")
    .replace(markdownLinkPattern, "$1")
    .replace(contributionCreditPattern, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 从 `docs/issue-413.md` 这类路径取出期号，取不到返回 null。 */
export function weeklyIssueNumber(pathname) {
  const match = /issue-(\d+)\.md$/i.exec(String(pathname ?? ""));
  return match ? Number(match[1]) : null;
}

/**
 * 把一期周刊正文切成「小节 → 条目」。
 *
 * @returns {Array<{section:string, index:number, title:string, url:string, excerpt:string}>}
 */
export function parseWeeklyIssue(markdown, options = {}) {
  const wanted = new Set(options.sections ?? []);
  const maximumExcerpt = Math.max(80, Number(options.maximumExcerptCharacters ?? 400));
  const entries = [];

  let section = "";
  let current = null;
  /** 标题行尾的残余文字，例如「（英文）」这类语种标注。 */
  let inlineTail = "";
  let buffer = [];

  const flush = () => {
    if (!current) return;
    // 标题行尾的标注与后面的说明段要合起来，否则「（英文）」会被说明段顶掉。
    const excerpt = cleanInline([inlineTail, buffer.join(" ")].filter(Boolean).join(" "))
      .slice(0, maximumExcerpt);
    if (excerpt) current.excerpt = excerpt;
    entries.push({ ...current });
    current = null;
    inlineTail = "";
    buffer = [];
  };

  for (const rawLine of String(markdown ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(trailingWhitespacePattern, "");
    const heading = headingPattern.exec(line);
    if (heading) {
      flush();
      section = heading[1].trim();
      continue;
    }
    if (!wanted.has(section)) continue;

    const entry = entryPattern.exec(line);
    if (entry) {
      flush();
      current = {
        section,
        index: Number(entry[1]),
        title: cleanInline(entry[2]),
        url: entry[3],
        excerpt: "",
      };
      inlineTail = cleanInline(line.slice(entry[0].length));
      continue;
    }
    if (!current) continue;
    if (imageLinePattern.test(line)) continue;
    if (!line.trim()) continue;
    buffer.push(line);
  }
  flush();

  return entries;
}

/**
 * 小节 → 本站条目类型的映射。
 * 「工具」直接作为 tool-pick 的候选来源：周刊每周挑的都是真实可用的工具，
 * 比按关键词抓 GitHub 搜索干净得多，正好补上固定栏目的供给。
 */
export const WEEKLY_SECTION_TYPES = {
  科技动态: "news",
  文章: "analysis",
  工具: "tool-pick",
  资源: "release",
};

/**
 * 解析结果 → 候选池条目。
 *
 * 两个取舍写在这里而不是解析器里：
 *   1. `requireKeywordMatch` 默认开 —— 周刊一期几十条链接，题材横跨前端、设计、历史，
 *      不过滤会把常规新闻整批挤掉；只有命中关键词方向的才进来 ——
 *      这就是「关键词决定除了常规新闻还要去找哪些方向」在来源侧的落点。
 *   2. 每节条数上限在**过滤之后**才生效。先截断再过滤会让「排在第 7 位但正好命中方向」
 *      的条目被前面几条不相关的挤掉，那等于白接一个源。
 */
export function weeklyEntriesToCandidates(entries, options = {}) {
  const repo = String(options.repo ?? "").trim();
  const branch = String(options.branch ?? "master").trim();
  const issueNumber = Number(options.issueNumber);
  const directions = options.directions ?? [];
  const requireMatch = options.requireKeywordMatch !== false;
  const fallbackTopic = options.fallbackTopic ?? "engineering";
  const trust = Number(options.trust ?? 0.9);
  const maximumPerSection = Math.max(0, Number(options.maximumItemsPerSection ?? 6));
  const discoveredAt = options.discoveredAt ?? new Date().toISOString();
  const publishedAt = options.publishedAt ?? discoveredAt;
  const issueUrl = `https://github.com/${repo}/blob/${branch}/docs/issue-${issueNumber}.md`;

  const candidates = [];
  const counts = new Map();
  for (const entry of entries ?? []) {
    const typeHint = WEEKLY_SECTION_TYPES[entry.section];
    if (!typeHint) continue;
    const matched = matchKeywordDirections(`${entry.title} ${entry.excerpt}`, directions);
    if (requireMatch && matched.length === 0) continue;
    const accepted = counts.get(entry.section) ?? 0;
    if (accepted >= maximumPerSection) continue;
    counts.set(entry.section, accepted + 1);
    // validate.mjs 要求 tool-pick 必须 evergreen 且带 key；key 含期号，每周都是新 key。
    const evergreen = typeHint === "tool-pick";
    candidates.push({
      id: candidateId(entry.url, `${repo}#${issueNumber}-${entry.index}`),
      title: cleanText(entry.title, 240),
      url: canonicalUrl(entry.url),
      excerpt: cleanText(entry.excerpt, 700),
      publishedAt,
      discoveredAt,
      source: {
        id: "ruanyf-weekly",
        name: "科技爱好者周刊",
        url: issueUrl,
        language: "zh-CN",
        trust,
      },
      topicHint: matched[0]?.topic ?? fallbackTopic,
      laneHint: "focus",
      typeHint,
      ...(evergreen
        ? { evergreen: true, evergreenKey: `tool-pick:weekly-${issueNumber}-${entry.index}` }
        : {}),
      keywordDirections: matched.map((direction) => direction.id),
      discoveredBy: "ruanyf-weekly",
    });
  }
  return candidates;
}
