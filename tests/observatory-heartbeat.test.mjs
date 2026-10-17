import assert from "node:assert/strict";
import test from "node:test";
import worker, { dispatchObservatory } from "../workers/observatory-heartbeat.mjs";

function fakeFetch(handler) {
  return async (url, options) => {
    assert.match(String(url), /api\.github\.com\/repos\/owner\/repo\/actions\/workflows\/observatory\.yml\/dispatches$/);
    assert.equal(options.method, "POST");
    return handler(options);
  };
}

test("heartbeat dispatch posts a workflow_dispatch and accepts 204", async () => {
  let body = null;
  let authorization = null;
  const result = await dispatchObservatory(
    { GH_REPOSITORY: "owner/repo", GH_DISPATCH_TOKEN: "token-value" },
    fakeFetch((options) => {
      body = JSON.parse(options.body);
      authorization = options.headers.Authorization;
      return new Response(null, { status: 204 });
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(body, { ref: "main", inputs: { mode: "next-action" } });
  assert.equal(authorization, "Bearer token-value");
});

test("heartbeat dispatch reports GitHub failures without throwing", async () => {
  const result = await dispatchObservatory(
    { GH_REPOSITORY: "owner/repo", GH_DISPATCH_TOKEN: "token-value" },
    fakeFetch(() => new Response('{"message":"Bad credentials"}', { status: 401 })),
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.message, /401/);
});

test("heartbeat dispatch never calls GitHub without configuration", async () => {
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    return new Response(null, { status: 204 });
  };
  const missingToken = await dispatchObservatory({ GH_REPOSITORY: "owner/repo" }, fetchImpl);
  const badRepository = await dispatchObservatory({ GH_REPOSITORY: "not a repo", GH_DISPATCH_TOKEN: "t" }, fetchImpl);
  assert.equal(missingToken.ok, false);
  assert.equal(badRepository.ok, false);
  assert.equal(calls.length, 0);
});

test("scheduled handler reports the cron trigger through waitUntil", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => new Response(null, { status: 204 }));
  const pending = [];
  try {
    worker.scheduled(
      { cron: "17 0 * * *" },
      { GH_REPOSITORY: "owner/repo", GH_DISPATCH_TOKEN: "token-value" },
      { waitUntil: (promise) => pending.push(promise) },
    );
    assert.equal(pending.length, 1);
    await Promise.all(pending);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch triggers the API route and rejects other paths", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => new Response(null, { status: 204 }));
  try {
    const env = { GH_REPOSITORY: "owner/repo", GH_DISPATCH_TOKEN: "token-value" };
    const api = await worker.fetch(new Request("https://example.com/api/heartbeat"), env);
    assert.equal(api.status, 200);
    assert.equal((await api.json()).ok, true);
    const other = await worker.fetch(new Request("https://example.com/daily/"), env);
    assert.equal(other.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
