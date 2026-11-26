/**
 * 发布时间归一：只采信来源自己写的发布时间，并标出精度；解析不出来就返回空对象。
 *
 * 2026-10-25 起，采集时间（discoveredAt）不再写进 publishedAt：
 * 页面上的那枚时间必须是「这条消息真实发生的时间」。来源没给时间就留空，
 * 由前端显示「时间未标注」，而不是拿抓取时间冒充。
 *
 * 只有日期（2026-10-23）的来源按北京零点落地并记 precision=date，前端只显示日期；
 * 带时分的记 precision=minute。
 */
export function sourcePublishedAt(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { publishedAt: `${raw}T00:00:00+08:00`, publishedAtPrecision: "date" };
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return {};
  return { publishedAt: new Date(parsed).toISOString(), publishedAtPrecision: "minute" };
}
