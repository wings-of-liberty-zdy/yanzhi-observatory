import assert from "node:assert/strict";
import test from "node:test";
import { clampIssuePublishedAt, clampTimestampToCeiling } from "../scripts/observatory/runtime.mjs";

test("future timestamps clamp down to the issue ceiling", () => {
  const ceiling = "2026-09-12T14:18:47.000Z";
  assert.equal(clampTimestampToCeiling("2026-09-12T14:18:18.000Z", ceiling), "2026-09-12T14:18:18.000Z");
  assert.equal(clampTimestampToCeiling("2026-09-12T14:18:56.000Z", ceiling), ceiling);
  assert.equal(clampTimestampToCeiling("not-a-date", ceiling), ceiling);
});

test("generated issues keep source clocks from beating updatedAt", () => {
  const ceiling = "2026-09-12T14:18:47.360Z";
  const issue = clampIssuePublishedAt({
    updatedAt: ceiling,
    items: [
      {
        id: "sig-tool",
        publishedAt: "2026-09-12T14:18:56.000Z",
        sources: [
          { id: "github", publishedAt: "2026-09-12T14:18:18.000Z" },
          { id: "fresh", publishedAt: "2026-09-12T14:19:01.000Z" },
        ],
      },
    ],
  }, ceiling);
  assert.equal(issue.items[0].publishedAt, ceiling);
  assert.equal(issue.items[0].sources[0].publishedAt, "2026-09-12T14:18:18.000Z");
  assert.equal(issue.items[0].sources[1].publishedAt, ceiling);
});
