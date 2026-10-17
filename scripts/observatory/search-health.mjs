import path from "node:path";
import { pathToFileURL } from "node:url";
import { isStrictCalendarDate, observatoryPaths, readJson } from "./runtime.mjs";

/**
 * 搜索通道健康度：让「Brave 额度用尽」这类静默降级变成看得见的信号。
 *
 * 背景：搜索失败在采集里是逐条 try/catch 的，只写一行 console.warn——
 * 引擎额度用完、密钥被停用、Plan 上限到顶，站点都只会「安静地少一半来源」，
 * 出刊不会失败，谁都不会发现。这里把当次采集的搜索计数读出来：
 *   - 工作流在最后一步跑本文件的 CLI，额度耗尽时以非零退出 → 触发既有的失败上报，开一张 GitHub issue；
 *   - 计数同时写进候选快照的 stats，私有分支逐日留存，事后可回看哪天开始降级。
 */

/** 额度类关键词：Brave 在额度用尽时未必给固定状态码，正文比状态码更可靠。 */
const quotaPattern = /quota|credit|subscription|payment|billing|usage limit|limit reached|exceeded/i;

/**
 * 区分三类失败，因为处置完全不同：
 *   - quota：本月额度/上限已到，继续问也没用，应该停下来并告警；
 *   - rate-limit：短时间问太快（免费档每秒 1 次），退避后还能继续；
 *   - other：网络或服务端问题，重试即可。
 */
export function classifySearchFailure(status, body) {
  const text = String(body ?? "").slice(0, 2000);
  if (status === 402) return "quota";
  if (status === 429 || status === 403) {
    return quotaPattern.test(text) ? "quota" : "rate-limit";
  }
  if (status === 401) return "unauthorized";
  return "other";
}

/**
 * 汇总一次采集的搜索健康度。ok=false 只表示「本期搜索来源整体失效」，
 * 与出刊无关：采集、生成、发布都会照常进行。
 */
export function searchStatusReport(document) {
  const stats = document?.stats ?? {};
  const requests = Number(stats.searchRequests ?? 0);
  const failures = Number(stats.searchFailures ?? 0);
  const rejected = Number(stats.searchRejected ?? 0);
  const rateLimited = Number(stats.searchRateLimited ?? 0);
  const added = Number(stats.searchAdded ?? 0);
  const enabled = stats.searchEnabled !== false;
  const summary = { date: document?.date ?? null, enabled, requests, added, failures, rejected, rateLimited };
  if (!enabled) return { ok: true, reason: "搜索来源未启用（无密钥或已关闭），不是故障。", ...summary };
  if (requests === 0) return { ok: true, reason: "本次没有发出搜索请求。", ...summary };
  if (rejected > 0) {
    return {
      ok: false,
      reason: `搜索额度告警：${rejected}/${requests} 次请求被引擎按额度拒绝（Plan 月度上限或信用已用尽），本期搜索来源整体降级。`,
      ...summary,
    };
  }
  if (failures >= requests) {
    return {
      ok: false,
      reason: `搜索全部失败：${failures}/${requests} 次请求未成功，且不是额度原因（检查密钥与网络）。`,
      ...summary,
    };
  }
  return { ok: true, reason: "搜索通道正常。", ...summary };
}

async function main() {
  const argument = process.argv.find((entry) => entry.startsWith("--date="));
  const date = argument?.slice("--date=".length);
  if (!isStrictCalendarDate(date)) throw new Error("--date=YYYY-MM-DD is required.");
  const candidatePath = path.join(observatoryPaths.candidates, `${date}.json`);
  const document = await readJson(candidatePath, null);
  const report = searchStatusReport(document);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    // 非零退出由工作流最后一步承接：那里失败不会挡住出刊，只会开一张告警 issue。
    console.error(`[search] ${report.reason}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await main();
