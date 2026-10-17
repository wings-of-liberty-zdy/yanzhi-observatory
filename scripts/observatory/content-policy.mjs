import {
  candidateId,
  canonicalUrl,
  cleanText,
  strictHttpUrl,
} from "./runtime.mjs";

const acronymPattern = /\b(?:[A-Z]{2,}[A-Z0-9.+-]*|[A-Z][a-z0-9.+-]*[A-Z][A-Za-z0-9.+-]*)\b/g;

function sourceIdentity(url, fallback = "unknown") {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const parts = hostname.split(".");
    if (parts.length <= 2) return hostname;
    const compoundSuffixes = new Set(["com.cn", "org.cn", "gov.cn", "com.hk", "co.uk", "org.uk"]);
    const suffix = parts.slice(-2).join(".");
    return compoundSuffixes.has(suffix) ? parts.slice(-3).join(".") : suffix;
  } catch {
    return String(fallback || "unknown").toLowerCase();
  }
}

function validateEvergreenEntry(entry, type, index) {
  if (!entry || typeof entry !== "object") {
    throw new Error(`${type}[${index}] must be an object.`);
  }
  for (const field of ["id", "title", "excerpt", "url", "sourceName"]) {
    if (typeof entry[field] !== "string" || !entry[field].trim()) {
      throw new Error(`${type}[${index}].${field} must be a non-empty string.`);
    }
  }
  strictHttpUrl(entry.url, { allowHttp: true });
}

function collectEvergreenEntries(entries, type, discoveredAt) {
  return entries.map((entry, index) => {
    validateEvergreenEntry(entry, type, index);
    return {
      id: candidateId(entry.url, `${type}:${entry.id}`),
      title: cleanText(entry.title, 240),
      url: canonicalUrl(entry.url),
      excerpt: cleanText(entry.excerpt, 700),
      publishedAt: discoveredAt,
      discoveredAt,
      source: {
        id: `${type}-${entry.id}`,
        name: cleanText(entry.sourceName, 180),
        url: entry.url,
        language: "zh-CN",
        trust: 0.95,
      },
      topicHint: type === "tool-pick" ? "engineering" : "ai",
      laneHint: "focus",
      typeHint: type,
      evergreen: true,
      evergreenKey: `${type}:${entry.id}`,
      discoveredBy: "curated-evergreen-catalog",
    };
  });
}

export function collectEvergreenCatalog(catalog, discoveredAt) {
  if (
    catalog?.schemaVersion !== 1 ||
    !Array.isArray(catalog.aiTips) ||
    !Array.isArray(catalog.aiKnows) ||
    !Array.isArray(catalog.toolPicks)
  ) {
    throw new Error("Evergreen catalog is invalid.");
  }
  return [
    ...collectEvergreenEntries(catalog.aiTips, "ai-tip", discoveredAt),
    ...collectEvergreenEntries(catalog.aiKnows, "ai-know", discoveredAt),
    ...collectEvergreenEntries(catalog.toolPicks, "tool-pick", discoveredAt),
  ];
}

export function candidateSourceIdentity(candidate) {
  return sourceIdentity(candidate?.url, candidate?.source?.id);
}

export function itemPrimarySourceIdentity(item) {
  const primary = item?.sources?.find((source) => source.primary) ?? item?.sources?.[0];
  return sourceIdentity(primary?.url, primary?.sourceKey ?? primary?.id);
}

export function takeWithSourceCap(entries, limit, maximumPerSource, initialEntries = []) {
  const target = Math.max(0, Number(limit) || 0);
  const cap = Math.max(1, Number(maximumPerSource) || 1);
  const counts = new Map();
  for (const entry of initialEntries) {
    const key = candidateSourceIdentity(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const selected = [];
  for (const entry of entries) {
    if (selected.length >= target) break;
    const key = candidateSourceIdentity(entry);
    if ((counts.get(key) ?? 0) >= cap) continue;
    selected.push(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return selected;
}

export function sourceDiversityReport(items, rules = {}) {
  const total = items.length;
  const ratio = Number(rules.maximumPrimarySourceRatio ?? 1);
  const minimumDistinct = Math.max(1, Number(rules.minimumDistinctPrimarySources ?? 1));
  const counts = new Map();
  for (const item of items) {
    const key = itemPrimarySourceIdentity(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const [largestSource = "none", largestCount = 0] = sorted[0] ?? [];
  const maximumAllowed = total === 0 ? 0 : Math.max(1, Math.floor(total * ratio));
  const requiredDistinct = Math.min(total, minimumDistinct);
  const problems = [];
  if (largestCount > maximumAllowed) {
    problems.push(`${largestSource} provides ${largestCount}/${total} primary items; maximum is ${maximumAllowed}/${total}.`);
  }
  if (counts.size < requiredDistinct) {
    problems.push(`only ${counts.size} distinct primary sources are present; at least ${requiredDistinct} are required.`);
  }
  return {
    total,
    distinct: counts.size,
    largestSource,
    largestCount,
    maximumAllowed,
    problems,
  };
}

export function countAcronyms(value) {
  return String(value ?? "").match(acronymPattern)?.length ?? 0;
}

/**
 * 阻断词命中判定。同一份清单同时用于两处入口把关：
 * GitHub 工具发现（关键词堆砌 / 政治宣传仓库）与网页搜索结果（SEO 垃圾与同类内容）。
 * 清单存在 config.toolDiscovery.blockedKeywords —— 名字带着 toolDiscovery，
 * 但它实际是「站点级内容危害词」，两处共用一份，避免各写各的。
 */
export function matchesBlockedKeywords(text, keywords) {
  const haystack = String(text ?? "").toLowerCase();
  if (!haystack) return false;
  return (keywords ?? []).some((entry) => {
    const needle = String(entry ?? "").trim().toLowerCase();
    return Boolean(needle) && haystack.includes(needle);
  });
}

/**
 * 关键词系统：把候选文本与配置里的「方向」做一次朴素子串匹配。
 *
 * 一份判定、两个用途：
 *   1. 排序加权 —— 命中的候选更容易被留下（scoring.mjs）；
 *   2. 采集方向 —— 广谱来源（阮一峰周刊）里只保留命中方向的内容（collect.mjs），
 *      方向自带的 searchQuery 也会并入搜索轮换，决定「除了常规新闻还要去找哪些方向」。
 *
 * 用子串而不是分词：中文没有词边界，配置里写的都是完整词，误伤面小、行为可预测。
 * 返回命中的方向与具体命中的关键词，便于在候选项里显示原因。
 */
export function matchKeywordDirections(text, directions) {
  const haystack = String(text ?? "").toLowerCase();
  if (!haystack) return [];
  const matched = [];
  for (const direction of directions ?? []) {
    if (!direction || typeof direction !== "object") continue;
    const hits = [];
    for (const keyword of direction.keywords ?? []) {
      const needle = String(keyword ?? "").trim().toLowerCase();
      if (needle && haystack.includes(needle)) hits.push(keyword);
    }
    if (hits.length === 0) continue;
    matched.push({ id: direction.id, label: direction.label, topic: direction.topic, keywords: hits });
  }
  return matched;
}

/**
 * GitHub 搜索里混着两类不能当工具推荐的东西：
 *   1. 关键词堆砌的垃圾仓库 —— 描述里塞满热门词，只为被各种查询捞出来；
 *   2. 靠改名绕开过滤的政治宣传仓库及其备份（例如 china-dictatorship 的拼写变体）。
 * 2026-09-27 与 2026-09-30 两期日刊就是被这类仓库混进了 tool-pick 栏目，所以必须在入池前拦掉。
 *
 * 判定分三层：必须有描述；命中 blockedKeywords 直接否决；intentKeywords 一个都不命中则否决。
 * 返回 null 表示通过，否则返回拒绝原因（用于日志归因）。
 * 放在 content-policy 而不是 collect.mjs，是因为 collect.mjs 在 import 时就会执行整轮采集。
 */
export function toolRepositoryRejection(repository, settings) {
  const options = settings ?? {};
  const description = String(repository?.description ?? "").trim();
  if (!description) return "缺少仓库描述";
  const haystack = `${repository?.name ?? ""} ${description} ${(repository?.topics ?? []).join(" ")}`.toLowerCase();
  const blocked = (options.blockedKeywords ?? []).map((entry) => String(entry).toLowerCase()).filter(Boolean);
  if (blocked.some((keyword) => haystack.includes(keyword))) return "命中阻断词";
  const intent = (options.intentKeywords ?? []).map((entry) => String(entry).toLowerCase()).filter(Boolean);
  if (intent.length > 0 && !intent.some((keyword) => haystack.includes(keyword))) return "不像工具";
  return null;
}

export function isAllowedHealthRegion(region, allowedRegions) {
  return Array.isArray(allowedRegions) && allowedRegions.includes(region);
}
