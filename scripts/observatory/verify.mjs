import { promises as fs } from "node:fs";
import path from "node:path";
import { sourceDiversityReport } from "./content-policy.mjs";
import { requiredDailyTypes } from "./ranking.mjs";
import { validateIssueDocument } from "./validate.mjs";
import {
  hasUnsafeHostname,
  isStrictCalendarDate,
  observatoryPaths,
  readConfig,
  readJson,
  readProviderConfig,
} from "./runtime.mjs";

const requireSecrets = process.argv.includes("--require-secrets");
const problems = [];
const warnings = [];

function problem(file, message) {
  problems.push(`${file}: ${message}`);
}

function warning(file, message) {
  warnings.push(`${file}: ${message}`);
}

async function files(directory, expression) {
  try {
    return (await fs.readdir(directory)).filter((file) => expression.test(file));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function parseFile(filePath, label, options = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && options.optional) return null;
    problem(label, `invalid JSON (${error.message})`);
    return null;
  }
}

let config;
let providerConfig;
try {
  [config, providerConfig] = await Promise.all([readConfig(), readProviderConfig()]);
} catch (error) {
  problem("configuration", error.message);
}

if (providerConfig) {
  const activeLlm = providerConfig.llmProviders[providerConfig.activeLlm];
  const activeSearch = providerConfig.searchProviders[providerConfig.activeSearch];
  if (requireSecrets && !process.env[activeLlm.apiKeyEnv]) problem("providers", `missing ${activeLlm.apiKeyEnv}`);
  if (requireSecrets && activeSearch.apiKeyEnv && !process.env[activeSearch.apiKeyEnv]) {
    problem("providers", `missing ${activeSearch.apiKeyEnv}`);
  }
  if (activeLlm.inputCnyPerMillion === null || activeLlm.outputCnyPerMillion === null) {
    warning("providers", `${providerConfig.activeLlm} has no token prices; generation stays blocked unless explicitly overridden`);
  }
  for (const [id, provider] of Object.entries(providerConfig.llmProviders)) {
    try {
      const endpoint = new URL(provider.baseUrl);
      const loopback = ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
      if (id === "custom" && hasUnsafeHostname(endpoint.hostname) && !loopback) problem("providers", `${id} targets a private host`);
    } catch (error) {
      problem("providers", `${id} has an invalid Base URL`);
    }
  }
}

if (config) {
  const evergreenKeys = new Set();
  const evergreenUrls = new Set();
  for (const file of (await files(observatoryPaths.publicIssues, /^\d{4}-\d{2}-\d{2}\.json$/)).sort()) {
    const filePath = path.join(observatoryPaths.publicIssues, file);
    const issue = await parseFile(filePath, file);
    if (!issue) continue;
    if (!isStrictCalendarDate(issue.date) || `${issue.date}.json` !== file) {
      problem(file, "filename and issue date must contain a real matching calendar date");
    }
    try {
      const requiredTypes = requiredDailyTypes(config, issue.date);
      const enforceCurrentPolicy = issue.date >= String(config.editorialRules?.sourceDiversityActiveFrom ?? "9999-12-31");
      const validated = validateIssueDocument(issue, {
        source: file,
        storage: "public",
        minimumItems: config.generation.minimumItems,
        requiredTypes,
        enforceCurrentPolicy,
        editorialRules: config.editorialRules,
        healthPolicy: config.healthPolicy,
      });
      if (!validated.sample && validated.items.length >= config.generation.minimumItems) {
        const focusCount = validated.items.filter((item) => item.lane === "focus").length;
        const ratio = focusCount / validated.items.length;
        if (
          ratio < config.generation.focusRatioMinimum - 0.04 ||
          ratio > config.generation.focusRatioMaximum + 0.08
        ) {
          warning(file, `focus ratio ${ratio.toFixed(2)} is outside the preferred range; publication remains valid when no suitable horizon signal is available`);
        }
        if (!enforceCurrentPolicy) {
          const diversity = sourceDiversityReport(validated.items, config.editorialRules);
          if (diversity.problems.length > 0) {
            warning(file, `legacy source concentration: ${diversity.problems.join(" ")}`);
          }
        }
      }
      for (const item of validated.items) {
        if (!validated.sample && /\b(challenge|competition|contest|hackathon)\b|挑战赛|竞赛|比赛|黑客松/i.test(`${item.title} ${item.summary} ${item.tags.join(" ")}`)) {
          problem(file, `${item.id}: competition content is excluded`);
        }
        if (item.evergreen) {
          if (evergreenKeys.has(item.evergreenKey)) problem(file, `${item.id}: duplicate evergreen key ${item.evergreenKey}`);
          evergreenKeys.add(item.evergreenKey);
          for (const source of item.sources) {
            if (evergreenUrls.has(source.url)) problem(file, `${item.id}: duplicate evergreen source URL ${source.url}`);
            evergreenUrls.add(source.url);
          }
        }
        if (!validated.sample && item.summary.length < config.generation.summaryMinimumCharacters - 10) {
          warning(file, `${item.id}: summary is shorter than the preferred range`);
        }
        if (!validated.sample && item.summary.length > config.generation.summaryMaximumCharacters + 20) {
          problem(file, `${item.id}: summary is longer than the preferred range`);
        }
      }
    } catch (error) {
      problem(file, error.message);
    }
  }

  for (const file of await files(observatoryPaths.previews, /^\d{4}-\d{2}-\d{2}\.json$/)) {
    const filePath = path.join(observatoryPaths.previews, file);
    const issue = await parseFile(filePath, `preview/${file}`);
    if (!issue) continue;
    try {
      const requiredTypes = requiredDailyTypes(config, issue.date);
      validateIssueDocument(issue, {
        source: `preview/${file}`,
        storage: "preview",
        minimumItems: config.generation.minimumItems,
        requiredTypes,
        enforceCurrentPolicy: issue.date >= String(config.editorialRules?.sourceDiversityActiveFrom ?? "9999-12-31"),
        editorialRules: config.editorialRules,
        healthPolicy: config.healthPolicy,
      });
    } catch (error) {
      problem(`preview/${file}`, error.message);
    }
  }

  const statusPath = path.join(observatoryPaths.publicIssues, "_status.json");
  const publicationStatus = await parseFile(statusPath, "content/daily/_status.json", { optional: true });
  if (publicationStatus) {
    if (publicationStatus.schemaVersion !== 1 || !isStrictCalendarDate(publicationStatus.date)) {
      problem("content/daily/_status.json", "status schema or date is invalid");
    }
    if (!new Set(["published", "delayed", "quiet"]).has(publicationStatus.status)) {
      problem("content/daily/_status.json", "status is invalid");
    }
  }

  for (const file of await files(observatoryPaths.usage, /^\d{4}-\d{2}\.json$/)) {
    const ledger = await parseFile(path.join(observatoryPaths.usage, file), `usage/${file}`);
    if (!ledger) continue;
    const total = Number(ledger.committedTotalCny ?? ledger.estimatedTotalCny ?? 0);
    const reserved = Array.isArray(ledger.reservations)
      ? ledger.reservations.reduce((sum, entry) => sum + Number(entry.amountCny ?? 0), 0)
      : 0;
    if (!Number.isFinite(total) || total < 0 || !Number.isFinite(reserved) || reserved < 0) {
      problem(`usage/${file}`, "cost totals must be finite and non-negative");
    } else if (total + reserved > config.budget.monthlyHardLimitCny) {
      problem(`usage/${file}`, `hard budget exceeded: ${(total + reserved).toFixed(2)} CNY`);
    } else if (total + reserved > config.budget.monthlySoftLimitCny) {
      warning(`usage/${file}`, `soft budget exceeded: ${(total + reserved).toFixed(2)} CNY`);
    }
  }
}

for (const message of warnings) console.warn(`[warn] ${message}`);
for (const message of problems) console.error(`[error] ${message}`);
console.log(JSON.stringify({ ok: problems.length === 0, problems: problems.length, warnings: warnings.length }, null, 2));
if (problems.length > 0) process.exitCode = 1;
