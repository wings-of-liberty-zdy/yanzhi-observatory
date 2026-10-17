import { promises as fs } from "node:fs";
import path from "node:path";
import { takeWithSourceCap } from "./content-policy.mjs";
import { canonicalUrl, readJson } from "./runtime.mjs";
import { scoreBreakdown, scoreCandidate } from "./scoring.mjs";

const evergreenTypes = new Set(["ai-tip", "ai-know", "tool-pick"]);

function rememberEvergreenUrl(urls, value) {
  const raw = String(value ?? "").trim();
  if (!raw) return;
  urls.add(raw);
  const canonical = canonicalUrl(raw);
  if (canonical) urls.add(canonical);
}

function candidateEvergreenUrl(candidate) {
  return canonicalUrl(candidate?.url) || canonicalUrl(candidate?.source?.url) || String(candidate?.url ?? candidate?.source?.url ?? "").trim();
}

function isEvergreenHistoryItem(item) {
  return item?.evergreen === true || evergreenTypes.has(item?.type);
}

function evergreenUrlAlreadyUsed(candidate, ...urlSets) {
  const values = [candidateEvergreenUrl(candidate), candidate?.url, candidate?.source?.url];
  return values.some((value) => {
    const raw = String(value ?? "").trim();
    if (!raw) return false;
    return urlSets.some((urls) => urls?.has(raw) || urls?.has(canonicalUrl(raw)));
  });
}

export function publicIssueFiles(directory) {
  return fs
    .readdir(directory)
    .then((files) => files.filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)))
    .catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
}

export async function readEvergreenHistory(directory) {
  const files = (await publicIssueFiles(directory)).sort((left, right) => right.localeCompare(left));
  const keys = new Set();
  const urls = new Set();
  for (const file of files) {
    const issue = await readJson(path.join(directory, file), null);
    for (const item of issue?.items ?? []) {
      if (!isEvergreenHistoryItem(item)) continue;
      if (item.evergreenKey) keys.add(item.evergreenKey);
      rememberEvergreenUrl(urls, item.url);
      for (const source of item.sources ?? []) rememberEvergreenUrl(urls, source?.url);
    }
  }
  return { keys, urls };
}

export function hasConsumedEvergreenConflict(items, history) {
  const usedKeys = history?.keys ?? new Set();
  const usedUrls = history?.urls ?? new Set();
  const seenUrls = new Set();
  for (const item of items ?? []) {
    if (!isEvergreenHistoryItem(item)) continue;
    if (item.evergreenKey && usedKeys.has(item.evergreenKey)) return true;
    const urls = [item.url, ...(item.sources ?? []).map((source) => source?.url)];
    for (const url of urls) {
      if (!String(url ?? "").trim()) continue;
      if (evergreenUrlAlreadyUsed({ url }, usedUrls, seenUrls)) return true;
      rememberEvergreenUrl(seenUrls, url);
    }
  }
  return false;
}

const requiredTypeLabels = {
  "ai-tip": "AI 技巧",
  "ai-know": "AI 知本",
  "tool-pick": "工具推荐",
};

export function isCompetitionCandidate(candidate) {
  const content = `${candidate?.title ?? ""} ${candidate?.excerpt ?? ""}`;
  const competition = /\b(challenge|competition|contest|hackathon)\b|挑战赛|竞赛|比赛|黑客松/i.test(content);
  const application = /\b(apply|application|registration|register|submit|proposal|prize|deadline|closes?)\b|申请|报名|征集|提交|截止|奖项/i.test(content);
  return competition && application;
}

export function requiredDailyTypes(config, date) {
  const formats = config?.dailyFormats ?? {};
  if (date < String(formats.activeFrom ?? "9999-12-31")) return [];
  const required = [...(formats.requiredTypes ?? [])];
  const knowledgeFrom = formats.aiKnowFrom;
  if (knowledgeFrom && date < String(knowledgeFrom)) {
    return required.filter((type) => type !== "ai-know");
  }
  return required;
}

function scoreAllCandidates(candidates, config, preferences, date) {
  const timeZone = config?.timezone ?? "Asia/Shanghai";
  return (candidates ?? [])
    .map((candidate) => {
      const breakdown = scoreBreakdown(candidate, config, preferences, date, timeZone);
      return {
        ...candidate,
        score: breakdown.total,
        scoreBreakdown: breakdown.parts,
      };
    })
    .sort((left, right) => right.score - left.score || String(left.id).localeCompare(String(right.id)));
}

export function rankCandidates(candidates, config, preferences, history, date) {
  const excluded = new Set(
    (preferences?.actions ?? [])
      .filter((action) => ["replace-item", "remove-item"].includes(action.action))
      .map((action) => action.itemId),
  );
  const usedEvergreen = history?.keys ?? new Set();
  const usedEvergreenUrls = history?.urls ?? new Set();
  const selectedEvergreenUrls = new Set();
  return scoreAllCandidates(candidates, config, preferences, date)
    .filter((candidate) => !excluded.has(candidate.id))
    // 同题反查命中的「第二家报道」只作为种子的佐证进提示词，不单独占候选席位：
    // 否则同一件事会被写成两条条目，或者把种子的位置挤掉。
    .filter((candidate) => !candidate.corroboratesSeed)
    .filter((candidate) => !isCompetitionCandidate(candidate))
    .filter((candidate) => preferences?.sourceTrust?.[candidate.source?.id] !== "blocked")
    .filter((candidate) => {
      if (!candidate.evergreen) return true;
      if (usedEvergreen.has(candidate.evergreenKey)) return false;
      if (evergreenUrlAlreadyUsed(candidate, usedEvergreenUrls, selectedEvergreenUrls)) return false;
      rememberEvergreenUrl(selectedEvergreenUrls, candidateEvergreenUrl(candidate));
      return true;
    });
}

export function selectCandidates(candidates, config, preferences, history, requiredTypes, date) {
  const ranked = rankCandidates(candidates, config, preferences, history, date);
  const required = requiredTypes.map((type) => {
    const candidate = ranked.find((entry) => entry.typeHint === type);
    if (!candidate) throw new Error(`No unused ${type} candidate is available.`);
    return candidate;
  });
  const requiredIds = new Set(required.map((candidate) => candidate.id));
  const requiredTypeSet = new Set(requiredTypes);
  const optionalRanked = ranked.filter(
    (candidate) => !requiredIds.has(candidate.id) && !requiredTypeSet.has(candidate.typeHint),
  );
  const maximumHealthItems = Number(config.healthPolicy?.maximumItemsPerIssue ?? 1);
  let selectedHealthItems = 0;
  const policyRanked = optionalRanked.filter((candidate) => {
    if (candidate.subtopicHint !== "disease-control") return true;
    if (selectedHealthItems >= maximumHealthItems) return false;
    selectedHealthItems += 1;
    return true;
  });
  const promptMaximum = config.generation.maximumItems + 2;
  const optionalSlots = Math.max(0, promptMaximum - required.length);
  const horizonQuota = Math.min(
    policyRanked.filter((candidate) => candidate.laneHint === "horizon").length,
    Math.max(1, Math.ceil(promptMaximum * (1 - config.generation.focusRatioMaximum))),
  );
  const focusQuota = Math.max(0, optionalSlots - horizonQuota);
  const maximumPerSource = config.editorialRules?.maximumCandidatesPerSource ?? 2;
  const horizon = takeWithSourceCap(
    policyRanked.filter((candidate) => candidate.laneHint === "horizon"),
    horizonQuota,
    maximumPerSource,
    required,
  );
  const focus = takeWithSourceCap(
    policyRanked.filter((candidate) => candidate.laneHint === "focus"),
    focusQuota,
    maximumPerSource,
    [...required, ...horizon],
  );
  return [...required, ...focus, ...horizon].sort((left, right) => right.score - left.score);
}

export function annotateCandidatePool(candidates, config, preferences, history, date) {
  const requiredTypes = requiredDailyTypes(config, date);
  const ranked = scoreAllCandidates(candidates, config, preferences, date);
  let selected = [];
  let selectionNote;
  try {
    selected = selectCandidates(candidates, config, preferences, history, requiredTypes, date);
  } catch (error) {
    selectionNote = error instanceof Error ? error.message : "今晚候选尚不足。";
  }
  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  const selectedReasons = new Map(selected.map((candidate) => {
    if (requiredTypes.includes(candidate.typeHint)) {
      return [candidate.id, `固定栏目「${requiredTypeLabels[candidate.typeHint] ?? candidate.typeHint}」必选`];
    }
    if (candidate.laneHint === "horizon") return [candidate.id, "视野之外配额入选"];
    return [candidate.id, "目之所及按权重入选"];
  }));
  const items = ranked.map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
    publishCandidate: selectedIds.has(candidate.id),
    publishReason: selectedReasons.get(candidate.id),
  }));
  return {
    date,
    requiredTypes,
    selectedCount: selected.length,
    promptCapacity: Number(config?.generation?.maximumItems ?? 0) + 2,
    selectionNote,
    items,
  };
}

export { scoreCandidate };
