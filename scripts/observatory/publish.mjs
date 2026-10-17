import { promises as fs } from "node:fs";
import path from "node:path";
import { requiredDailyTypes } from "./ranking.mjs";
import { validateIssueDocument } from "./validate.mjs";
import {
  dateInTimeZone,
  isStrictCalendarDate,
  observatoryPaths,
  readConfig,
  readJson,
  withFileLock,
  writeJsonAtomic,
} from "./runtime.mjs";

async function issueFiles() {
  try {
    return (await fs.readdir(observatoryPaths.publicIssues)).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function requestedDate(config) {
  const argument = process.argv.find((entry) => entry.startsWith("--date="));
  const date = argument ? argument.slice("--date=".length) : dateInTimeZone(new Date(), config.timezone);
  if (!isStrictCalendarDate(date)) throw new Error(`Invalid publication date: ${date}`);
  return date;
}

const config = await readConfig();
const dryRun = process.argv.includes("--dry-run");
const now = new Date();
const date = requestedDate(config);
const updatedAt = now.toISOString();
const previewPath = path.join(observatoryPaths.previews, `${date}.json`);
const publicPath = path.join(observatoryPaths.publicIssues, `${date}.json`);
const statusPath = path.join(observatoryPaths.publicIssues, "_status.json");
const preview = await readJson(previewPath, null);

await withFileLock(`${publicPath}.lock`, async () => {
  if (!preview?.items?.length) {
    if (!dryRun) {
      await writeJsonAtomic(statusPath, {
        schemaVersion: 1,
        date,
        status: "delayed",
        updatedAt,
        message: "本期自动观测尚未完成，上一期内容保持可用。流水线将在后台重试。",
      });
    }
    console.error(`[publish] ${dryRun ? "would mark" : "marked"} ${date} as delayed; previous public issue remains unchanged.`);
    if (!dryRun) process.exitCode = 2;
    return;
  }

  if (preview.stage && preview.stage !== "final" && process.argv.includes("--require-final")) {
    throw new Error(`Preview for ${date} is ${preview.stage}, not final; refusing publication.`);
  }
  const files = await issueFiles();
  const existing = await readJson(publicPath, null);
  const status = preview.items.length < config.generation.minimumItems ? "quiet" : "published";
  const issue = {
    schemaVersion: 1,
    date,
    issueNumber: existing?.issueNumber ?? preview.issueNumber ?? files.length + 1,
    status,
    generatedAt: preview.generatedAt ?? updatedAt,
    updatedAt,
    sample: false,
    items: preview.items
      .slice(0, config.generation.maximumItems)
      .sort((left, right) => left.priority - right.priority)
      .map((item, index) => ({ ...item, priority: index + 1 })),
  };
  const requiredTypes = requiredDailyTypes(config, date);
  const validatedIssue = validateIssueDocument(issue, {
    source: publicPath,
    storage: "public",
    minimumItems: config.generation.minimumItems,
    requiredTypes,
    enforceCurrentPolicy: date >= String(config.editorialRules?.sourceDiversityActiveFrom ?? "9999-12-31"),
    editorialRules: config.editorialRules,
    healthPolicy: config.healthPolicy,
  });
  if (!dryRun) {
    await writeJsonAtomic(publicPath, validatedIssue);
    await writeJsonAtomic(statusPath, {
      schemaVersion: 1,
      date,
      status,
      updatedAt,
      message: status === "quiet" ? "今日达到可信门槛的信号较少，因此不补足固定条数。" : "本期已完成发布。",
    });
  }
  console.log(JSON.stringify({ dryRun, date, status, items: validatedIssue.items.length, target: publicPath }, null, 2));
});
