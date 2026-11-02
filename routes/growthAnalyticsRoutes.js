const express = require("express");
const router = express.Router();
const ClickEvent = require("../models/ClickEvent");
const QRCode = require("../models/QRCode");
const ShortLink = require("../models/ShortLink");
const CtaUrl = require("../models/CtaUrl");
const WidgetConfig = require("../models/WidgetConfig");
const authMiddleware = require("../middleware/auth");
const { getUserId, oid } = require("../utils/track");

const RANGES = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "365d": 365 };
const ENG = { event: { $in: ["click", "lead"] } }; // counted as an engagement
const TYPES = ["qr", "shortlink", "cta", "widget"];

const safeTz = (tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { return "UTC"; } };
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : a ? 100 : 0);
const top = (field, limit = 8) => [
  { $match: ENG }, { $group: { _id: `$${field}`, value: { $sum: 1 } } }, { $sort: { value: -1 } }, { $limit: limit },
];
const named = (rows, fallback = "Unknown") => rows.map((r) => ({ name: r._id || fallback, value: r.value }));

async function buildReport(match, { range, tz }) {
  const days = RANGES[range] || 30;
  const now = new Date();
  const from = new Date(now.getTime() - days * 86400000);
  const prevFrom = new Date(from.getTime() - days * 86400000);
  const base = { ...match, createdAt: { $gte: from } };
  const grain = days === 1 ? "%Y-%m-%dT%H:00" : "%Y-%m-%d";

  const [r] = await ClickEvent.aggregate([
    { $match: base },
    { $facet: {
      totals: [{ $match: ENG }, { $group: { _id: null, clicks: { $sum: 1 } } }],
      unique: [{ $match: ENG }, { $group: { _id: "$visitor" } }, { $count: "n" }],
      byType: [{ $match: ENG }, { $group: { _id: "$type", value: { $sum: 1 } } }],
      funnel: [{ $match: { type: "widget" } }, { $group: { _id: "$event", value: { $sum: 1 } } }],
      daily: [{ $match: ENG }, { $group: { _id: { d: { $dateToString: { format: grain, date: "$createdAt", timezone: tz } }, t: "$type" }, n: { $sum: 1 } } }],
      hourly: [{ $match: ENG }, { $group: { _id: { $hour: { date: "$createdAt", timezone: tz } }, value: { $sum: 1 } } }],
      weekday: [{ $match: ENG }, { $group: { _id: { $dayOfWeek: { date: "$createdAt", timezone: tz } }, value: { $sum: 1 } } }],
      devices: top("device"), os: top("os"), browsers: top("browser"), countries: top("country", 10), referrers: top("referrer"),
      pages: [{ $match: { type: "widget", event: "impression", page: { $ne: "" } } }, { $group: { _id: "$page", value: { $sum: 1 } } }, { $sort: { value: -1 } }, { $limit: 8 }],
      topItems: [
        { $match: ENG },
        { $group: { _id: { t: "$type", id: "$refId" }, title: { $max: "$refTitle" }, clicks: { $sum: 1 }, visitors: { $addToSet: "$visitor" }, last: { $max: "$createdAt" } } },
        { $project: { type: "$_id.t", refId: "$_id.id", title: 1, clicks: 1, unique: { $size: "$visitors" }, last: 1, _id: 0 } },
        { $sort: { clicks: -1 } }, { $limit: 10 },
      ],
      recent: [
        { $match: ENG }, { $sort: { createdAt: -1 } }, { $limit: 15 },
        { $project: { type: 1, refTitle: 1, device: 1, os: 1, browser: 1, country: 1, referrer: 1, createdAt: 1, event: 1 } },
      ],
    } },
  ]);

  const prevClicks = await ClickEvent.countDocuments({ ...match, ...ENG, createdAt: { $gte: prevFrom, $lt: from } });
  const clicks = r.totals[0]?.clicks || 0;

  // zero-filled series
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: days === 1 ? "2-digit" : undefined, hourCycle: "h23" });
  const keyOf = (t) => {
    const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]));
    return days === 1 ? `${p.year}-${p.month}-${p.day}T${p.hour}:00` : `${p.year}-${p.month}-${p.day}`;
  };
  const step = days === 1 ? 3600000 : 86400000;
  const n = days === 1 ? 24 : days;
  const series = new Map();
  for (let i = n - 1; i >= 0; i--) series.set(keyOf(new Date(now.getTime() - i * step)), { date: null, qr: 0, shortlink: 0, cta: 0, widget: 0, total: 0 });
  series.forEach((v, k) => { v.date = k; });
  r.daily.forEach(({ _id, n: c }) => { const row = series.get(_id.d); if (row) { row[_id.t] += c; row.total += c; } });

  const hourly = Array.from({ length: 24 }, (_, h) => ({ name: h, value: r.hourly.find((x) => x._id === h)?.value || 0 }));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = wd.map((name, i) => ({ name, value: r.weekday.find((x) => x._id === i + 1)?.value || 0 }));
  const f = (k) => r.funnel.find((x) => x._id === k)?.value || 0;

  return {
    range, days, tz, from, to: now,
    totals: { clicks, unique: r.unique[0]?.n || 0, prevClicks, change: pct(clicks, prevClicks) },
    byType: TYPES.map((t) => ({ name: t, value: r.byType.find((x) => x._id === t)?.value || 0 })),
    funnel: { impressions: f("impression"), opens: f("open"), leads: f("lead") },
    series: [...series.values()], hourly, weekday,
    devices: named(r.devices), os: named(r.os), browsers: named(r.browsers),
    countries: named(r.countries, "Unknown"), referrers: named(r.referrers, "Direct"), pages: named(r.pages),
    topItems: r.topItems, recent: r.recent,
  };
}

const getTz = (req) => safeTz(req.query.tz || "UTC");

// Dashboard overview
router.get("/overview", authMiddleware, async (req, res) => {
  try {
    const userId = oid(getUserId(req));
    const type = TYPES.includes(req.query.type) ? req.query.type : null;
    const report = await buildReport({ userId, ...(type ? { type } : {}) }, { range: req.query.range, tz: getTz(req) });

    const [qrs, links, ctas, widget] = await Promise.all([
      QRCode.countDocuments({ userId, status: { $ne: "paused" } }),
      ShortLink.countDocuments({ userId, status: { $ne: "paused" } }),
      CtaUrl.countDocuments({ userId, status: { $ne: "paused" } }),
      WidgetConfig.findOne({ userId }).select("enabled phoneNumber"),
    ]);
    report.active = { qr: qrs, shortlink: links, cta: ctas, widget: widget?.enabled && widget?.phoneNumber ? 1 : 0 };
    return res.json({ success: true, data: report });
  } catch (e) {
    console.error("Analytics overview:", e);
    return res.status(500).json({ success: false, message: "Could not load analytics." });
  }
});

// Detailed analytics for one QR / short link / CTA / widget
router.get("/item/:id", authMiddleware, async (req, res) => {
  try {
    const userId = oid(getUserId(req));
    if (!/^[0-9a-f]{24}$/i.test(req.params.id)) return res.status(400).json({ success: false, message: "Invalid id." });
    const report = await buildReport({ userId, refId: oid(req.params.id) }, { range: req.query.range, tz: getTz(req) });
    return res.json({ success: true, data: report });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Could not load item analytics." });
  }
});

// CSV export of raw events (max 50,000 rows)
router.get("/export", authMiddleware, async (req, res) => {
  try {
    const userId = oid(getUserId(req));
    const days = RANGES[req.query.range] || 30;
    const type = TYPES.includes(req.query.type) ? req.query.type : null;
    const q = { userId, createdAt: { $gte: new Date(Date.now() - days * 86400000) }, ...(type ? { type } : {}) };
    const rows = await ClickEvent.find(q).sort({ createdAt: -1 }).limit(50000).lean();
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["time", "type", "name", "event", "device", "os", "browser", "country", "referrer", "page"];
    const csv = [head.join(","), ...rows.map((r) => [r.createdAt.toISOString(), r.type, r.refTitle, r.event, r.device, r.os, r.browser, r.country, r.referrer, r.page].map(esc).join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="analytics-${req.query.range || "30d"}.csv"`);
    return res.send("\uFEFF" + csv);
  } catch (e) {
    return res.status(500).json({ success: false, message: "Export failed." });
  }
});

module.exports = router;
