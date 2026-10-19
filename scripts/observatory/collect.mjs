import path from "node:path";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import {
  collectEvergreenCatalog,
  isAllowedHealthRegion,
  matchesBlockedKeywords,
  toolRepositoryRejection,
} from "./content-policy.mjs";
import {
  parseWeeklyIssue,
  weeklyEntriesToCandidates,
  weeklyIssueNumber,
} from "./weekly.mjs";
import {
  candidateId,
  canonicalUrl,
  cleanText,
  dateInTimeZone,
  fetchWithTimeout,
  isStrictCalendarDate,
  observatoryPaths,
  readConfig,
  readJson,
  readPreferences,
  readProviderConfig,
  readResponseText,
  reserveBudget,
  settleBudget,
  strictHttpUrl,
  removeExpiredJson,
  writeJsonAtomic,
} from "./runtime.mjs";
import {
  buildMaterialsFromCandidates,
  collectCookbookMaterials,
  distillEvergreenCandidates,
  readRecentDigest,
} from "./distillation.mjs";
import { classifySearchFailure } from "./search-health.mjs";

const dryRun = process.argv.includes("--dry-run");
const noPaidSearch = process.argv.includes("--no-paid-search");
/** 允许在 --dry-run 下一并试跑素材蒸馏（默认 dry-run 不花钱、不调 LLM）。 */
const distillInDryRun = process.argv.includes("--distill");
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  trimValues: true,
  processEntities: false,
});

async function withRetry(operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 700));
    }
  }
  throw lastError;
}

function array(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === "object") return text(value["#text"] ?? value.__cdata ?? value.value);
  return "";
}

function entryLink(entry) {
  const links = array(entry.link);
  const preferred = links.find((link) => typeof link === "object" && (link["@rel"] === "alternate" || !link["@rel"]));
  const candidate = preferred ?? links[0];
  if (typeof candidate === "string") return candidate;
  if (candidate && typeof candidate === "object") return candidate["@href"] ?? text(candidate);
  return text(entry.guid);
}

function feedEntries(parsed) {
  if (parsed?.rss?.channel?.item) return array(parsed.rss.channel.item);
  if (parsed?.feed?.entry) return array(parsed.feed.entry);
  if (parsed?.rdf?.item) return array(parsed.rdf.item);
  return [];
}

function normalizeFeedEntry(entry, feed, discoveredAt) {
  const title = cleanText(text(entry.title), 240);
  const url = canonicalUrl(entryLink(entry));
  if (!title) return null;
  try {
    strictHttpUrl(url, { allowHttp: true });
  } catch {
    return null;
  }
  const excerpt = cleanText(
    text(entry.description) || text(entry.summary) || text(entry.content) || text(entry["content:encoded"]),
  );
  const rawPublished =
    text(entry.pubDate) || text(entry.published) || text(entry.updated) || text(entry["dc:date"]);
  const publishedAt = Number.isNaN(Date.parse(rawPublished)) ? discoveredAt : new Date(rawPublished).toISOString();
  const opportunitySignal = /\b(full[- ]?time|part[- ]?time|internship|hiring|job\s+opening|vacanc(?:y|ies)|openings?)\b|\b(?:research|engineering|software|hardware|robotics)\s+position\b|招聘|实习|岗位|职位/i.test(
    `${title} ${excerpt}`,
  );
  return {
    id: candidateId(url, title),
    title,
    url,
    excerpt,
    publishedAt,
    discoveredAt,
    source: {
      id: feed.id,
      name: feed.name,
      url: feed.url,
      language: feed.language,
      trust: feed.trust,
    },
    topicHint: feed.topic,
    subtopicHint: feed.subtopic,
    laneHint: feed.lane,
    typeHint: opportunitySignal ? "opportunity" : feed.type,
    discoveredBy: "feed",
  };
}

async function collectFeed(feed, config, preferences, discoveredAt) {
  if (preferences.sourceTrust?.[feed.id] === "blocked") return [];
  const urls = [feed.url, feed.fallbackUrl].filter(Boolean);
  let lastError;
  for (let index = 0; index < urls.length; index += 1) {
    try {
      strictHttpUrl(urls[index], { allowHttp: true });
      const attempts = feed.fallbackUrl ? 1 : 2;
      const timeoutMs = index === 0 && feed.fallbackUrl
        ? Math.min(5000, config.collection.requestTimeoutMs)
        : config.collection.requestTimeoutMs;
      const response = await withRetry(
        () => fetchWithTimeout(
          urls[index],
          {
            redirect: "error",
            headers: {
              Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
              "User-Agent": config.collection.userAgent,
            },
          },
          timeoutMs,
        ),
        attempts,
      );
      if (!response.ok) throw new Error(`${feed.name}: HTTP ${response.status}`);
      const raw = await readResponseText(response, 2_000_000);
      if (!/^\s*</.test(raw)) throw new Error(`${feed.name}: response is not XML.`);
      const xmlMarkup = raw.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
      if (/<\s*!DOCTYPE|<\s*!ENTITY/i.test(xmlMarkup)) {
        throw new Error(`${feed.name}: XML declarations are not allowed outside CDATA.`);
      }
      const parsed = xmlParser.parse(raw);
      return feedEntries(parsed)
        .slice(0, 100)
        .map((entry) => normalizeFeedEntry(entry, feed, discoveredAt))
        .filter(Boolean);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function publishedFromText(...values) {
  const raw = values.filter(Boolean).join(" ");
  const compact = raw.match(/(?:t|\/)(20\d{2})(\d{2})(\d{2})(?:_|\D)/);
  const separated = raw.match(/(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})/);
  const monthOnly = raw.match(/(20\d{2})年(\d{1,2})月/);
  const parts = compact ?? separated ?? (monthOnly ? [monthOnly[0], monthOnly[1], monthOnly[2], "01"] : null);
  if (!parts) return null;
  const date = `${parts[1]}-${String(parts[2]).padStart(2, "0")}-${String(parts[3]).padStart(2, "0")}`;
  const parsed = Date.parse(`${date}T00:00:00+08:00`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function matchesPattern(value, pattern) {
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return false;
  }
}

function healthRegionFromText(value, config, fallback) {
  const allowed = config.healthPolicy?.allowedRegions ?? [];
  if (isAllowedHealthRegion(fallback, allowed)) return fallback;
  return allowed.find((region) => region !== "全国" && String(value).includes(region));
}

async function fetchHtml(url, config, maximumBytes = 2_000_000) {
  strictHttpUrl(url, { allowHttp: true });
  const response = await fetchWithTimeout(
    url,
    {
      redirect: "error",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": config.collection.userAgent,
      },
    },
    config.collection.requestTimeoutMs,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readResponseText(response, maximumBytes);
}

async function collectHealthSource(source, config, preferences, discoveredAt) {
  if (preferences.sourceTrust?.[source.id] === "blocked") return [];
  const listHtml = await fetchHtml(source.listUrl, config);
  const root = load(listHtml);
  const links = [];
  const seen = new Set();
  root("a[href]").each((_, element) => {
    const node = root(element);
    const title = cleanText(node.attr("title") || node.text(), 240);
    const href = node.attr("href");
    if (!title || !href || !matchesPattern(title, source.linkPattern)) return;
    let articleUrl;
    try {
      articleUrl = new URL(href, source.listUrl).toString();
      strictHttpUrl(articleUrl, { allowHttp: true });
      const allowedOrigins = new Set([
        new URL(source.listUrl).origin,
        ...(source.allowedArticleOrigins ?? []),
      ]);
      if (!allowedOrigins.has(new URL(articleUrl).origin)) return;
    } catch {
      return;
    }
    if (seen.has(articleUrl)) return;
    seen.add(articleUrl);
    const context = cleanText(node.closest("li, article, .ind-science, .article-list").text(), 500);
    links.push({ title, articleUrl, context });
  });

  const results = [];
  for (const entry of links.slice(0, 5)) {
    try {
      const articleHtml = await fetchHtml(entry.articleUrl, config, 3_000_000);
      const article = load(articleHtml);
      const selectorText = (source.articleSelectors ?? [])
        .map((selector) => cleanText(article(selector).first().text(), 1800))
        .find((value) => value.length >= 80);
      const description = cleanText(
        article('meta[name="description"]').attr("content") ||
        article('meta[name="Description"]').attr("content"),
        1800,
      );
      const excerpt = selectorText || description;
      if (excerpt.length < 80) continue;
      const evidenceText = `${entry.title} ${excerpt}`;
      if (
        source.evidence === "monitoring" &&
        !/监测|阳性率|病例|流行水平|疫情概况/.test(evidenceText)
      ) continue;
      if (
        source.evidence === "risk-alert" &&
        !/健康风险提示|重点防范|高发|风险增加|需警惕|流行季/.test(evidenceText)
      ) continue;
      const publishedAt = publishedFromText(
        entry.articleUrl,
        entry.title,
        entry.context,
        article('meta[name="PubDate"]').attr("content"),
        article('meta[name="pubdate"]').attr("content"),
        article('meta[property="article:published_time"]').attr("content"),
        article("time").first().attr("datetime"),
        article("time").first().text(),
        article(".date, .time, .pub-date, .article-date").first().text(),
      );
      if (!publishedAt) {
        console.warn(`[health-article] ${source.id}: skipped undated article ${entry.articleUrl}`);
        continue;
      }
      results.push({
        id: candidateId(entry.articleUrl, entry.title),
        title: entry.title,
        url: canonicalUrl(entry.articleUrl),
        excerpt: cleanText(`地区：${source.region}。证据：${source.evidence}。${excerpt}`, 1600),
        publishedAt,
        discoveredAt,
        source: {
          id: source.id,
          name: source.name,
          url: source.listUrl,
          language: "zh-CN",
          trust: source.trust,
        },
        topicHint: "world",
        subtopicHint: "disease-control",
        laneHint: "horizon",
        typeHint: "news",
        healthEvidence: source.evidence,
        regionHint: source.region,
        maxAgeHours: source.maxAgeHours,
        discoveredBy: "official-health-html",
      });
    } catch (error) {
      console.warn(`[health-article] ${source.id}: ${error.message}`);
    }
  }
  return results;
}

/**
 * GitHub 搜索里混着两类不能当工具推荐的东西：
 *   1. 关键词堆砌的垃圾仓库 —— 描述里塞满热门词，只为被各种查询捞出来；
 *   2. 靠改名绕开过滤的政治宣传仓库及其备份（例如 china-dictatorship 的拼写变体）。
 * 2026-09-27 与 2026-09-30 两期日刊就是被这类仓库混进了 tool-pick 栏目，所以这里必须在入池前拦掉。
 * 判定逻辑放在 content-policy.mjs，便于单独测试。
 */

/**
 * 阮一峰《科技爱好者周刊》：广度远超本站常规订阅，用来给关键词方向供料。
 *
 * 两条设计取舍：
 *   1. `requireKeywordMatch` 默认开 —— 周刊一期几十条链接，题材横跨前端、设计、历史，
 *      不过滤会把常规新闻整批挤掉；命中关键词方向的才进来，这才叫「关键词决定还要找哪些方向」。
 *   2. 「工具」小节直接产出 tool-pick 候选并带 evergreen 标记 —— validate.mjs 对这三类固定内容
 *      是硬性要求；key 里带期号，所以每周都是新 key，不会像常青目录那样一次性耗尽。
 */
async function collectWeeklyItems(config, discoveredAt) {
  const settings = config.weekly ?? {};
  if (settings.enabled !== true) return [];
  const repo = String(settings.repo ?? "").trim();
  if (!repo) return [];
  const branch = String(settings.branch ?? "master").trim();
  const directions = config.keywordSignals?.directions ?? [];
  const requireMatch = settings.requireKeywordMatch !== false;
  const wantedIssues = Math.max(1, Math.min(3, Number(settings.issues ?? 1)));
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": config.collection.userAgent,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const request = async (endpoint, accept) =>
    fetchWithTimeout(
      `https://api.github.com${endpoint}`,
      { redirect: "error", headers: { ...headers, ...(accept ? { Accept: accept } : {}) } },
      config.collection.requestTimeoutMs,
    );

  const listing = await request(`/repos/${repo}/contents/docs?ref=${encodeURIComponent(branch)}`);
  const listingText = await readResponseText(listing, 4_000_000);
  if (!listing.ok) throw new Error(`GitHub ${listing.status}`);
  const issueNumbers = array(JSON.parse(listingText))
    .map((entry) => (entry?.type === "file" ? weeklyIssueNumber(entry.name) : null))
    .filter((number) => Number.isSafeInteger(number) && number > 0)
    .sort((left, right) => right - left)
    .slice(0, wantedIssues);
  if (issueNumbers.length === 0) throw new Error("周刊目录里没有找到 issue-NNN.md");

  const items = [];
  for (const number of issueNumbers) {
    const filePath = `docs/issue-${number}.md`;
    const [content, commit] = await Promise.all([
      request(`/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`, "application/vnd.github.raw+json"),
      request(`/repos/${repo}/commits?path=${encodeURIComponent(filePath)}&per_page=1`).catch(() => null),
    ]);
    const markdown = await readResponseText(content, 2_000_000);
    if (!content.ok) throw new Error(`GitHub ${content.status}（${filePath}）`);
    let publishedAt = discoveredAt;
    if (commit?.ok) {
      const commits = JSON.parse(await readResponseText(commit, 1_000_000));
      const stamp = array(commits)[0]?.commit?.committer?.date ?? array(commits)[0]?.commit?.author?.date;
      if (stamp && !Number.isNaN(Date.parse(stamp))) publishedAt = stamp;
    }

    const entries = parseWeeklyIssue(markdown, {
      sections: settings.sections ?? [],
      maximumExcerptCharacters: settings.maximumExcerptCharacters ?? 400,
    });
    items.push(...weeklyEntriesToCandidates(entries, {
      repo,
      branch,
      issueNumber: number,
      publishedAt,
      discoveredAt,
      directions,
      requireKeywordMatch: requireMatch,
      maximumItemsPerSection: settings.maximumItemsPerSection ?? 6,
      fallbackTopic: settings.fallbackTopic,
      trust: settings.trust,
    }));
  }
  return items;
}

/**
 * 关键词方向的**免费**发现通道。
 *
 * 「关键词决定除了常规新闻还要去找哪些方向」这条路原本只挂在付费搜索上，
 * 而本仓库的 activeSearch 是 off —— 不补一条免费通道，这个功能就是死的。
 * 两个引擎都免密钥、只按关键词查、只采信接口真实返回的时间与链接：
 *   - Hacker News（Algolia）：近期技术新闻与讨论，用来喂 focus 方向；
 *   - arXiv：近期论文，用来喂 research 类方向。
 * 两个引擎都只覆盖英文技术题材；考研、岗位这类中文方向不在此列（见文档说明）。
 */
async function collectKeywordDiscovery(config, discoveredAt) {
  const settings = config.keywordDiscovery ?? {};
  if (settings.enabled !== true) return [];
  const directions = (config.keywordSignals?.directions ?? []).filter((direction) => direction?.discoveryQuery);
  if (directions.length === 0) return [];
  const perRun = Math.max(1, Number(settings.maximumDirectionsPerRun ?? 4));
  const offset = Math.floor(Date.parse(discoveredAt) / 3_600_000) % directions.length;
  const chosen = Array.from(
    { length: Math.min(perRun, directions.length) },
    (_, index) => directions[(offset + index) % directions.length],
  );
  const since = Math.floor((Date.parse(discoveredAt) - Number(settings.maximumAgeDays ?? 21) * 86_400_000) / 1000);
  const items = [];
  const accept = (engineId, engineName, engineUrl, direction, entry, typeHint) => {
    if (!entry?.title || !entry?.url) return;
    items.push({
      id: candidateId(entry.url, `${engineId}:${direction.id}`),
      title: cleanText(entry.title, 240),
      url: canonicalUrl(entry.url),
      excerpt: cleanText(entry.excerpt, 700),
      publishedAt: entry.publishedAt,
      discoveredAt,
      source: { id: engineId, name: engineName, url: engineUrl, language: "en", trust: 0.8 },
      topicHint: direction.topic,
      laneHint: direction.lane ?? "focus",
      typeHint,
      keywordDirections: [direction.id],
      discoveredBy: `keyword-${engineId}`,
    });
  };

  const hackernews = settings.engines?.hackernews ?? {};
  const arxiv = settings.engines?.arxiv ?? {};
  const requests = [];
  if (hackernews.enabled === true) {
    for (const direction of chosen) {
      requests.push((async () => {
        const url = new URL("https://hn.algolia.com/api/v1/search_by_date");
        // 注意：Algolia 是全文检索、多个词默认取交集，长句查询必然 0 命中，
        // 所以免费引擎用的是方向上的 discoveryQuery（两三个词），不是给网页搜索用的 searchQuery。
        url.searchParams.set("query", direction.discoveryQuery);
        url.searchParams.set("tags", "story");
        url.searchParams.set("hitsPerPage", String(Math.max(1, Number(hackernews.perDirection ?? 3))));
        const minimumPoints = Number(hackernews.minimumPoints ?? 0);
        url.searchParams.set(
          "numericFilters",
          minimumPoints > 0 ? `created_at_i>${since},points>=${minimumPoints}` : `created_at_i>${since}`,
        );
        const response = await fetchWithTimeout(
          url,
          { redirect: "error", headers: { Accept: "application/json", "User-Agent": config.collection.userAgent } },
          config.collection.requestTimeoutMs,
        );
        const payload = JSON.parse(await readResponseText(response, 4_000_000));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        for (const hit of array(payload.hits)) {
          if (!hit?.title || !hit?.url) continue;
          accept("hackernews", "Hacker News", "https://news.ycombinator.com/", direction, {
            title: hit.title,
            url: hit.url,
            excerpt: `Hacker News 近期讨论（${Number(hit.points ?? 0)} 分，${Number(hit.num_comments ?? 0)} 条评论）。`,
            publishedAt: hit.created_at ?? discoveredAt,
          }, direction.type ?? "news");
        }
      })());
    }
  }
  if (arxiv.enabled === true) {
    const arxivDirections = chosen.slice(0, Math.max(1, Number(arxiv.maximumDirectionsPerRun ?? 2)));
    const spacing = Math.max(0, Number(arxiv.requestSpacingMs ?? 3200));
    requests.push((async () => {
      for (let index = 0; index < arxivDirections.length; index += 1) {
        const direction = arxivDirections[index];
        if (index > 0 && spacing > 0) await new Promise((resolve) => setTimeout(resolve, spacing));
        try {
          const url = new URL("https://export.arxiv.org/api/query");
          url.searchParams.set("search_query", `all:${direction.discoveryQuery}`);
          url.searchParams.set("sortBy", "submittedDate");
          url.searchParams.set("sortOrder", "descending");
          url.searchParams.set("max_results", String(Math.max(1, Number(arxiv.perDirection ?? 4))));
          const response = await fetchWithTimeout(
            url,
            { redirect: "error", headers: { "User-Agent": config.collection.userAgent } },
            config.collection.requestTimeoutMs,
          );
          const parsed = xmlParser.parse(await readResponseText(response, 4_000_000));
          for (const entry of array(parsed?.feed?.entry)) {
            const link = array(entry.link).map((item) => item?.["@href"]).find(Boolean) ?? text(entry.id);
            accept("arxiv", "arXiv", "https://arxiv.org/", direction, {
              title: text(entry.title).replace(/\s+/g, " ").trim(),
              url: link,
              excerpt: text(entry.summary).replace(/\s+/g, " ").trim(),
              publishedAt: text(entry.published) || text(entry.updated) || discoveredAt,
            }, "research");
          }
        } catch (error) {
          console.warn(`[keyword-arxiv] ${direction.id}: ${error.message}`);
        }
      }
    })());
  }

  const settled = await Promise.allSettled(requests);
  for (const result of settled) {
    if (result.status === "rejected") console.warn(`[keyword-discovery] ${result.reason?.message ?? result.reason}`);
  }
  return items;
}

async function collectToolDiscovery(config, discoveredAt) {
  if (!config.toolDiscovery?.enabled) return [];
  const queries = config.toolDiscovery.queries ?? [];
  if (queries.length === 0) return [];
  const dayIndex = Math.floor(Date.parse(discoveredAt) / 86_400_000) % queries.length;
  const apiUrl = new URL("https://api.github.com/search/repositories");
  apiUrl.searchParams.set("q", `${queries[dayIndex]} stars:>${config.toolDiscovery.minimumStars ?? 100}`);
  // 按 stars 而不是 updated 排序：updated 会把刚推过垃圾提交的关键词堆砌仓库顶到最前面。
  apiUrl.searchParams.set("sort", config.toolDiscovery.sort ?? "stars");
  apiUrl.searchParams.set("order", "desc");
  apiUrl.searchParams.set("per_page", String(Math.min(25, config.toolDiscovery.perPage ?? 12)));
  const response = await fetchWithTimeout(
    apiUrl,
    {
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": config.collection.userAgent,
        // 匿名搜索接口按出口 IP 限流（10 次/分钟），CI 的共享 IP 很容易撞上；
        // 工作流已注入 GITHUB_TOKEN，带上它才算稳定。
        ...(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN}` }
          : {}),
      },
    },
    config.collection.requestTimeoutMs,
  );
  const responseText = await readResponseText(response, 2_000_000);
  const payload = JSON.parse(responseText);
  if (!response.ok) throw new Error(`GitHub discovery HTTP ${response.status}`);
  const rejected = new Map();
  const accepted = array(payload.items)
    .filter((repository) => !repository.archived && !repository.fork && repository.html_url)
    .filter((repository) => {
      const reason = toolRepositoryRejection(repository, config.toolDiscovery);
      if (!reason) return true;
      rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
      return false;
    });
  if (rejected.size > 0) {
    const total = [...rejected.values()].reduce((sum, count) => sum + count, 0);
    console.warn(
      `[tool-discovery] 过滤 ${total} 个来源：${[...rejected].map(([reason, count]) => `${reason}×${count}`).join("、")}`,
    );
  }
  return accepted
    .map((repository) => ({
      id: candidateId(repository.html_url, repository.full_name),
      title: cleanText(repository.full_name, 240),
      url: canonicalUrl(repository.html_url),
      excerpt: cleanText(
        `${repository.description ?? "未提供说明"}。GitHub stars: ${repository.stargazers_count ?? 0}。主要语言：${repository.language ?? "未标注"}。`,
        700,
      ),
      publishedAt: repository.updated_at ?? discoveredAt,
      discoveredAt,
      source: {
        id: "github-tool-discovery",
        name: "GitHub Repository",
        url: "https://github.com/",
        language: "en",
        trust: 0.78,
      },
      topicHint: "engineering",
      laneHint: "focus",
      typeHint: "tool-pick",
      evergreen: true,
      evergreenKey: `tool-pick:${repository.full_name.toLowerCase()}`,
      discoveredBy: "github-public-search",
    }));
}

async function braveSearch(queryConfig, config, searchProvider, discoveredAt) {
  const apiKey = process.env[searchProvider.apiKeyEnv];
  if (!apiKey || noPaidSearch || !searchProvider.baseUrl) return [];
  const estimatedCny =
    (config.budget.braveSearchUsdPerThousand / 1000) * config.budget.usdToCny;
  const reservation = await reserveBudget(config, estimatedCny, {
    kind: "search-reservation",
    provider: "brave",
    queryId: queryConfig.id,
  });
  if (reservation.softLimitExceeded) {
    console.warn(`[budget] soft limit exceeded; running only configured bounded search.`);
  }
  try {
    const url = new URL(searchProvider.baseUrl);
    url.searchParams.set("q", queryConfig.query);
    url.searchParams.set("count", "10");
    url.searchParams.set("search_lang", /[\u3400-\u9fff]/.test(queryConfig.query) ? "zh-hans" : "en");
    url.searchParams.set("safesearch", "moderate");
    const response = await fetchWithTimeout(
      url,
      {
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
          "User-Agent": config.collection.userAgent,
        },
      },
      config.collection.requestTimeoutMs,
    );
    const responseText = await readResponseText(response, 2_000_000);
    if (!response.ok) {
      /*
       * 先判失败再解析 JSON：额度用尽时正文常常不是 JSON，
       * 倒过来会退化成一句「response is not JSON」，把「额度到了」这个关键信息丢掉。
       */
      const kind = classifySearchFailure(response.status, responseText);
      const error = new Error(`Brave ${queryConfig.id}: HTTP ${response.status}`);
      error.code = kind === "quota"
        ? "search-quota"
        : kind === "rate-limit"
          ? "search-rate-limit"
          : "search-failed";
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error(`Brave ${queryConfig.id}: response is not JSON.`);
    }
    const results = array(payload?.web?.results)
      .map((result) => {
        const title = cleanText(result.title, 240);
        const resultUrl = canonicalUrl(result.url);
        if (!title) return null;
        try {
          strictHttpUrl(resultUrl, { allowHttp: true });
        } catch {
          return null;
        }
        const hostname = new URL(resultUrl).hostname.replace(/^www\./, "");
        // 网页搜索会把 SEO 内容农场和同类危害内容一并带回来，入池前用同一份阻断词清单过一遍。
        if (matchesBlockedKeywords(`${title} ${result.description ?? ""}`, config.toolDiscovery?.blockedKeywords)) {
          return null;
        }
        return {
          id: candidateId(resultUrl, title),
          title,
          url: resultUrl,
          excerpt: cleanText(result.description),
          publishedAt: discoveredAt,
          discoveredAt,
          source: {
            id: `web-${hostname}`,
            name: cleanText(result.profile?.long_name || hostname, 180),
            url: `https://${hostname}/`,
            language: /[\u3400-\u9fff]/.test(`${title}${result.description ?? ""}`) ? "zh-CN" : "en",
            trust: 0.55,
          },
          topicHint: queryConfig.topic,
          subtopicHint: queryConfig.subtopic,
          regionHint: queryConfig.subtopic === "disease-control"
            ? healthRegionFromText(`${title} ${result.description ?? ""}`, config, queryConfig.region)
            : undefined,
          laneHint: queryConfig.lane,
          typeHint: queryConfig.type,
          discoveredBy: "brave",
          queryId: queryConfig.id,
          // 方向查询（id 形如 direction-<方向>）的结果也标注方向，与 HN/周刊口径一致。
          keywordDirections: queryConfig.id.startsWith("direction-")
            ? [queryConfig.id.slice("direction-".length)]
            : undefined,
        };
      })
      .filter(Boolean);
    await settleBudget(config, reservation, {
      at: discoveredAt,
      provider: "brave",
      kind: "search-request",
      units: 1,
      estimatedCny,
      queryId: queryConfig.id,
    });
    return results;
  } catch (error) {
    await settleBudget(config, reservation, {
      at: discoveredAt,
      provider: "brave",
      kind: "search-request-failed",
      units: 1,
      estimatedCny,
      queryId: queryConfig.id,
      error: error instanceof Error ? error.message.slice(0, 240) : "unknown",
    });
    throw error;
  }
}

/**
 * DeepSeek Search 的付费搜索实现，与 braveSearch 同形（同样的候选字段），便于互换。
 *
 * 2026-10-17 加：此前 `activeSearch` 只有 Brave 一种实现，切到 deepseek 时会拿
 * Brave 的 GET + `X-Subscription-Token` 去打它的 POST 端点，6 条查询全数失败。
 * 实测响应形状 `{results:[{title,url,site_name,summary,snippet,content,authority,rerank_score,date}]}`，
 * 计费口径「5 元 / 1000 次成功请求，无结果不计费」，价格写在 provider 的 cnyPerThousand。
 */
async function deepseekSearch(queryConfig, config, searchProvider, discoveredAt) {
  const apiKey = process.env[searchProvider.apiKeyEnv];
  if (!apiKey || noPaidSearch || !searchProvider.baseUrl) return [];
  const estimatedCny = Number(searchProvider.cnyPerThousand ?? 0) / 1000;
  const reservation = await reserveBudget(config, estimatedCny, {
    kind: "search-reservation",
    provider: "deepseek",
    queryId: queryConfig.id,
  });
  if (reservation.softLimitExceeded) {
    console.warn(`[budget] soft limit exceeded; running only configured bounded search.`);
  }
  try {
    const response = await fetchWithTimeout(
      searchProvider.baseUrl,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": config.collection.userAgent,
        },
        body: JSON.stringify({ query: queryConfig.query, count: 10 }),
      },
      config.collection.requestTimeoutMs,
    );
    const responseText = await readResponseText(response, 2_000_000);
    if (!response.ok) {
      const kind = classifySearchFailure(response.status, responseText);
      const error = new Error(`DeepSeek ${queryConfig.id}: HTTP ${response.status}`);
      error.code = kind === "quota"
        ? "search-quota"
        : kind === "rate-limit"
          ? "search-rate-limit"
          : "search-failed";
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error(`DeepSeek ${queryConfig.id}: response is not JSON.`);
    }
    const results = array(payload?.results)
      .map((result) => {
        const title = cleanText(result.title, 240);
        const resultUrl = canonicalUrl(result.url);
        if (!title) return null;
        try {
          strictHttpUrl(resultUrl, { allowHttp: true });
        } catch {
          return null;
        }
        const excerpt = cleanText(result.summary || result.snippet || result.content);
        const hostname = new URL(resultUrl).hostname.replace(/^www\./, "");
        if (matchesBlockedKeywords(`${title} ${excerpt ?? ""}`, config.toolDiscovery?.blockedKeywords)) {
          return null;
        }
        return {
          id: candidateId(resultUrl, title),
          title,
          url: resultUrl,
          excerpt,
          publishedAt: typeof result.date === "string" ? result.date : discoveredAt,
          discoveredAt,
          source: {
            id: `web-${hostname}`,
            name: cleanText(result.site_name || hostname, 180),
            url: `https://${hostname}/`,
            language: /[\u3400-\u9fff]/.test(`${title}${excerpt ?? ""}`) ? "zh-CN" : "en",
            trust: 0.55,
          },
          topicHint: queryConfig.topic,
          subtopicHint: queryConfig.subtopic,
          regionHint: queryConfig.subtopic === "disease-control"
            ? healthRegionFromText(`${title} ${excerpt ?? ""}`, config, queryConfig.region)
            : undefined,
          laneHint: queryConfig.lane,
          typeHint: queryConfig.type,
          discoveredBy: "deepseek",
          queryId: queryConfig.id,
          keywordDirections: queryConfig.id.startsWith("direction-")
            ? [queryConfig.id.slice("direction-".length)]
            : undefined,
        };
      })
      .filter(Boolean);
    await settleBudget(config, reservation, {
      at: discoveredAt,
      provider: "deepseek",
      kind: "search-request",
      units: 1,
      // 无结果不计费：DS 只对「HTTP 200 且有结果」的请求计费。
      estimatedCny: results.length > 0 ? estimatedCny : 0,
      queryId: queryConfig.id,
    });
    return results;
  } catch (error) {
    await settleBudget(config, reservation, {
      at: discoveredAt,
      provider: "deepseek",
      kind: "search-request-failed",
      units: 1,
      estimatedCny: 0,
      queryId: queryConfig.id,
      error: error instanceof Error ? error.message.slice(0, 240) : "unknown",
    });
    throw error;
  }
}

/** 按 provider 的 protocol 分派付费搜索；没写 protocol 的老配置按 brave 处理。 */
function paidSearch(queryConfig, config, searchProvider, discoveredAt) {
  return String(searchProvider?.protocol ?? "brave") === "deepseek"
    ? deepseekSearch(queryConfig, config, searchProvider, discoveredAt)
    : braveSearch(queryConfig, config, searchProvider, discoveredAt);
}

function isCompetitionCandidate(candidate) {
  const content = `${candidate.title ?? ""} ${candidate.excerpt ?? ""}`;
  return /\b(challenge|competition|contest|hackathon)\b|挑战赛|竞赛|比赛|黑客松/i.test(content);
}

function deduplicate(candidates) {
  const byUrl = new Map();
  const evergreenKeys = new Set();
  const titleKeys = new Set();
  const result = [];
  for (const candidate of candidates.sort((left, right) => right.discoveredAt.localeCompare(left.discoveredAt))) {
    const titleKey = candidate.title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 90);
    if (candidate.evergreen) {
      if (!candidate.evergreenKey || evergreenKeys.has(candidate.evergreenKey)) continue;
      evergreenKeys.add(candidate.evergreenKey);
    } else {
      if (byUrl.has(candidate.url)) continue;
      byUrl.set(candidate.url, candidate);
    }
    if (titleKey && titleKeys.has(titleKey)) continue;
    if (titleKey) titleKeys.add(titleKey);
    result.push(candidate);
  }
  return result;
}

const [config, providerConfig, preferences, evergreenCatalog] = await Promise.all([
  readConfig(),
  readProviderConfig(),
  readPreferences(),
  readJson(observatoryPaths.evergreen),
]);
const searchProvider = providerConfig.searchProviders[providerConfig.activeSearch];
const now = new Date();
const discoveredAt = now.toISOString();
const dateArgument = process.argv.find((argument) => argument.startsWith("--date="));
const date = dateArgument ? dateArgument.slice("--date=".length) : dateInTimeZone(now, config.timezone);
if (!isStrictCalendarDate(date)) throw new Error(`Invalid collection date: ${date}`);
const candidatePath = path.join(observatoryPaths.candidates, `${date}.json`);
const existing = await readJson(candidatePath, { schemaVersion: 1, date, items: [] });

const feedRuns = [];
const arxivFeeds = config.feeds.filter((feed) => feed.url.includes("arxiv.org"));
const otherFeeds = config.feeds.filter((feed) => !feed.url.includes("arxiv.org"));
const otherResults = await Promise.allSettled(
  otherFeeds.map((feed) => collectFeed(feed, config, preferences, discoveredAt)),
);
feedRuns.push(...otherResults.map((result, index) => ({ feed: otherFeeds[index], result })));
for (let index = 0; index < arxivFeeds.length; index += 1) {
  const feed = arxivFeeds[index];
  try {
    feedRuns.push({ feed, result: { status: "fulfilled", value: await collectFeed(feed, config, preferences, discoveredAt) } });
  } catch (reason) {
    feedRuns.push({ feed, result: { status: "rejected", reason } });
  }
  if (index < arxivFeeds.length - 1) await new Promise((resolve) => setTimeout(resolve, 3200));
}
const feedItems = [];
for (const { feed, result } of feedRuns) {
  if (result.status === "fulfilled") feedItems.push(...result.value);
  else console.warn(`[feed] ${feed.id}: ${result.reason?.message ?? result.reason}`);
}

const healthSources = config.healthSources ?? [];
const healthRuns = await Promise.allSettled(
  healthSources.map((source) => collectHealthSource(source, config, preferences, discoveredAt)),
);
const healthItems = [];
for (let index = 0; index < healthRuns.length; index += 1) {
  const result = healthRuns[index];
  if (result.status === "fulfilled") healthItems.push(...result.value);
  else console.warn(`[health] ${healthSources[index].id}: ${result.reason?.message ?? result.reason}`);
}

const evergreenItems = collectEvergreenCatalog(evergreenCatalog, discoveredAt);
let toolItems = [];
try {
  toolItems = await collectToolDiscovery(config, discoveredAt);
} catch (error) {
  console.warn(`[tool-discovery] ${error.message}`);
}
let weeklyItems = [];
try {
  weeklyItems = await collectWeeklyItems(config, discoveredAt);
} catch (error) {
  console.warn(`[weekly] ${error.message}`);
}
let keywordItems = [];
try {
  keywordItems = await collectKeywordDiscovery(config, discoveredAt);
} catch (error) {
  console.warn(`[keyword-discovery] ${error.message}`);
}

const searchItems = [];
/*
 * 搜索轮换池 = 常规查询 + 关键词方向自带的查询。
 * 前者回答「常规新闻」，后者回答「除了常规新闻我还要找哪些方向」——
 * 这正是关键词系统的第二个用途（第一个用途是 scoring.mjs 里的留存加权）。
 */
const directionQueries = (config.keywordSignals?.directions ?? [])
  .filter((direction) => direction?.searchQuery)
  .map((direction) => ({
    id: `direction-${direction.id}`,
    query: direction.searchQuery,
    topic: direction.topic,
    lane: "focus",
    type: direction.type ?? "news",
  }));
const searchQueryPool = [...(config.searchQueries ?? []), ...directionQueries];
/*
 * 搜索没配好时说清楚原因，而不是静默返回空数组 ——
 * 「关键词方向决定还要找哪些新闻」这条路完全依赖搜索，静默失效等于功能不存在。
 */
const searchKeyEnv = String(searchProvider.apiKeyEnv ?? "").trim();
const searchEnabled = Boolean(searchProvider.baseUrl && searchKeyEnv && process.env[searchKeyEnv] && !noPaidSearch);
const searchDisabledReason = !searchProvider.baseUrl
  ? `搜索来源「${searchProvider.label ?? providerConfig.activeSearch}」处于关闭状态（activeSearch=${providerConfig.activeSearch}）`
  : (!searchKeyEnv || !process.env[searchKeyEnv])
    ? `搜索来源「${searchProvider.label ?? providerConfig.activeSearch}」缺少密钥${searchKeyEnv ? `（${searchKeyEnv}）` : ""}`
    : noPaidSearch
      ? "本次运行带了 --no-paid-search"
      : "";
if (searchDisabledReason && directionQueries.length > 0) {
  console.warn(
    `[search] ${searchDisabledReason}，本次 ${searchQueryPool.length} 条查询（含 ${directionQueries.length} 条关键词方向）全部跳过；` +
      "依赖搜索的题材（视野之外、地缘政治等）会因此偏少。",
  );
}
const searchHealth = { requests: 0, failures: 0, rejected: 0, rateLimited: 0 };
if (searchProvider.baseUrl && process.env[searchProvider.apiKeyEnv] && !noPaidSearch && !dryRun) {
  const offset = Math.floor(now.getTime() / 3_600_000) % searchQueryPool.length;
  const queries = Array.from(
    { length: Math.min(config.collection.braveQueriesPerRun, config.generation.maximumPaidVerifications ?? Infinity, searchQueryPool.length) },
    (_, index) => searchQueryPool[(offset + index) % searchQueryPool.length],
  );
  for (const query of queries) {
    searchHealth.requests += 1;
    try {
      searchItems.push(...(await paidSearch(query, config, searchProvider, discoveredAt)));
    } catch (error) {
      searchHealth.failures += 1;
      if (error.code === "search-quota") searchHealth.rejected += 1;
      if (error.code === "search-rate-limit") searchHealth.rateLimited += 1;
      console.warn(`[search] ${query.id}: ${error.message}${error.code ? `（${error.code}）` : ""}`);
      /*
       * 额度到顶时继续问剩下的查询没有意义，还会把日志刷满；
       * 预算硬上限同理。其余失败（网络、单次限流）继续跑完剩下的查询。
       */
      if (error.code === "budget-hard-limit" || error.code === "search-quota") break;
    }
  }
  if (searchHealth.rejected > 0) {
    console.warn(
      `::warning title=Brave 搜索额度::${searchHealth.rejected}/${searchHealth.requests} 次请求被按额度拒绝；` +
        "本期搜索来源降级（出刊不受影响），请检查 Brave 控制台的月度用量与上限。",
    );
  }
}

const isFresh = (candidate) => {
  if (candidate.evergreen === true) return true;
  const maximumAgeHours = Number(candidate.maxAgeHours ?? config.collection.maxCandidateAgeHours);
  const minimumTime = now.getTime() - maximumAgeHours * 3_600_000;
  const published = Date.parse(candidate.publishedAt);
  return Number.isNaN(published)
    ? Date.parse(candidate.discoveredAt) >= minimumTime
    : published >= minimumTime;
};
const freshFeedItems = feedItems.filter(isFresh);
const freshHealthItems = healthItems.filter(isFresh);
const freshToolItems = toolItems.filter(isFresh);
const freshWeeklyItems = weeklyItems.filter(isFresh);
const freshKeywordItems = keywordItems.filter(isFresh);
const freshSearchItems = searchItems.filter(isFresh);

/*
 * 素材蒸馏：让 ai-tip / ai-know 每天从当天真实素材现提炼，常青目录退化为兜底。
 * 候选带每日唯一的 evergreenKey，所以「常青内容」不再是取一条少一条的消耗品；
 * 素材在提炼前已排除掉历史 evergreen 用过的来源 URL，能通过 verify 的全历史去重。
 * 提炼失败只降级为空数组，绝不让采集阶段整体失败。
 */
let distilledItems = [];
let distilledMaterialCount = 0;
if (config.skillDistillation?.enabled && (!dryRun || distillInDryRun)) {
  try {
    const [cookbookMaterials, recentDigest] = await Promise.all([
      collectCookbookMaterials(config, discoveredAt),
      readRecentDigest(date, config.skillDistillation.historyDays),
    ]);
    const materials = [
      // 工具素材排在前面：tool-pick 是必选栏目，缺它整期就生成不了，不能被 maximumMaterials 截掉。
      ...buildMaterialsFromCandidates(freshToolItems, config),
      ...buildMaterialsFromCandidates(freshFeedItems, config),
      ...cookbookMaterials,
    ];
    distilledMaterialCount = materials.length;
    distilledItems = await distillEvergreenCandidates(config, providerConfig, materials, {
      date,
      discoveredAt,
      recentTitles: recentDigest.titles,
      recentUrls: recentDigest.urls,
    });
  } catch (error) {
    console.warn(`[distill] ${error.message}`);
  }
}

const pool = deduplicate([
  ...existing.items,
  // 蒸馏候选是 evergreen（按 key 去重），与源素材的 url 去重互不干扰，
  // 放在这里只是与其它固定内容相邻，便于阅读。
  ...distilledItems,
  ...freshFeedItems,
  ...freshHealthItems,
  ...evergreenItems,
  ...freshToolItems,
  ...freshWeeklyItems,
  ...freshKeywordItems,
  ...freshSearchItems,
])
  .filter((candidate) => !isCompetitionCandidate(candidate))
  .filter((candidate) => candidate.subtopicHint !== "disease-control" || isAllowedHealthRegion(
    candidate.regionHint,
    config.healthPolicy?.allowedRegions,
  ))
  .filter((candidate) => preferences.sourceTrust?.[candidate.source.id] !== "blocked");

/*
 * 同题反查（corroboration）不在这里做。
 *
 * 2026-10-19 之前它在采集阶段挑种子反查，种子按「采集当时的排名」猜谁最可能入选；
 * 实测 10-18：猜出的种子过了 3.5 小时一条都没进短名单，25 次付费搜索全部落空，
 * 做出来的佐证候选还留在了池子里（其中一条的种子已被挤出池子，成了永远的孤儿）。
 * 现在改由 generate.mjs 在 selectCandidates() 之后对入选候选做定向反查——
 * 谁值得花这一次搜索，只有短名单定下来才知道。
 */

const items = deduplicate(pool)
  .filter((candidate) => !isCompetitionCandidate(candidate))
  .filter((candidate) => candidate.subtopicHint !== "disease-control" || isAllowedHealthRegion(
    candidate.regionHint,
    config.healthPolicy?.allowedRegions,
  ))
  .filter((candidate) => preferences.sourceTrust?.[candidate.source.id] !== "blocked")
  .slice(0, config.collection.maxCandidatesPerDay);

const document = {
  schemaVersion: 1,
  date,
  collectedAt: discoveredAt,
  expiresAt: new Date(now.getTime() + config.retentionDays * 86_400_000).toISOString(),
  items,
  stats: {
    existing: existing.items.length,
    feedFetched: feedItems.length,
    feedEligible: freshFeedItems.length,
    healthAdded: freshHealthItems.length,
    healthFailures: healthRuns.filter((result) => result.status === "rejected").length,
    evergreenAdded: evergreenItems.length,
    distilledMaterials: distilledMaterialCount,
    distilledAdded: distilledItems.length,
    toolDiscovered: freshToolItems.length,
    weeklyAdded: freshWeeklyItems.length,
    keywordDiscovered: freshKeywordItems.length,
    searchAdded: freshSearchItems.length,
    // 搜索健康度：额度用尽是静默降级，只有把计数留下来才查得到「哪天开始少了一半来源」。
    searchEnabled,
    searchRequests: searchHealth.requests,
    searchFailures: searchHealth.failures,
    searchRejected: searchHealth.rejected,
    searchRateLimited: searchHealth.rateLimited,
    // 反查的计数搬到了 generate 的输出里：种子从短名单产生，指标跟着那段流水线走。
    // 快照的 stats 只留采集侧的数字（控台按「数值键才收」解析，缺键不会判废整份快照）。
    total: items.length,
    feedFailures: feedRuns.filter(({ result }) => result.status === "rejected").length,
  },
};

if (!dryRun) {
  await writeJsonAtomic(candidatePath, document);
  await removeExpiredJson(observatoryPaths.candidates, config.retentionDays);
  await removeExpiredJson(observatoryPaths.previews, config.retentionDays);
}

console.log(JSON.stringify({ dryRun, date, ...document.stats }, null, 2));
if (items.length === 0 && feedRuns.every(({ result }) => result.status === "rejected")) {
  process.exitCode = 2;
}
