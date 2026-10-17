export const workflowFileName = "observatory.yml";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function repositoryFrom(env) {
  const value = String(env.GH_REPOSITORY ?? "").trim();
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : null;
}

/**
 * Trigger the observatory workflow. The workflow itself decides what to do, so this
 * stays a dumb, idempotent kick: repeated calls never publish twice.
 */
export async function dispatchObservatory(env, fetchImpl = fetch) {
  const repository = repositoryFrom(env);
  const token = String(env.GH_DISPATCH_TOKEN ?? "").trim();
  if (!repository) return { ok: false, status: 500, message: "GH_REPOSITORY is missing or invalid." };
  if (!token) return { ok: false, status: 500, message: "GH_DISPATCH_TOKEN is not configured." };

  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${repository}/actions/workflows/${workflowFileName}/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "yanzhi-observatory-trigger",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ref: "main", inputs: { mode: "next-action" } }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (error) {
    return {
      ok: false,
      status: 502,
      message: error instanceof Error ? error.message : "GitHub dispatch request failed.",
    };
  }

  if (response.status === 204) {
    return { ok: true, status: 204, message: `Dispatched ${repository} ${workflowFileName}.` };
  }
  const detail = (await response.text().catch(() => "")).slice(0, 200);
  return {
    ok: false,
    status: response.status,
    message: `GitHub returned ${response.status}. ${detail}`.trim(),
  };
}

export default {
  async scheduled(event, env, context) {
    context.waitUntil(
      dispatchObservatory(env).then((result) => {
        if (result.ok) {
          console.log(`[heartbeat] ${event.cron ?? "manual"} -> ${result.message}`);
        } else {
          console.error(`[heartbeat] ${event.cron ?? "manual"} -> ${result.message}`);
        }
      }),
    );
  },

  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== "/api/heartbeat") return new Response("Not found", { status: 404 });
    const result = await dispatchObservatory(env);
    return jsonResponse(result.ok ? 200 : result.status === 500 ? 500 : 502, result);
  },
};
