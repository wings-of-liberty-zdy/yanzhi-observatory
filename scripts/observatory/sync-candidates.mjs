import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  isStrictCalendarDate,
  observatoryPaths,
  readConfig,
  readJson,
} from "./runtime.mjs";

const githubApi = "https://api.github.com";
const defaultBranch = "observatory-candidates";

function requiredEnvironment(name, env = process.env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required to sync candidate snapshots.`);
  return value;
}

/**
 * 候选快照写进的是言志仓库的私有分支，而不是跑脚本的这个仓库。GitHub Actions 会自动注入
 * `GITHUB_REPOSITORY=<当前仓库>`，拆站后直接读它会把候选池写错地方，所以显式的
 * `OBSERVATORY_GITHUB_REPOSITORY`（与 .env.local 里的同名键一致）优先。
 */
function targetRepository() {
  const explicit = process.env.OBSERVATORY_GITHUB_REPOSITORY?.trim();
  if (explicit) return explicit;
  return requiredEnvironment("GITHUB_REPOSITORY");
}

function validateRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("GITHUB_REPOSITORY must be an owner/repository pair.");
  }
  return value;
}

function validateBranch(value) {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes("..") || value.endsWith("/")) {
    throw new Error("Candidate snapshot branch is invalid.");
  }
  return value;
}

async function githubRequest(endpoint, token, options = {}) {
  const response = await fetch(`${githubApi}${endpoint}`, {
    ...options,
    signal: AbortSignal.timeout(20_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "yanzhi-observatory",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`GitHub returned invalid JSON for ${endpoint}.`);
    }
  }
  if (!response.ok && response.status !== 404) {
    const message = String(payload?.message ?? response.statusText).slice(0, 240);
    const error = new Error(`GitHub ${response.status}: ${message}`);
    error.status = response.status;
    throw error;
  }
  return { response, payload };
}

async function branchHead(repository, branch, token) {
  const endpoint = `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`;
  const { response, payload } = await githubRequest(endpoint, token);
  return response.status === 404 ? null : payload.object.sha;
}

function branchConflict(error) {
  if ([409, 422].includes(error.status)) error.code = "candidate-branch-conflict";
  return error;
}

async function createBlob(repository, content, token) {
  const { payload } = await githubRequest(`/repos/${repository}/git/blobs`, token, {
    method: "POST",
    body: JSON.stringify({
      content: Buffer.from(content, "utf8").toString("base64"),
      encoding: "base64",
    }),
  });
  return payload.sha;
}

async function expiredSnapshotEntries(repository, headSha, date, retentionDays, token) {
  const cutoff = new Date(`${date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - Math.max(0, Math.floor(retentionDays) - 1));
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const { payload } = await githubRequest(
    `/repos/${repository}/git/trees/${headSha}?recursive=1`,
    token,
  );
  return (payload.tree ?? [])
    .filter((entry) => /^snapshots\/\d{4}-\d{2}-\d{2}\.json$/.test(entry.path))
    .filter((entry) => path.posix.basename(entry.path, ".json") < cutoffDate)
    .map((entry) => ({ path: entry.path, mode: "100644", type: "blob", sha: null }));
}

export function emptyWindowState() {
  return { schemaVersion: 1, date: "", windows: [] };
}

export function normalizeWindowState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const accepted = state.schemaVersion === 1 && isStrictCalendarDate(state.date) && Array.isArray(state.windows);
  return {
    state: {
      schemaVersion: 1,
      date: accepted ? state.date : "",
      windows: accepted
        ? [...new Set(state.windows.filter((index) => Number.isSafeInteger(index) && index >= 0))].sort((left, right) => left - right)
        : [],
    },
    accepted,
  };
}

export function nextCollectionWindow(windowState, today, windowIndex) {
  const { state } = normalizeWindowState(windowState);
  if (state.date === today) {
    const next = state.windows.find((index) => index > windowIndex);
    return next === undefined ? null : next;
  }
  return state.date < today ? 0 : null;
}

/**
 * 把窗口状态响应体规整成状态对象。
 *
 * 注意这里是读过线上事故的地方：githubRequest 已经把响应体 JSON.parse 过，
 * raw+json 拿到的也是**对象**而不是字符串。旧实现写的是
 * `if (typeof payload !== "string") return emptyWindowState()`，
 * 于是永远返回空状态，「这个窗口已经采集过」的判据从不生效 ——
 * 每个 4 小时窗口内的每次心跳都会重复采集（2026-10-06 实测 13 次，设计值 4 次），
 * Brave 搜索请求量因此是设计值的约 3 倍。所以两种形态都要接受。
 */
export function windowStateFromPayload(payload) {
  let parsed = payload;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return emptyWindowState();
    }
  }
  if (!parsed || typeof parsed !== "object") return emptyWindowState();
  const { state, accepted } = normalizeWindowState(parsed);
  return accepted ? state : emptyWindowState();
}

export async function readWindowState(repository, branch, token) {
  const endpoint = `/repos/${repository}/contents/window-state.json?ref=${encodeURIComponent(branch)}`;
  const { response, payload } = await githubRequest(endpoint, token, {
    headers: { Accept: "application/vnd.github.raw+json" },
  });
  // 状态文件不存在或读不出内容时按「今天还没采过」处理：宁可多采一次，也不要漏采。
  if (response.status === 404) return emptyWindowState();
  return windowStateFromPayload(payload);
}

function windowStateDocument(windowState, date, windowIndex) {
  const { state } = normalizeWindowState(windowState);
  if (state.date === date) {
    return {
      schemaVersion: 1,
      date,
      windows: [...new Set([...state.windows, windowIndex])].sort((left, right) => left - right),
    };
  }
  return { schemaVersion: 1, date, windows: [windowIndex] };
}

async function syncCandidateSnapshotAttempt({
  date,
  repository,
  token,
  branch = defaultBranch,
  candidateDocument,
  retentionDays = 30,
  windowIndex = null,
  windowState = null,
}) {
  if (!isStrictCalendarDate(date)) throw new Error(`Invalid candidate snapshot date: ${date}`);
  validateRepository(repository);
  validateBranch(branch);
  if (candidateDocument?.schemaVersion !== 1 || candidateDocument.date !== date || !Array.isArray(candidateDocument.items)) {
    throw new Error("Candidate snapshot does not match the requested date or schema.");
  }
  if (windowIndex !== null && !Number.isSafeInteger(windowIndex)) {
    throw new Error("Candidate sync window index must be a non-negative integer.");
  }

  const headSha = await branchHead(repository, branch, token);
  let baseTreeSha = null;
  let expired = [];
  if (headSha) {
    const { payload: headCommit } = await githubRequest(
      `/repos/${repository}/git/commits/${headSha}`,
      token,
    );
    baseTreeSha = headCommit.tree.sha;
    expired = await expiredSnapshotEntries(repository, baseTreeSha, date, retentionDays, token);
  }

  const serialized = `${JSON.stringify(candidateDocument, null, 2)}\n`;
  const blobSha = await createBlob(repository, serialized, token);
  const treeEntries = [
    ...expired,
    { path: `snapshots/${date}.json`, mode: "100644", type: "blob", sha: blobSha },
    { path: "latest.json", mode: "100644", type: "blob", sha: blobSha },
  ];
  if (windowIndex !== null) {
    const stateRaw = `${JSON.stringify(windowStateDocument(windowState, date, windowIndex), null, 2)}\n`;
    treeEntries.push({
      path: "window-state.json",
      mode: "100644",
      type: "blob",
      sha: await createBlob(repository, stateRaw, token),
    });
  }
  const treeBody = baseTreeSha ? { base_tree: baseTreeSha, tree: treeEntries } : { tree: treeEntries };
  const { payload: tree } = await githubRequest(`/repos/${repository}/git/trees`, token, {
    method: "POST",
    body: JSON.stringify(treeBody),
  });
  const { payload: commit } = await githubRequest(`/repos/${repository}/git/commits`, token, {
    method: "POST",
    body: JSON.stringify({
      message: `chore(observatory): sync candidates ${date}`,
      tree: tree.sha,
      parents: headSha ? [headSha] : [],
    }),
  });
  if (headSha) {
    try {
      await githubRequest(
        `/repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`,
        token,
        {
          method: "PATCH",
          body: JSON.stringify({ sha: commit.sha, force: false }),
        },
      );
    } catch (error) {
      throw branchConflict(error);
    }
  } else {
    try {
      await githubRequest(`/repos/${repository}/git/refs`, token, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
      });
    } catch (error) {
      throw branchConflict(error);
    }
  }
  return {
    repository,
    branch,
    date,
    items: candidateDocument.items.length,
    collectedAt: candidateDocument.collectedAt,
    commit: commit.sha,
    removedExpired: expired.length,
    windowIndex,
  };
}

export async function syncCandidateSnapshot(options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await syncCandidateSnapshotAttempt(options);
    } catch (error) {
      lastError = error;
      if (error.code !== "candidate-branch-conflict" || attempt === 3) throw error;
      console.warn(`[candidate-sync] branch moved during attempt ${attempt}; retrying from the latest head.`);
    }
  }
  throw lastError;
}

async function main() {
  const config = await readConfig();
  const argument = process.argv.find((entry) => entry.startsWith("--date="));
  const date = argument?.slice("--date=".length);
  if (!isStrictCalendarDate(date)) throw new Error("--date=YYYY-MM-DD is required.");
  const windowArgument = process.argv.find((entry) => entry.startsWith("--window="));
  const windowIndex = windowArgument ? Number(windowArgument.slice("--window=".length)) : null;
  if (windowIndex !== null && (!Number.isSafeInteger(windowIndex) || windowIndex < 0)) {
    throw new Error("--window must be a non-negative integer.");
  }
  const repository = targetRepository();
  const token = requiredEnvironment("GITHUB_TOKEN");
  const branch = process.env.OBSERVATORY_CANDIDATE_BRANCH?.trim() || defaultBranch;
  const candidatePath = path.join(observatoryPaths.candidates, `${date}.json`);
  const candidateDocument = await readJson(candidatePath);
  const windowState = windowIndex === null ? null : await readWindowState(repository, branch, token);
  const result = await syncCandidateSnapshot({
    date,
    repository,
    token,
    branch,
    candidateDocument,
    retentionDays: Number(config.retentionDays ?? 30),
    windowIndex,
    windowState,
  });
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await main();
