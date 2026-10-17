import { matchKeywordDirections } from "./content-policy.mjs";
import { dateInTimeZone } from "./runtime.mjs";

/** 候选排序的时效加分。今日见报必须明显高于一周内旧闻。 */
export const RECENCY = {
  today: 48,
  yesterday: 16,
  recent: 8,
  week: 3,
};

const RECENCY_LABELS = {
  today: "今日见报",
  yesterday: "昨日见报",
  recent: "近三日",
  week: "本周内",
};

export function calendarAgeDays(timestamp, issueDate, timeZone = "Asia/Shanghai") {
  const publishedDay = dateInTimeZone(new Date(timestamp), timeZone);
  const published = Date.parse(`${publishedDay}T00:00:00Z`);
  const issue = Date.parse(`${issueDate}T00:00:00Z`);
  return Math.round((issue - published) / 86_400_000);
}

export function recencyScore(candidate, issueDate, timeZone = "Asia/Shanghai") {
  return recencyBreakdown(candidate, issueDate, timeZone).points;
}

export function recencyBreakdown(candidate, issueDate, timeZone = "Asia/Shanghai") {
  if (candidate?.evergreen === true) {
    return { points: 0, key: "evergreen", label: "常青内容不加时效分" };
  }
  const timestamp = Date.parse(candidate?.publishedAt ?? candidate?.discoveredAt);
  if (Number.isNaN(timestamp)) {
    return { points: 0, key: "unknown", label: "发布时间未知" };
  }
  const ageDays = calendarAgeDays(timestamp, issueDate, timeZone);
  if (ageDays < 0) return { points: 0, key: "future", label: "尚未到期刊日" };
  if (ageDays === 0) return { points: RECENCY.today, key: "today", label: RECENCY_LABELS.today };
  if (ageDays === 1) return { points: RECENCY.yesterday, key: "yesterday", label: RECENCY_LABELS.yesterday };
  if (ageDays <= 3) return { points: RECENCY.recent, key: "recent", label: RECENCY_LABELS.recent };
  if (ageDays <= 7) return { points: RECENCY.week, key: "week", label: RECENCY_LABELS.week };
  return { points: 0, key: "older", label: "超过一周" };
}

function roundScore(value) {
  return Math.round(Number(value) * 10) / 10;
}

function part(key, label, points) {
  return { key, label, points: roundScore(points) };
}

/**
 * 关键词方向加分：命中配置里的方向就越容易被留下。
 *
 * 与主题权重的区别：主题权重是「这一大类值多少分」，一篇 40 分的 AI 新闻永远压过
 * 20 分的机器人新闻；关键词方向是「这一篇是否正踩在我在意的方向上」，
 * 所以它是按命中数累加、有上限，同一主题下的不同稿件会因此拉开差距。
 * 标题命中按 titleMultiplier 倍计，因为标题命中通常代表整篇就是讲这件事。
 *
 * 降权词（direction.demoteKeywords）是同一套匹配的反向出口：方向里写着「明确不看」的词，
 * 命中一个按 demotePerKeyword 扣分，标题命中同样按倍数计，总额不超过 maximumDemoteBoost。
 * 加这一层是因为同主题内部没法靠主题权重分开——「考研」和「保研」都归 postgraduate，
 * 主题分、来源分、时效分完全一样，保研经验贴会和招生简章一起挤进候选池
 * （2026-10-12 / 10-13 两期的保研条目就是这么进来的）。
 * 选择扣分而不是硬删：像「推免比例上升、统考名额缩减」这种同时踩两边的稿子，
 * 命中考研词后仍能留在池里，不至于把与考研有关的信息一起砍掉。
 */
export function keywordSignal(candidate, config) {
  const settings = config?.keywordSignals ?? {};
  const directions = settings.directions ?? [];
  if (settings.enabled === false || directions.length === 0) {
    return { points: 0, boost: 0, demote: 0, label: "未启用关键词方向", directions: [], demotedKeywords: [] };
  }
  const multiplier = Number(settings.titleMultiplier ?? 2);
  const count = (entries) => entries.reduce((sum, entry) => sum + entry.keywords.length, 0);
  const titleHits = matchKeywordDirections(candidate?.title, directions);
  const bodyHits = matchKeywordDirections(candidate?.excerpt, directions);
  const titleCount = count(titleHits);
  const bodyCount = count(bodyHits);
  const labels = [...new Set([...titleHits, ...bodyHits].map((entry) => entry.label))];
  const perKeyword = Number(settings.matchBoostPerKeyword ?? 5);
  const maximum = Number(settings.maximumMatchBoost ?? 20);
  const boost = Math.min((titleCount * multiplier + bodyCount) * perKeyword, maximum);

  // 降权词复用同一套子串匹配：把每个方向的 demoteKeywords 当成一个只用于扣分的伪方向。
  const demoteDirections = directions
    .filter((direction) => Array.isArray(direction?.demoteKeywords) && direction.demoteKeywords.length > 0)
    .map((direction) => ({ id: direction.id, label: direction.label, keywords: direction.demoteKeywords }));
  const demoteTitle = matchKeywordDirections(candidate?.title, demoteDirections);
  const demoteBody = matchKeywordDirections(candidate?.excerpt, demoteDirections);
  const demotedKeywords = [...new Set([...demoteTitle, ...demoteBody].flatMap((entry) => entry.keywords))];
  const demotePerKeyword = Number(settings.demotePerKeyword ?? 12);
  const maximumDemote = Number(settings.maximumDemoteBoost ?? 36);
  const demote = Math.min((count(demoteTitle) * multiplier + count(demoteBody)) * demotePerKeyword, maximumDemote);

  const parts = [];
  if (boost > 0) parts.push(`命中关键词方向「${labels.join("、")}」${titleCount > 0 ? `（标题命中 ${titleCount} 个）` : ""}`);
  if (demote > 0) parts.push(`命中降权词「${demotedKeywords.join("、")}」-${demote}`);
  return {
    points: boost - demote,
    boost,
    demote,
    label: parts.length > 0 ? parts.join("；") : "未命中关键词方向",
    directions: labels,
    demotedKeywords,
  };
}

export function scoreBreakdown(candidate, config, preferences, issueDate, timeZone = "Asia/Shanghai") {
  const topicId = candidate?.topicHint;
  const topic = config?.topics?.[topicId];
  const recency = recencyBreakdown(candidate, issueDate, timeZone);
  const topicWeight = Number(topic?.weight ?? 0);
  const preferenceRaw = Number(preferences?.topicAdjustments?.[topicId] ?? 0);
  const preference = preferenceRaw * 4;
  const sourceTrustRaw = Number(candidate?.source?.trust ?? 0.5);
  const sourceTrust = sourceTrustRaw * 20;
  const subtopicId = candidate?.subtopicHint;
  const subtopic = config?.pinnedSubtopics?.[subtopicId];
  const subtopicBoost = Number(subtopic?.weightBoost ?? 0);
  const trusted = preferences?.sourceTrust?.[candidate?.source?.id] === "trusted";
  const trustedBonus = trusted ? 12 : 0;
  const opportunity = candidate?.typeHint === "opportunity";
  const opportunityBonus = opportunity ? 2 : 0;
  const keywords = keywordSignal(candidate, config);
  const parts = [
    part("topic", `主题「${topic?.label ?? topicId ?? "未分类"}」基础权重`, topicWeight),
    part("preference", preferenceRaw === 0 ? "近期主题偏好未调整" : `近期主题偏好 ×4（原始 ${preferenceRaw}）`, preference),
    part("sourceTrust", `来源可信度 ${sourceTrustRaw} ×20`, sourceTrust),
    part("subtopic", subtopicBoost > 0 ? `固定子主题「${subtopic.label}」加权` : "无固定子主题加权", subtopicBoost),
    part("trusted", trusted ? "来源已标为可信" : "来源未标为可信", trustedBonus),
    part("keywords", keywords.label, keywords.points),
    part("recency", recency.label, recency.points),
    part("opportunity", opportunity ? "岗位观察条目加分" : "非岗位观察条目", opportunityBonus),
  ];
  return {
    total: roundScore(parts.reduce((sum, entry) => sum + entry.points, 0)),
    parts: parts.filter((entry) => entry.points !== 0 || ["topic", "sourceTrust", "recency"].includes(entry.key)),
  };
}

export function scoreCandidate(candidate, config, preferences, issueDate, timeZone = "Asia/Shanghai") {
  return scoreBreakdown(candidate, config, preferences, issueDate, timeZone).total;
}
