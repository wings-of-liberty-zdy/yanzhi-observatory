import assert from "node:assert/strict";
import test from "node:test";
import { sourcePublishedAt } from "../scripts/observatory/publish-time.mjs";

test("只采信来源自报的发布时间：日期进、日期出，时分进、时分出", () => {
  assert.deepEqual(
    sourcePublishedAt("2026-10-23"),
    { publishedAt: "2026-10-23T00:00:00+08:00", publishedAtPrecision: "date" },
  );
  assert.deepEqual(
    sourcePublishedAt("2026-10-23T16:42:03-07:00"),
    { publishedAt: "2026-10-23T23:42:03.000Z", publishedAtPrecision: "minute" },
  );
  assert.deepEqual(
    sourcePublishedAt("Thu, 23 Oct 2026 19:25:01 +0800"),
    { publishedAt: "2026-10-23T11:25:01.000Z", publishedAtPrecision: "minute" },
  );
});

test("解析不出来的时间不会退化成采集时间", () => {
  assert.deepEqual(sourcePublishedAt(undefined), {});
  assert.deepEqual(sourcePublishedAt(""), {});
  assert.deepEqual(sourcePublishedAt("3 days ago"), {});
  assert.deepEqual(sourcePublishedAt({ date: "2026-10-23" }), {});
});
