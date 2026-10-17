import {
  countAcronyms,
  isAllowedHealthRegion,
  sourceDiversityReport,
} from "./content-policy.mjs";
import { hasUnsafeHostname, isStrictCalendarDate, strictHttpUrl } from "./runtime.mjs";

const lanes = new Set(["focus", "horizon"]);
const topics = new Set(["ai", "robotics", "postgraduate", "internship", "engineering", "geopolitics", "world"]);
const types = new Set(["news", "research", "release", "opportunity", "analysis", "ai-tip", "ai-know", "tool-pick"]);
const reviewStatuses = new Set(["automated", "confirmed", "rewritten"]);
const verificationStatuses = new Set(["multi-source", "single-source", "conflicting", "developing"]);
const issueStatuses = new Set(["preview", "published", "delayed", "quiet"]);
const publicStatuses = new Set(["published", "delayed", "quiet"]);
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

function fail(source, message) {
  throw Object.assign(new Error(`${source}: ${message}`), { status: 400, validation: true });
}

function stringValue(value, field, source, maximum = 2000, required = true) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim()) || value.length > maximum || controlCharacters.test(value)) {
    fail(source, `${field} must be a clean string of at most ${maximum} characters.`);
  }
  return value.trim();
}

function enumValue(value, allowed, field, source) {
  if (typeof value !== "string" || !allowed.has(value)) fail(source, `${field} has an unsupported value.`);
  return value;
}

function integerValue(value, field, source, maximum = 10_000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(source, `${field} must be a positive integer <= ${maximum}.`);
  return value;
}

function timestampValue(value, field, source) {
  const text = stringValue(value, field, source, 64);
  if (Number.isNaN(Date.parse(text))) fail(source, `${field} must be an ISO timestamp.`);
  return text;
}

function urlValue(value, field, source) {
  const text = stringValue(value, field, source, 2048);
  try {
    const url = strictHttpUrl(text, { allowHttp: true });
    if (hasUnsafeHostname(url.hostname)) fail(source, `${field} cannot target a private or loopback host.`);
  } catch (error) {
    fail(source, `${field} is invalid: ${error.message}`);
  }
  return text;
}

function validateSource(value, source, index, updatedAt) {
  const itemSource = `${source}.sources[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(itemSource, "must be an object.");
  const result = {
    id: stringValue(value.id, "id", itemSource, 120),
    name: stringValue(value.name, "name", itemSource, 180),
    url: urlValue(value.url, "url", itemSource),
    sourceKey: value.sourceKey === undefined ? undefined : stringValue(value.sourceKey, "sourceKey", itemSource, 160, false),
    publishedAt: value.publishedAt === undefined ? undefined : timestampValue(value.publishedAt, "publishedAt", itemSource),
    language: value.language === undefined ? undefined : stringValue(value.language, "language", itemSource, 32, false),
    primary: value.primary === true,
  };
  if (result.publishedAt && Date.parse(result.publishedAt) > Date.parse(updatedAt)) {
    fail(itemSource, "publishedAt cannot be later than issue updatedAt.");
  }
  return result;
}

function validateOpportunity(value, source, enforceCurrentPolicy = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(source, "opportunity must be an object.");
  const requirements = value.requirements;
  const responsibilities = value.responsibilities ?? [];
  if (!Array.isArray(requirements) || requirements.length > 20) fail(source, "requirements must be an array of at most 20 strings.");
  if (!Array.isArray(responsibilities) || responsibilities.length > 20) fail(source, "responsibilities must be an array of at most 20 strings.");
  const result = {
    mode: enumValue(value.mode, new Set(["observe", "apply"]), "mode", source),
    organization: value.organization === undefined ? undefined : stringValue(value.organization, "organization", source, 180, false),
    location: value.location === undefined ? undefined : stringValue(value.location, "location", source, 180, false),
    compensation: value.compensation === undefined ? undefined : stringValue(value.compensation, "compensation", source, 180, false),
    duration: value.duration === undefined ? undefined : stringValue(value.duration, "duration", source, 180, false),
    flexibility: value.flexibility === undefined ? undefined : stringValue(value.flexibility, "flexibility", source, 180, false),
    deadline: value.deadline === undefined ? undefined : stringValue(value.deadline, "deadline", source, 80, false),
    responsibilities: responsibilities.map((entry, index) => stringValue(entry, `responsibilities[${index}]`, source, 240)),
    requirements: requirements.map((entry, index) => stringValue(entry, `requirements[${index}]`, source, 240)),
  };
  if (enforceCurrentPolicy) {
    if (result.mode !== "observe") fail(source, "current policy only allows observe mode.");
    if (!result.location || !result.compensation || result.responsibilities.length === 0 || result.requirements.length === 0) {
      fail(source, "market observations require location, compensation, responsibilities, and skill requirements.");
    }
  }
  return result;
}

function validateHealthAdvice(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(source, "healthAdvice must be an object.");
  return {
    watchFor: stringValue(value.watchFor, "watchFor", source, 500),
    symptoms: stringValue(value.symptoms, "symptoms", source, 500),
    action: stringValue(value.action, "action", source, 500),
  };
}

export function validateNewsItem(value, source, updatedAt, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(source, "must be an object.");
  const id = stringValue(value.id, "id", source, 120);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(source, "id must use lowercase letters, numbers, and hyphens.");
  const summary = stringValue(value.summary, "summary", source, 500);
  if (
    options.enforceCurrentPolicy &&
    countAcronyms(summary) > Number(options.editorialRules?.maximumAcronymsPerSummary ?? 3)
  ) {
    fail(source, "summary contains too many Latin terms for the plain-language policy.");
  }
  const reason = stringValue(value.reason, "reason", source, 800);
  const question = stringValue(value.question, "question", source, 800);
  const publishedAt = timestampValue(value.publishedAt, "publishedAt", source);
  if (Date.parse(publishedAt) > Date.parse(updatedAt)) fail(source, "publishedAt cannot be later than issue updatedAt.");
  const sources = value.sources;
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 12) fail(source, "sources must contain 1-12 entries.");
  const normalizedSources = sources.map((entry, index) => validateSource(entry, source, index, updatedAt));
  if (new Set(normalizedSources.map((entry) => entry.id)).size !== normalizedSources.length) fail(source, "source ids must be unique.");
  if (new Set(normalizedSources.map((entry) => entry.url)).size !== normalizedSources.length) fail(source, "source URLs must be unique.");
  if (normalizedSources.filter((entry) => entry.primary).length !== 1) fail(source, "exactly one source must be primary.");
  if (value.verification === "multi-source") {
    const hosts = new Set(normalizedSources.map((entry) => new URL(entry.url).hostname));
    if (hosts.size < 2) fail(source, "multi-source status requires sources from at least two hosts.");
  }
  const tags = value.tags;
  if (!Array.isArray(tags) || tags.length > 12) fail(source, "tags must be an array of at most 12 strings.");
  const normalizedTags = tags.map((entry, index) => stringValue(entry, `tags[${index}]`, source, 80));
  if (value.reviewStatus === "automated" && /[我俺咱]/.test(`${reason}${question}`)) {
    fail(source, "automated personal fields cannot use first-person language.");
  }
  const type = enumValue(value.type, types, "type", source);
  if (type === "opportunity" && value.opportunity === undefined) fail(source, "opportunity items need opportunity details.");
  if (type === "ai-tip" || type === "ai-know" || type === "tool-pick") {
    if (value.evergreen !== true) fail(source, `${type} items must be marked evergreen.`);
    if (!value.evergreenKey) fail(source, `${type} items must include evergreenKey.`);
  }
  if (value.subtopic === "disease-control" && !value.region) {
    fail(source, "disease monitoring items must include a region.");
  }
  if (value.subtopic === "disease-control" && options.enforceCurrentPolicy) {
    if (!isAllowedHealthRegion(value.region, options.healthPolicy?.allowedRegions)) {
      fail(source, "disease monitoring region is outside the configured scope.");
    }
    if (!value.healthEvidence) fail(source, "disease monitoring items must include an evidence class.");
    if (!value.healthAdvice) fail(source, "disease monitoring items must include watch, symptom, and action advice.");
    if (value.healthEvidence === "risk-alert" && /已(?:经)?(?:暴发|爆发)|正在(?:暴发|爆发)/.test(`${value.title} ${summary}`)) {
      fail(source, "risk alerts cannot be rewritten as confirmed outbreaks.");
    }
  }
  return {
    id,
    title: stringValue(value.title, "title", source, 240),
    summary,
    publishedAt,
    lane: enumValue(value.lane, lanes, "lane", source),
    topic: enumValue(value.topic, topics, "topic", source),
    subtopic: value.subtopic === undefined ? undefined : stringValue(value.subtopic, "subtopic", source, 100, false),
    type,
    evergreen: value.evergreen === true,
    evergreenKey: value.evergreenKey === undefined ? undefined : stringValue(value.evergreenKey, "evergreenKey", source, 160, false),
    region: value.region === undefined ? undefined : stringValue(value.region, "region", source, 80, false),
    healthEvidence: value.healthEvidence === undefined
      ? undefined
      : enumValue(value.healthEvidence, new Set(["monitoring", "risk-alert", "monthly-report"]), "healthEvidence", source),
    healthAdvice: value.healthAdvice === undefined
      ? undefined
      : validateHealthAdvice(value.healthAdvice, `${source}.healthAdvice`),
    reviewStatus: enumValue(value.reviewStatus, reviewStatuses, "reviewStatus", source),
    verification: enumValue(value.verification, verificationStatuses, "verification", source),
    priority: integerValue(value.priority, "priority", source, 10_000),
    sources: normalizedSources,
    tags: normalizedTags,
    reason,
    question,
    opinion: value.opinion === undefined ? undefined : stringValue(value.opinion, "opinion", source, 1000, false),
    image: typeof value.image !== "string" || !value.image.trim()
      ? undefined
      : (value.image.startsWith("/")
        ? stringValue(value.image, "image", source, 2048)
        : urlValue(value.image, "image", source)),
    featured: value.featured === true,
    previousItemId: value.previousItemId === undefined ? undefined : stringValue(value.previousItemId, "previousItemId", source, 120, false),
    opportunity: value.opportunity === undefined
      ? undefined
      : validateOpportunity(value.opportunity, `${source}.opportunity`, options.enforceCurrentPolicy),
  };
}

export function validateIssueDocument(value, options = {}) {
  const source = options.source ?? "issue";
  const storage = options.storage ?? "public";
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(source, "must be an object.");
  if (value.schemaVersion !== 1) fail(source, "schemaVersion must be 1.");
  if (!isStrictCalendarDate(value.date)) fail(source, "date must be a real YYYY-MM-DD calendar date.");
  const updatedAt = timestampValue(value.updatedAt, "updatedAt", source);
  const generatedAt = timestampValue(value.generatedAt, "generatedAt", source);
  if (Date.parse(generatedAt) > Date.parse(updatedAt)) fail(source, "generatedAt cannot be later than updatedAt.");
  const status = enumValue(value.status, issueStatuses, "status", source);
  if (value.stage !== undefined) enumValue(value.stage, new Set(["midday", "final"]), "stage", source);
  if (storage === "preview" && status !== "preview") fail(source, "preview storage requires preview status.");
  if (storage === "public" && !publicStatuses.has(status)) fail(source, "public storage cannot use preview status.");
  if (!Array.isArray(value.items) || value.items.length > 0 && value.items.length > 100) fail(source, "items must contain at most 100 entries.");
  const items = value.items.map((item, index) => validateNewsItem(
    item,
    `${source}.items[${index}]`,
    updatedAt,
    options,
  ));
  if (new Set(items.map((item) => item.id)).size !== items.length) fail(source, "item ids must be unique.");
  if (items.filter((item) => item.featured).length > 1) fail(source, "at most one item may be featured.");
  if (items.filter((item) => item.type === "opportunity").length > 2) fail(source, "at most two opportunity items are allowed.");
  if (
    options.enforceCurrentPolicy &&
    items.filter((item) => item.subtopic === "disease-control").length > Number(options.healthPolicy?.maximumItemsPerIssue ?? 1)
  ) {
    fail(source, "too many disease monitoring items.");
  }
  if (options.enforceCurrentPolicy && items.length >= Number(options.minimumItems ?? 6)) {
    const diversity = sourceDiversityReport(items, options.editorialRules);
    if (diversity.problems.length > 0) fail(source, `source diversity failed: ${diversity.problems.join(" ")}`);
  }
  if (options.requiredTypes) {
    for (const requiredType of options.requiredTypes) {
      if (items.filter((item) => item.type === requiredType).length !== 1) {
        fail(source, `exactly one ${requiredType} item is required.`);
      }
    }
  }
  if (status === "published" && !value.sample && items.length < Number(options.minimumItems ?? 6)) {
    fail(source, "published issue below the minimum item count must use quiet status.");
  }
  return {
    schemaVersion: 1,
    date: value.date,
    issueNumber: integerValue(value.issueNumber, "issueNumber", source),
    status,
    generatedAt,
    updatedAt,
    sample: value.sample === true,
    ...(value.stage === undefined ? {} : { stage: value.stage }),
    items,
  };
}
