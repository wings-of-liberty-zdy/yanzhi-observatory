import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// 观测站只持有代码；配置、运行时数据与公开日报由 OBSERVATORY_ROOT 指向的那个仓库提供
// （2026-10-17 拆站第一步：默认仍是言志仓库，本仓库不复制 config/、data/、content/daily/，
// 避免出现第二份需要人工同步的副本——2026-10-08 的候选池判废事故就是副本分叉造成的）。
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// 解析顺序：真实环境变量 > 本仓库 .env.local 里的 OBSERVATORY_ROOT > 本仓库根。
// 相对路径一律按本仓库根解析而不是 cwd，所以 `../言志` 在本机和 CI 里含义一致。
if (!process.env.OBSERVATORY_ROOT) {
  const localEnvFile = path.join(repositoryRoot, ".env.local");
  if (existsSync(localEnvFile)) {
    const localEnv = dotenv.parse(readFileSync(localEnvFile));
    if (localEnv.OBSERVATORY_ROOT) process.env.OBSERVATORY_ROOT = localEnv.OBSERVATORY_ROOT;
  }
}

export const repositoryDir = repositoryRoot;
export const projectRoot = process.env.OBSERVATORY_ROOT
  ? path.resolve(repositoryRoot, process.env.OBSERVATORY_ROOT)
  : repositoryRoot;

// 业务数据的根在 projectRoot，API 密钥与采集参数继续读那个仓库的 .env.local（与拆分前一致）。
dotenv.config({ path: path.join(projectRoot, ".env.local"), quiet: true });

export const observatoryPaths = {
  config: path.join(projectRoot, "config", "observatory.json"),
  evergreen: path.join(projectRoot, "config", "observatory.evergreen.json"),
  providers: path.join(projectRoot, "config", "observatory.providers.json"),
  candidates: path.join(projectRoot, "data", "observatory", "candidates"),
  previews: path.join(projectRoot, "data", "observatory", "previews"),
  private: path.join(projectRoot, "data", "observatory", "private"),
  usage: path.join(projectRoot, "data", "observatory", "usage"),
  publicIssues: path.join(projectRoot, "content", "daily"),
};

const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function readConfig() {
  const config = await readJson(observatoryPaths.config);
  if (config?.schemaVersion !== 1) throw new Error("Unsupported observatory config schemaVersion.");
  if (!config.timezone || !config.topics || !config.generation || !config.budget) {
    throw new Error("Observatory config is missing required sections.");
  }
  const weights = Object.values(config.topics).map((topic) => Number(topic?.weight));
  if (weights.some((weight) => !Number.isInteger(weight) || weight < 0)) {
    throw new Error("Observatory topic weights must be non-negative integers that total 100.");
  }
  const topicWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (topicWeight !== 100) {
    throw new Error(`Observatory topic weights must total 100, got ${topicWeight}.`);
  }
  return config;
}

export async function readProviderConfig() {
  const config = await readJson(observatoryPaths.providers);
  if (config?.schemaVersion !== 1) throw new Error("Unsupported provider config schemaVersion.");
  if (!config.llmProviders?.[config.activeLlm]) throw new Error("Active LLM provider is not configured.");
  if (!config.searchProviders?.[config.activeSearch]) throw new Error("Active search provider is not configured.");
  const officialOrigins = {
    deepseek: "https://api.deepseek.com",
    openai: "https://api.openai.com",
    gemini: "https://generativelanguage.googleapis.com",
  };
  for (const [id, provider] of Object.entries(config.llmProviders)) {
    if (!["openai-compatible", "gemini"].includes(provider.protocol)) {
      throw new Error(`Unknown LLM protocol for provider ${id}.`);
    }
    if (typeof provider.model !== "string" || !provider.model.trim()) {
      throw new Error(`Provider ${id} has no model.`);
    }
    let endpoint;
    try {
      endpoint = new URL(provider.baseUrl);
    } catch {
      throw new Error(`Provider ${id} has an invalid Base URL.`);
    }
    const endpointHost = endpoint.hostname.replace(/^\[|\]$/g, "");
    const loopbackHttp = id === "custom" && endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(endpointHost);
    if (endpoint.username || endpoint.password || (endpoint.protocol !== "https:" && !loopbackHttp)) {
      throw new Error(`Provider ${id} has an unsafe Base URL.`);
    }
    if (officialOrigins[id] && endpoint.origin !== officialOrigins[id]) {
      throw new Error(`Provider ${id} must use its official origin.`);
    }
    if (id === "custom" && hasUnsafeHostname(endpointHost) && !["localhost", "127.0.0.1", "::1"].includes(endpointHost)) {
      throw new Error("Custom provider cannot target a private host.");
    }
    for (const field of ["inputCnyPerMillion", "outputCnyPerMillion"]) {
      if (provider[field] !== null && (!Number.isFinite(Number(provider[field])) || Number(provider[field]) < 0)) {
        throw new Error(`Provider ${id} has an invalid ${field}.`);
      }
    }
  }
  for (const [id, provider] of Object.entries(config.searchProviders)) {
    if (!provider.baseUrl) continue;
    let endpoint;
    try {
      endpoint = new URL(provider.baseUrl);
    } catch {
      throw new Error(`Search provider ${id} has an invalid Base URL.`);
    }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || hasUnsafeHostname(endpoint.hostname)) {
      throw new Error(`Search provider ${id} has an unsafe Base URL.`);
    }
  }
  return config;
}

export async function withFileLock(lockPath, operation, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const staleMs = options.staleMs ?? 120_000;
  const startedAt = Date.now();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  let acquired = false;
  while (!acquired) {
    try {
      await fs.mkdir(lockPath);
      acquired = true;
      await fs.writeFile(path.join(lockPath, "owner"), `${process.pid}\n`, "utf8");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) await fs.rm(lockPath, { recursive: true, force: true });
      } catch (statError) {
        if (statError.code !== "ENOENT") throw statError;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  try {
    return await operation();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(raw, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return { raw, version: sha256(raw) };
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function dateInTimeZone(date = new Date(), timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function monthInTimeZone(date = new Date(), timeZone = "Asia/Shanghai") {
  return dateInTimeZone(date, timeZone).slice(0, 7);
}

export function isStrictCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return date.getUTCFullYear() === Number(value.slice(0, 4)) &&
    date.getUTCMonth() + 1 === Number(value.slice(5, 7)) &&
    date.getUTCDate() === Number(value.slice(8, 10));
}

export function clampTimestampToCeiling(value, ceiling) {
  const limit = Date.parse(ceiling);
  if (Number.isNaN(limit)) throw new Error("Timestamp ceiling must be an ISO timestamp.");
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || parsed > limit) return ceiling;
  return value;
}

export function clampIssuePublishedAt(issue, ceiling = issue?.updatedAt) {
  if (!issue || typeof issue !== "object") return issue;
  return {
    ...issue,
    items: Array.isArray(issue.items)
      ? issue.items.map((item) => ({
          ...item,
          publishedAt: clampTimestampToCeiling(item.publishedAt, ceiling),
          sources: Array.isArray(item.sources)
            ? item.sources.map((source) => (
                source?.publishedAt
                  ? { ...source, publishedAt: clampTimestampToCeiling(source.publishedAt, ceiling) }
                  : source
              ))
            : item.sources,
        }))
      : issue.items,
  };
}

export function hasUnsafeHostname(hostname) {
  const normalized = String(hostname).toLowerCase().replace(/[\[\]]/g, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    (normalized.includes(":") && /^(fc|fd|fe80:)/i.test(normalized)) ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.") ||
    normalized.startsWith("169.254.")
  ) return true;
  const ipv4 = normalized.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const second = Number(ipv4[2]);
    if (Number(ipv4[1]) === 172 && second >= 16 && second <= 31) return true;
  }
  return false;
}

export function strictHttpUrl(raw, options = {}) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048 || controlCharacters.test(raw)) {
    throw new Error("URL is empty, too long, or contains unsafe control characters.");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL is invalid.");
  }
  const allowHttp = options.allowHttp === true;
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error("URL must use HTTPS.");
  }
  if (url.username || url.password) throw new Error("URL credentials are not allowed.");
  if (!options.allowPrivate && hasUnsafeHostname(url.hostname)) {
    throw new Error("Private or loopback URL hosts are not allowed.");
  }
  return url;
}

export function canonicalUrl(raw) {
  try {
    const url = strictHttpUrl(raw, { allowHttp: true });
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|spm$|from$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return String(raw ?? "");
  }
}

export function cleanText(raw, maximum = 700) {
  if (raw === undefined || raw === null) return "";
  return String(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(controlCharacters, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

export function candidateId(url, title) {
  return sha256(`${canonicalUrl(url)}\n${title.trim().toLocaleLowerCase()}`).slice(0, 20);
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

export async function readResponseText(response, maximumBytes = 2_000_000) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Response exceeds ${maximumBytes} bytes.`);
  }
  if (!response.body) {
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
      throw new Error(`Response exceeds ${maximumBytes} bytes.`);
    }
    return raw;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds ${maximumBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function readPreferences() {
  return readJson(path.join(observatoryPaths.private, "preferences.json"), {
    schemaVersion: 1,
    topicAdjustments: {},
    sourceTrust: {},
    trackedQuestions: [],
    actions: [],
  });
}

function ledgerDefaults(month) {
  return {
    schemaVersion: 1,
    month,
    currency: "CNY",
    committedTotalCny: 0,
    estimatedTotalCny: 0,
    reservedTotalCny: 0,
    reservations: [],
    events: [],
  };
}

function finiteCost(value) {
  const cost = Number(value ?? 0);
  if (!Number.isFinite(cost) || cost < 0) throw new Error("Usage cost must be a finite non-negative number.");
  return cost;
}

function normalizeLedger(raw, month) {
  const ledger = { ...ledgerDefaults(month), ...(raw && typeof raw === "object" ? raw : {}) };
  ledger.events = Array.isArray(ledger.events) ? ledger.events.slice(-3000) : [];
  ledger.reservations = Array.isArray(ledger.reservations)
    ? ledger.reservations.filter((entry) => Date.now() - Date.parse(entry.createdAt ?? 0) < 6 * 3_600_000)
    : [];
  const eventTotal = ledger.events.reduce((sum, entry) => sum + finiteCost(entry.estimatedCny), 0);
  const legacyTotal = finiteCost(ledger.estimatedTotalCny);
  ledger.committedTotalCny = Number.isFinite(Number(ledger.committedTotalCny))
    ? finiteCost(ledger.committedTotalCny)
    : Math.max(eventTotal, legacyTotal);
  ledger.estimatedTotalCny = ledger.committedTotalCny;
  ledger.reservedTotalCny = ledger.reservations.reduce((sum, entry) => sum + finiteCost(entry.amountCny), 0);
  ledger.schemaVersion = 1;
  ledger.month = month;
  return ledger;
}

async function readLedger(month) {
  return normalizeLedger(
    await readJson(path.join(observatoryPaths.usage, `${month}.json`), null),
    month,
  );
}

function usagePath(month) {
  return path.join(observatoryPaths.usage, `${month}.json`);
}

export async function recordUsage(config, event) {
  const month = monthInTimeZone(new Date(event.at ?? Date.now()), config.timezone);
  return withFileLock(`${usagePath(month)}.lock`, async () => {
    const ledger = await readLedger(month);
    const cost = finiteCost(event.estimatedCny);
    ledger.events.push({ ...event, estimatedCny: cost });
    ledger.events = ledger.events.slice(-3000);
    ledger.committedTotalCny = Number((ledger.committedTotalCny + cost).toFixed(6));
    ledger.estimatedTotalCny = ledger.committedTotalCny;
    ledger.reservedTotalCny = ledger.reservations.reduce((sum, entry) => sum + finiteCost(entry.amountCny), 0);
    ledger.updatedAt = new Date().toISOString();
    await writeJsonAtomic(usagePath(month), ledger);
    return ledger;
  });
}

export async function reserveBudget(config, amountCny, metadata = {}) {
  const amount = finiteCost(amountCny);
  const month = monthInTimeZone(new Date(), config.timezone);
  return withFileLock(`${usagePath(month)}.lock`, async () => {
    const ledger = await readLedger(month);
    const projected = ledger.committedTotalCny + ledger.reservedTotalCny + amount;
    if (projected > config.budget.monthlyHardLimitCny) {
      const error = new Error(
        `Monthly hard budget would be exceeded: ${projected.toFixed(2)} CNY > ${config.budget.monthlyHardLimitCny} CNY.`,
      );
      error.code = "budget-hard-limit";
      throw error;
    }
    const reservation = {
      id: `res-${randomBytes(10).toString("hex")}`,
      amountCny: amount,
      createdAt: new Date().toISOString(),
      ...metadata,
    };
    ledger.reservations.push(reservation);
    ledger.reservedTotalCny += amount;
    ledger.updatedAt = new Date().toISOString();
    await writeJsonAtomic(usagePath(month), ledger);
    return { ...reservation, month, projected, softLimitExceeded: projected > config.budget.monthlySoftLimitCny };
  });
}

export async function settleBudget(config, reservation, event) {
  if (!reservation?.id) return recordUsage(config, event);
  const month = reservation.month ?? monthInTimeZone(new Date(), config.timezone);
  return withFileLock(`${usagePath(month)}.lock`, async () => {
    const ledger = await readLedger(month);
    ledger.reservations = ledger.reservations.filter((entry) => entry.id !== reservation.id);
    ledger.reservedTotalCny = ledger.reservations.reduce((sum, entry) => sum + finiteCost(entry.amountCny), 0);
    const cost = finiteCost(event.estimatedCny);
    ledger.events.push({ ...event, estimatedCny: cost, reservationId: reservation.id });
    ledger.events = ledger.events.slice(-3000);
    ledger.committedTotalCny = Number((ledger.committedTotalCny + cost).toFixed(6));
    ledger.estimatedTotalCny = ledger.committedTotalCny;
    ledger.updatedAt = new Date().toISOString();
    await writeJsonAtomic(usagePath(month), ledger);
    return ledger;
  });
}

export async function assertBudget(config, estimatedAdditionalCny = 0) {
  const month = monthInTimeZone(new Date(), config.timezone);
  const ledger = await readLedger(month);
  const projected = ledger.committedTotalCny + ledger.reservedTotalCny + finiteCost(estimatedAdditionalCny);
  if (projected > config.budget.monthlyHardLimitCny) {
    const error = new Error(
      `Monthly hard budget would be exceeded: ${projected.toFixed(2)} CNY > ${config.budget.monthlyHardLimitCny} CNY.`,
    );
    error.code = "budget-hard-limit";
    throw error;
  }
  return { projected, softLimitExceeded: projected > config.budget.monthlySoftLimitCny };
}

export async function removeExpiredJson(directory, retentionDays) {
  let files = [];
  try {
    files = (await fs.readdir(directory)).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file));
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let removed = 0;
  for (const file of files) {
    const date = Date.parse(`${file.slice(0, 10)}T00:00:00Z`);
    if (date < cutoff) {
      await fs.rm(path.join(directory, file));
      removed += 1;
    }
  }
  return removed;
}
