import { XMLParser } from "fast-xml-parser";
import { matchesBlockedKeywords } from "./content-policy.mjs";
import {
  candidateId,
  canonicalUrl,
  cleanText,
  fetchWithTimeout,
  readResponseText,
  reserveBudget,
  settleBudget,
  strictHttpUrl,
} from "./runtime.mjs";

/**
 * 同题反查（corroboration）：让「多源一致」这件事有材料可用。
 *
 * 为什么需要它：核验标签的判定是「这条目的 sources 里有没有 ≥2 个不同站点」
 * （validate.mjs 的 multi-source 闸门）。观测站此前的采集全是「发现式」的——
 * 每个源只交自己的稿件，网页搜索按主题词返回各不相同的页面，
 * 于是候选池里几乎不存在「同一件事被第二家报道」的成对候选，
 * 265/269 条日报只能落在 single-source（详见 2026-10-06 诊断）。
 *
 * 这里的做法是反过来问：已经选出的种子候选，还有谁报道了同一件事？
 * 三个通道里两个免密钥（Hacker News Algolia、Google News RSS），
 * 一个走已配置的网页搜索（Brave / DeepSeek，按次计费）。
 * 命中结果不单独成条，只作为种子的 corroboration 挂在它旁边进提示词，
 * 由模型确认是否真是同一件事、要不要一并引用。
 *
 * 调用时机（2026-10-19 起）：在 generate.mjs 里、selectCandidates() 之后。
 * 「谁值得反查」这件事只有短名单定下来才知道；放在采集阶段等于拿几小时前的猜测
 * 去花搜索额度（见 selectCorroborationSeeds 的说明）。
 */

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  trimValues: true,
  processEntities: false,
});

/**
 * 判据用的停用词：这些词几乎任何两篇技术报道都会共享，
 * 留着会让「OpenAI 模型指南」和「Anaconda 部署指南」被判成同一事件（实测误判）。
 * 年份单列在正则里过滤。
 */
const tokenStopwords = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "over", "more", "most",
  "new", "says", "said", "will", "can", "has", "have", "are", "was", "were", "its",
  "their", "than", "then", "also", "after", "before", "about", "how", "why", "what",
  "when", "who", "you", "your", "our", "not", "but", "all", "any", "may", "now",
  "guide", "best", "top", "list", "home", "news", "update", "updates", "official",
  "video", "podcast", "review", "reviews", "via", "using", "use", "get", "gets",
  "make", "makes", "made", "just", "only", "some", "other", "others", "these",
  "those", "year", "years", "first", "next", "last", "week", "month", "day",
  "today", "yesterday", "release", "releases", "released", "launch", "launches",
]);

const listPagePattern =
  /(^|\/)(index|home|archive|tag|tags|category|categories|search|feed|rss|about|contact)(\.\w+)?$/i;
/**
 * 榜单/教程/合集页也不是报道。实测里最大的假阳性来源就是这类页面：
 * 「The Best Open-Source LLMs in 2026」会在五个站点各写一遍，
 * 标题指纹看起来像同一件事，其实只是同一个话题。
 */
const roundupSegmentPattern =
  /(^|\/)(best|top|list|lists|guide|guides|roundup|review|reviews|collection|ranking|rankings)([-_/.]|$)/i;

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * 标题指纹：拉丁词按字母切（顺手拆开 open-weight 这类连字符词），中文按连续两字切片。
 * 用切片而不是分词，是因为中文没有词边界，而事件标题以短句为主。
 */
export function titleTokens(value) {
  const text = String(value ?? "").toLowerCase();
  const latin = (text.match(/[a-z][a-z0-9]*/g) ?? [])
    .filter((token) => token.length >= 3 && !tokenStopwords.has(token) && !/^(19|20)\d{2}$/.test(token));
  const characters = [...text.replace(/[^\u3400-\u9fff]/g, "")];
  const bigrams = [];
  for (let index = 0; index + 1 < characters.length; index += 1) {
    bigrams.push(characters[index] + characters[index + 1]);
  }
  return new Set([...latin, ...bigrams]);
}

export function titleOverlap(leftTitle, rightTitle) {
  const left = titleTokens(leftTitle);
  const right = titleTokens(rightTitle);
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return { shared, score: union === 0 ? 0 : shared / union };
}

/** 列表页/首页/榜单页不是「一条报道」，反查与种子挑选都要挡掉。 */
export function isListingUrl(url) {
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, "");
    if (!pathname) return true;
    return listPagePattern.test(pathname) || roundupSegmentPattern.test(pathname);
  } catch {
    return true;
  }
}

/**
 * 同一事件的判据。两个条件同时成立才算命中：
 *   1. 共享的特征词不少于 minimumSharedTokens（默认 3）——门槛太低会撞上同一话题的榜单文；
 *   2. 指纹相似度不低于 minimumScore（默认 0.2）。
 * 站点必须不同：同一家媒体的两条不算交叉核验。
 */
export function isLikelySameEvent(seed, entry, options = {}) {
  const minimumShared = Math.max(1, Number(options.minimumSharedTokens ?? 3));
  const minimumScore = Number(options.minimumScore ?? 0.2);
  if (!seed?.title || !entry?.title || !entry?.url) return false;
  const seedHost = hostOf(seed.url);
  const entryHost = hostOf(entry.url);
  if (!seedHost || !entryHost || seedHost === entryHost) return false;
  if (isListingUrl(entry.url)) return false;
  const overlap = titleOverlap(seed.title, entry.title);
  return overlap.shared >= minimumShared && overlap.score >= minimumScore;
}

/** 中文标题按原句检索（中文没有词边界，切词反而降召回）；拉丁标题取开头最少的几个特征词。 */
export function buildSearchQuery(seed, options = {}) {
  const title = String(seed?.title ?? "").trim();
  const cjkCharacters = title.replace(/[^\u3400-\u9fff]/g, "").length;
  if (cjkCharacters >= 6 && cjkCharacters >= title.length * 0.4) {
    return { language: "zh", query: title.replace(/[|｜]/g, " ").slice(0, Number(options.maximumQueryCharacters ?? 40)).trim() };
  }
  /*
   * 只用开头两个特征词，不按长度排序：Algolia 是「多词取交集」，
   * 四个词（例如 parameter mistral dubbed weight）必然零命中——实测 2026-10-06 云端首跑就是这么空手的。
   * 标题开头的词通常是主语（Mistral / Anduril / OpenAI），比最长的词更能召回，也更稳。
   */
  const terms = [...titleTokens(title)]
    .filter((token) => /^[a-z]/.test(token))
    .slice(0, Math.max(1, Number(options.maximumLatinTerms ?? 2)));
  return { language: "en", query: terms.join(" ") || title.slice(0, 80) };
}

export function toCorroborationCandidate(seed, entry, channel, discoveredAt, config) {
  const url = canonicalUrl(entry.url);
  const host = hostOf(url);
  const language = entry.language ?? buildSearchQuery(seed).language;
  return {
    id: candidateId(url, entry.title),
    title: cleanText(entry.title, 240),
    url,
    excerpt: cleanText(
      entry.excerpt || `同题反查（${channel.label}）命中：${seed.title}`,
      700,
    ),
    publishedAt: entry.publishedAt ?? discoveredAt,
    discoveredAt,
    source: {
      id: `web-${host}`,
      name: cleanText(entry.sourceName || host, 180),
      url: `https://${host}/`,
      language: language === "zh" ? "zh-CN" : "en",
      // 反查命中的是「第二家报道」，可信度按普通网页对待，不冒充实名来源。
      trust: Number(config?.corroboration?.trust ?? 0.6),
    },
    topicHint: seed.topicHint,
    subtopicHint: seed.subtopicHint,
    regionHint: seed.regionHint,
    healthEvidence: seed.healthEvidence,
    laneHint: seed.laneHint,
    typeHint: seed.typeHint,
    keywordDirections: seed.keywordDirections,
    corroboratesSeed: seed.id,
    discoveredBy: `corroboration-${channel.id}`,
  };
}

/**
 * 反查种子＝今晚真会进模型的那份短名单本身。
 *
 * 2026-10-19 之前这里吃的是整个候选池，按采集当时的排名自己猜「谁最可能入选」。
 * 实测 10-18：猜出来的种子过了 3.5 小时一条都不在出刊短名单里（有一条甚至已经被
 * 行上限 300 条挤出池子），25 次搜索全部落空。所以现在由 generate.mjs 在
 * selectCandidates() 之后调用——种子与短名单同源，也就不会再有「佐证挂在一个
 * 已不在池中的种子名下」这种孤儿。
 *
 * 两点讲究照旧：
 *   1. 常青栏目（ai-tip / ai-know / tool-pick）不需要第二来源，也查不到同题报道；
 *   2. 按主题轮流取，避免单个主题吃掉全部额度。短名单本身已经做过来源平衡，
 *      这里只是最后一道保险，所以默认上限放宽到 2（1 会让同题集中的一天用不满额度）。
 */
export function selectCorroborationSeeds(shortlist, config) {
  const settings = config?.corroboration ?? {};
  const maximum = Math.max(0, Number(settings.maximumSeeds ?? 5));
  if (settings.enabled !== true || maximum === 0) return [];
  const minimumTitleCharacters = Math.max(1, Number(settings.minimumTitleCharacters ?? 12));
  const perTopicCap = Math.max(1, Number(settings.maximumSeedsPerTopic ?? 2));
  const eligible = (shortlist ?? [])
    .filter((candidate) => candidate.evergreen !== true)
    .filter((candidate) => String(candidate.title ?? "").trim().length >= minimumTitleCharacters)
    .filter((candidate) => !isListingUrl(candidate.url));
  const seeds = [];
  const taken = new Set();
  const counts = new Map();
  /*
   * 按主题轮流取：第 round 轮取每个主题的第 round+1 条。
   * taken 不能省——内层每次都从 eligible 头部重扫，没有它第二轮会把第一轮取过的
   * 那条再取一遍（perTopicCap 为 1 时看不出来，改成 2 就成了重复种子）。
   */
  for (let round = 0; round < perTopicCap && seeds.length < maximum; round += 1) {
    for (const candidate of eligible) {
      if (seeds.length >= maximum) break;
      if (taken.has(candidate)) continue;
      const topic = String(candidate.topicHint ?? "unknown");
      const count = counts.get(topic) ?? 0;
      if (count > round) continue;
      taken.add(candidate);
      counts.set(topic, count + 1);
      seeds.push(candidate);
    }
  }
  return seeds;
}

function googleNewsItems(parsed) {
  const items = parsed?.rss?.channel?.item;
  return Array.isArray(items) ? items : items ? [items] : [];
}

function textOf(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return textOf(value[0]);
  if (typeof value === "object") return textOf(value["#text"] ?? value.__cdata ?? value.value);
  return "";
}

/**
 * Google News RSS 的 item.link 指向 news.google.com 的跳转地址，不是媒体原文。
 * 能用的只有 description 里指向媒体的 <a href>；拿不到就别要这条，
 * 因为「同名来源 + 首页链接」比没有来源更糟。
 */
export function parseGoogleNewsFeed(xml) {
  const parsed = xmlParser.parse(String(xml ?? ""));
  return googleNewsItems(parsed)
    .map((item) => {
      const title = cleanText(textOf(item.title), 240);
      const rawMarkup = typeof item.description === "string"
        ? item.description
        : String(item.description?.["#text"] ?? "");
      /*
       * processEntities 关着，所以 &lt;a href="..."&gt; 这类转义文本要自己还原，
       * 否则既取不到媒体原文链接，摘要里也会露出一串 HTML 源码。
       */
      const markup = rawMarkup
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&");
      const publisherLink = (markup.match(/href="([^"]+)"/gi) ?? [])
        .map((match) => match.slice(6, -1))
        .find((href) => !/news\.google\.com/i.test(href));
      const rawPublished = textOf(item.pubDate);
      return {
        title,
        url: publisherLink ?? "",
        excerpt: cleanText(markup, 200),
        publishedAt: Number.isNaN(Date.parse(rawPublished)) ? undefined : new Date(rawPublished).toISOString(),
        sourceName: cleanText(textOf(item.source), 120),
      };
    })
    .filter((entry) => entry.title && entry.url);
}

async function readJsonResponse(response, label, maximumBytes = 2_000_000) {
  const raw = await readResponseText(response, maximumBytes);
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label}: response is not JSON.`);
  }
}

/** 通道一：Hacker News Algolia。免密钥、对机房 IP 友好，但只覆盖英文技术话题。 */
async function searchHackerNews(seed, config, options) {
  const settings = config?.corroboration?.channels?.hackernews ?? {};
  if (settings.enabled !== true) return [];
  const { language, query } = buildSearchQuery(seed, settings);
  // 返回 null 表示「这条种子不适用」而不是「问过了没结果」——两种情况在统计里要分开。
  if (language !== "en" || !query) return null;
  const url = new URL(settings.endpoint ?? "https://hn.algolia.com/api/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("tags", "story");
  url.searchParams.set("hitsPerPage", String(Math.max(1, Number(settings.perPage ?? 5))));
  const maximumAgeDays = Number(settings.maximumAgeDays ?? 7);
  const since = Math.floor((Date.parse(options.discoveredAt) - maximumAgeDays * 86_400_000) / 1000);
  url.searchParams.set("numericFilters", `created_at_i>${since}`);
  const response = await fetchWithTimeout(
    url,
    {
      redirect: "error",
      headers: { Accept: "application/json", "User-Agent": config.collection.userAgent },
    },
    config.collection.requestTimeoutMs,
  );
  const payload = await readJsonResponse(response, `HN corroboration ${seed.id}`);
  return (Array.isArray(payload.hits) ? payload.hits : [])
    .filter((hit) => hit?.title && hit?.url)
    .map((hit) => ({
      title: hit.title,
      url: hit.url,
      excerpt: `Hacker News 讨论（${Number(hit.points ?? 0)} 分）：${hit.title}`,
      publishedAt: hit.created_at,
    }));
}

/** 通道二：Google News RSS。免密钥，但中国大陆网络不可达；CI 上是否可用需要实测。 */
async function searchGoogleNews(seed, config, options) {
  const settings = config?.corroboration?.channels?.googlenews ?? {};
  if (settings.enabled !== true) return [];
  const { language, query } = buildSearchQuery(seed, settings);
  if (!query) return null;
  const url = new URL(settings.endpoint ?? "https://news.google.com/rss/search");
  url.searchParams.set("q", query);
  const locale = language === "zh"
    ? { hl: "zh-CN", gl: "CN", ceid: "CN:zh-Hans" }
    : { hl: "en-US", gl: "US", ceid: "US:en" };
  for (const [key, value] of Object.entries(locale)) url.searchParams.set(key, value);
  const response = await fetchWithTimeout(
    url,
    {
      redirect: "error",
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        "User-Agent": config.collection.userAgent,
      },
    },
    config.collection.requestTimeoutMs,
  );
  const raw = await readResponseText(response, 2_000_000);
  if (!response.ok) throw new Error(`Google News corroboration ${seed.id}: HTTP ${response.status}`);
  if (!/^\s*</.test(raw)) throw new Error(`Google News corroboration ${seed.id}: response is not XML.`);
  const entries = parseGoogleNewsFeed(raw);
  if (entries.length === 0) {
    /*
     * 0 条时把结构打出来：2026-10-06 云端实测是「返回了合法 RSS、1KB 到 126KB 都有，但一条都没取出来」，
     * 只看字节数分不清是空 feed、还是条目的链接形态变了（媒体原文链接可能已经不在 feed 里）。
     */
    const itemCount = (raw.match(/<item[\s>]/g) ?? []).length;
    const firstItem = (raw.match(/<item[\s\S]{0,400}/) ?? [""])[0].replace(/\s+/g, " ");
    const publisherHrefs = (raw.match(/href="([^"]+)"/gi) ?? []).filter((href) => !/news\.google\.com/i.test(href)).length;
    console.warn(
      `[corroboration] Google 新闻 ${seed.id}: ${raw.length} 字节、<item> ${itemCount} 个、非 Google 链接 ${publisherHrefs} 条；` +
        `首条：${firstItem.slice(0, 300)}`,
    );
  }
  return entries;
}

/**
 * 复核通道可以单独配一把密钥：<PROVIDER>_SEARCH_CORROB_API_KEY。
 *
 * 为什么：复核和发现是两笔账。发现要站点多样性（Brave 强），复核要判据
 * （DeepSeek 的 summary/authority/rerank_score 直接可用）。两家混用一把 key 时
 * 「复核用另一个账户的额度」这件事做不到，只能整站换 key。
 *
 * 没配专属密钥时回退到主搜索那把 —— 老部署不用改任何东西。
 */
function corroborationKey(searchProvider) {
  const name = String(searchProvider?.apiKeyEnv ?? "");
  if (!name) return "";
  const dedicated = name.replace(/_API_KEY$/, "_CORROB_API_KEY");
  return process.env[dedicated] || process.env[name] || "";
}

/** 通道三：网页搜索（Brave）。额度紧，默认关闭。
 * 打开后每次唤醒多花 corroboration.braveQueriesPerRun 次搜索额度，
 * 2026-02 起 Brave 免费版是按月 $5 信用（约 1000 次），开着要盯用量。
 */
async function searchWebProvider(seed, config, searchProvider, options) {
  const settings = config?.corroboration?.channels?.brave ?? {};
  const apiKey = corroborationKey(searchProvider);
  if (!apiKey || !searchProvider.baseUrl) return [];
  const { query } = buildSearchQuery(seed, settings);
  if (!query) return null;
  const estimatedCny = (Number(config.budget?.braveSearchUsdPerThousand ?? 0) / 1000) * Number(config.budget?.usdToCny ?? 7.2);
  const reservation = await reserveBudget(config, estimatedCny, {
    kind: "search-reservation",
    provider: "brave",
    purpose: "corroboration",
    seedId: seed.id,
  });
  const label = `Brave corroboration ${seed.id}`;
  try {
    const url = new URL(searchProvider.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.max(1, Number(settings.perPage ?? 10))));
    url.searchParams.set("search_lang", /[\u3400-\u9fff]/.test(query) ? "zh-hans" : "en");
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
    const payload = await readJsonResponse(response, label);
    await settleBudget(config, reservation, {
      at: options.discoveredAt,
      provider: "brave",
      kind: "search-request",
      purpose: "corroboration",
      units: 1,
      estimatedCny,
      seedId: seed.id,
    });
    return (Array.isArray(payload?.web?.results) ? payload.web.results : [])
      .filter((result) => result?.title && result?.url)
      .map((result) => ({
        title: result.title,
        url: result.url,
        excerpt: cleanText(result.description, 400),
        sourceName: cleanText(result.profile?.long_name || hostOf(result.url), 180),
        // Brave 的 page_age 是 ISO 时间；没有就交给上游按发现时间处理。
        publishedAt: typeof result.page_age === "string" ? result.page_age : undefined,
      }));
  } catch (error) {
    await settleBudget(config, reservation, {
      at: options.discoveredAt,
      provider: "brave",
      kind: "search-request-failed",
      purpose: "corroboration",
      units: 1,
      estimatedCny,
      seedId: seed.id,
      error: error instanceof Error ? error.message.slice(0, 240) : "unknown",
    });
    throw error;
  }
}

/**
 * 通道四：DeepSeek Search —— 复核专用。
 *
 * 2026-10-17 实测的响应形状：`{results:[{title, url, site_name, summary, snippet,
 * content, authority(0-4), rerank_score, date}]}`，POST + Bearer，没有 usage 字段。
 * 计费口径是「5 元 / 1000 次成功请求，无结果不计费」——所以空手而归记 0 元，
 * 正对得上反查这种高失手率的负载。
 *
 * 分工的理由（见 memory/2026-10-16-DeepSeek搜索API与Brave对比.md）：
 * 发现的命门是站点多样性（Brave 自建索引更强），复核要的是「第二家报道」的判据
 * （DS 一次给 summary + authority + rerank_score，省掉再抓一次页面）。
 */
async function searchDeepSeek(seed, config, searchProvider, options) {
  const settings = config?.corroboration?.channels?.deepseek ?? {};
  if (!searchProvider?.baseUrl) return null;
  const apiKey = corroborationKey(searchProvider);
  if (!apiKey) return null;
  const { language, query } = buildSearchQuery(seed, settings);
  if (!query) return null;
  const perRequestCny = Number(searchProvider.cnyPerThousand ?? 0) / 1000;
  const reservation = await reserveBudget(config, perRequestCny, {
    kind: "search-reservation",
    provider: "deepseek",
    purpose: "corroboration",
    seedId: seed.id,
  });
  const label = `DeepSeek corroboration ${seed.id}`;
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
        body: JSON.stringify({ query, count: Math.max(1, Number(settings.perPage ?? 8)) }),
      },
      config.collection.requestTimeoutMs,
    );
    const payload = await readJsonResponse(response, label);
    const entries = (Array.isArray(payload?.results) ? payload.results : [])
      .filter((result) => result?.title && result?.url)
      .map((result) => ({
        title: result.title,
        url: result.url,
        excerpt: cleanText(result.summary || result.snippet || result.content, 700),
        sourceName: cleanText(result.site_name || hostOf(result.url), 180),
        publishedAt: typeof result.date === "string" ? result.date : undefined,
        language,
      }));
    await settleBudget(config, reservation, {
      at: options.discoveredAt,
      provider: "deepseek",
      kind: "search-request",
      purpose: "corroboration",
      units: 1,
      estimatedCny: entries.length > 0 ? perRequestCny : 0,
      seedId: seed.id,
    });
    return entries;
  } catch (error) {
    await settleBudget(config, reservation, {
      at: options.discoveredAt,
      provider: "deepseek",
      kind: "search-request-failed",
      purpose: "corroboration",
      units: 1,
      estimatedCny: 0,
      seedId: seed.id,
      error: error instanceof Error ? error.message.slice(0, 240) : "unknown",
    });
    throw error;
  }
}

async function searchChannel(channel, seed, config, providers, options, corroborationProvider) {
  if (channel.id === "hackernews") return searchHackerNews(seed, config, options);
  if (channel.id === "googlenews") return searchGoogleNews(seed, config, options);
  if (channel.id === "paid") {
    if (!corroborationProvider) return [];
    return corroborationProvider.protocol === "deepseek"
      ? searchDeepSeek(seed, config, corroborationProvider, options)
      : searchWebProvider(seed, config, corroborationProvider, options);
  }
  if (channel.id === "web") return searchWebProvider(seed, config, providers.brave, options);
  if (channel.id === "deepseek") return searchDeepSeek(seed, config, providers.byId[channel.providerId], options);
  return [];
}

/**
 * 对一批种子做同题反查，返回可以并入候选池的佐证候选，以及各通道的取数与命中数。
 *
 * 为什么要返回通道统计：2026-10-06 云端首跑时「0 命中、且没有任何报错」——
 * 光看日志分不清是「通道取回 0 条」还是「取回了但没匹配上」，这两种情况的下一步完全不同。
 */
export async function collectCorroborations(input) {
  const { seeds, config, providerConfig, discoveredAt, knownUrls } = input;
  const settings = config?.corroboration ?? {};
  // paidQueries 单独记一笔：调用方（generate 的日志与 --dry-run 输出）要靠它说清
  // 「这次免费跑到了什么程度」，不能把免密钥通道的请求也算成花钱。
  const stats = { seeds: seeds.length, channels: {}, matches: 0, paidQueries: 0 };
  if (settings.enabled !== true || seeds.length === 0) return { matches: [], stats };
  const searchProviders = providerConfig?.searchProviders ?? {};
  const corroborationId = String(providerConfig?.activeCorroborationSearch ?? "").trim();
  const corroborationProvider = corroborationId ? searchProviders[corroborationId] : null;
  const providers = {
    active: searchProviders[providerConfig?.activeSearch],
    // web 通道固定用 Brave 服务商，不跟主搜索走：两条通道请求形状不同
    // （Brave 是 GET + X-Subscription-Token + web.results，DeepSeek 是 POST + Bearer + results），
    // 拿主搜索的 provider 去发另一种形状的请求只会 4xx。主搜索切走时保留 Brave 通道的能力。
    brave: searchProviders.brave ?? searchProviders[providerConfig?.activeSearch],
    byId: searchProviders,
  };
  /*
   * 复核搜索与主搜索平级：配了 activeCorroborationSearch 就只跑那一家
   * （额度按它的协议从同名通道配置里取），没配则保持旧行为
   * （web + deepseek 两条通道各看自己的 enabled）。
   */
  const channels = [
    { id: "hackernews", configKey: "hackernews", label: "Hacker News" },
    { id: "googlenews", configKey: "googlenews", label: "Google 新闻" },
  ];
  if (corroborationProvider) {
    const configKey = corroborationProvider.protocol === "deepseek" ? "deepseek" : "brave";
    channels.push({
      id: "paid",
      configKey,
      label: `${corroborationProvider.label ?? corroborationId}（复核）`,
      metered: true,
    });
  } else {
    channels.push(
      { id: "web", configKey: "brave", label: "网页搜索", metered: true },
      { id: "deepseek", configKey: "deepseek", label: "DeepSeek 搜索", providerId: "deepseek", metered: true },
    );
  }
  const metered = new Set(channels.filter((channel) => channel.metered).map((channel) => channel.id));
  const maximumMatchesPerSeed = Math.max(1, Number(settings.maximumMatchesPerSeed ?? 2));
  const seenUrls = new Set(knownUrls ?? []);
  const matches = [];
  // 每个付费通道各自计额度：Brave 与 DeepSeek 互不占用对方的上限。
  const searchesUsed = new Map();
  for (const seed of seeds) {
    for (const channel of channels) {
      // 关闭的通道不进统计：统计里的 queries 必须等于真实发出的请求数。
      // paid 通道不受 channels.enabled 限制：activeCorroborationSearch 本身就是选择。
      if (channel.id !== "paid" && settings.channels?.[channel.configKey]?.enabled !== true) continue;
      if (metered.has(channel.id)) {
        // 付费搜索按次计费，不能每个种子都花一次：每个通道只给排在最前面的几个种子用。
        const used = searchesUsed.get(channel.id) ?? 0;
        const maximumSearches = Math.max(0, Number(settings.channels?.[channel.configKey]?.maximumSearchesPerRun ?? 2));
        if (used >= maximumSearches) continue;
        searchesUsed.set(channel.id, used + 1);
      }
      const channelStat = stats.channels[channel.id] ?? { queries: 0, skipped: 0, results: 0, matched: 0, failures: 0 };
      stats.channels[channel.id] = channelStat;
      let results;
      try {
        results = await searchChannel(channel, seed, config, providers, { discoveredAt }, corroborationProvider);
      } catch (error) {
        channelStat.queries += 1;
        channelStat.failures += 1;
        if (metered.has(channel.id)) stats.paidQueries += 1;
        console.warn(`[corroboration] ${channel.label} ${seed.id}: ${error.message}`);
        continue;
      }
      // null＝这条种子对该通道不适用（例如中文标题走不了 Hacker News），不计入请求数。
      if (results === null) {
        channelStat.skipped += 1;
        continue;
      }
      channelStat.queries += 1;
      if (metered.has(channel.id)) stats.paidQueries += 1;
      channelStat.results += results.length;
      let accepted = 0;
      for (const entry of results) {
        if (accepted >= maximumMatchesPerSeed) break;
        if (!isLikelySameEvent(seed, entry, settings)) continue;
        if (matchesBlockedKeywords(`${entry.title} ${entry.excerpt ?? ""}`, config.toolDiscovery?.blockedKeywords)) continue;
        let candidate;
        try {
          candidate = toCorroborationCandidate(seed, entry, channel, discoveredAt, config);
          strictHttpUrl(candidate.url, { allowHttp: true });
        } catch {
          continue;
        }
        if (seenUrls.has(candidate.url)) continue;
        seenUrls.add(candidate.url);
        matches.push(candidate);
        channelStat.matched += 1;
        accepted += 1;
      }
    }
  }
  stats.matches = matches.length;
  console.log(
    `[corroboration] 种子 ${stats.seeds} 条；` +
      Object.entries(stats.channels)
        .map(([id, stat]) =>
          `${id} 查询 ${stat.queries} / 跳过 ${stat.skipped} / 取回 ${stat.results} / 失败 ${stat.failures} / 命中 ${stat.matched}`)
        .join("；") +
      `；新增佐证候选 ${matches.length} 条；付费请求 ${stats.paidQueries} 次`,
  );
  return { matches, stats };
}
