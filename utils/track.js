const crypto = require("crypto");
const mongoose = require("mongoose");
const ClickEvent = require("../models/ClickEvent");

let geo = null;
try { geo = require("geoip-lite"); } catch (e) { /* optional: npm i geoip-lite */ }

const SALT = process.env.ANALYTICS_SALT || "promi-analytics-salt";

const getUserId = (req) => req.user?.id || req.user?._id || req.user?.adminId;
// aggregate() does not auto-cast, so convert explicitly
const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));

const getBaseUrl = (req) => {
  const protocol = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString().split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${protocol}://${host}`;
};

const clientIp = (req) =>
  (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "")
    .toString().split(",")[0].trim();

const BOT_RE = /bot|crawl|spider|preview|slurp|facebookexternalhit|embedly|quora|pinterest|slack|telegram|discord|whatsapp\/|curl|wget|python-requests|headless/i;

function parseUA(ua = "") {
  let device = "Desktop";
  if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) device = "Tablet";
  else if (/mobi|iphone|ipod|android/i.test(ua)) device = "Mobile";
  else if (!ua) device = "Unknown";

  let os = "Other";
  if (/windows nt/i.test(ua)) os = "Windows";
  else if (/iphone|ipad|ipod/i.test(ua)) os = "iOS";
  else if (/android/i.test(ua)) os = "Android";
  else if (/mac os x/i.test(ua)) os = "macOS";
  else if (/cros/i.test(ua)) os = "ChromeOS";
  else if (/linux/i.test(ua)) os = "Linux";

  let browser = "Other";
  if (/edg(e|a|ios)?\//i.test(ua)) browser = "Edge";
  else if (/opr\/|opera/i.test(ua)) browser = "Opera";
  else if (/samsungbrowser/i.test(ua)) browser = "Samsung Internet";
  else if (/firefox|fxios/i.test(ua)) browser = "Firefox";
  else if (/chrome|crios/i.test(ua)) browser = "Chrome";
  else if (/safari/i.test(ua)) browser = "Safari";
  else if (/fban|fbav|instagram/i.test(ua)) browser = "In-app (Meta)";
  return { device, os, browser };
}

function countryOf(req) {
  const h = req.headers["cf-ipcountry"] || req.headers["x-vercel-ip-country"] || req.headers["x-country-code"];
  if (h && /^[A-Za-z]{2}$/.test(h) && h.toUpperCase() !== "XX") return h.toUpperCase();
  if (geo) { const r = geo.lookup(clientIp(req)); if (r?.country) return r.country; }
  return "";
}

function referrerOf(req) {
  const ref = req.headers.referer || req.headers.referrer || "";
  if (!ref) return "Direct";
  try { return new URL(ref).hostname.replace(/^www\./, "") || "Direct"; } catch { return "Direct"; }
}

/** Fire-and-forget: never blocks or breaks the redirect. */
function recordEvent(req, { userId, type, refId, refTitle = "", event = "click", page = "" }) {
  try {
    const ua = req.headers["user-agent"] || "";
    if (BOT_RE.test(ua)) return;
    const visitor = crypto.createHash("sha256").update(`${SALT}|${clientIp(req)}|${ua}|${type}|${refId}`).digest("hex").slice(0, 24);
    const { device, os, browser } = parseUA(ua);
    ClickEvent.create({
      userId, type, refId, refTitle, event, visitor, device, os, browser,
      country: countryOf(req), referrer: referrerOf(req), page: String(page || "").slice(0, 200),
    }).catch((e) => console.error("track error:", e.message));
  } catch (e) { console.error("track error:", e.message); }
}

/** id -> [n, n, ...] daily click counts for the last `days` days (oldest first). */
async function sparklines(userId, ids, days = 14) {
  const out = {};
  ids.forEach((id) => { out[String(id)] = new Array(days).fill(0); });
  if (!ids.length) return out;
  const since = new Date(Date.now() - days * 86400000);
  const rows = await ClickEvent.aggregate([
    { $match: { userId: oid(userId), refId: { $in: ids }, createdAt: { $gte: since }, event: { $in: ["click", "lead"] } } },
    { $group: { _id: { id: "$refId", d: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } } }, n: { $sum: 1 } } },
  ]);
  const idx = {};
  for (let i = 0; i < days; i++) idx[new Date(Date.now() - (days - 1 - i) * 86400000).toISOString().slice(0, 10)] = i;
  rows.forEach((r) => { const i = idx[r._id.d]; if (i !== undefined) out[String(r._id.id)][i] += r.n; });
  return out;
}

const isActive = (doc) =>
  doc.status !== "paused" && !(doc.expiresAt && new Date(doc.expiresAt) < new Date());

const cleanPhone = (p) => String(p || "").replace(/[^0-9]/g, "");
const phoneOk = (p) => { const n = cleanPhone(p); return n.length >= 8 && n.length <= 15; };
const waUrl = (phone, msg) => `https://wa.me/${cleanPhone(phone)}${msg ? `?text=${encodeURIComponent(msg)}` : ""}`;

const randCode = (len = 7) => crypto.randomBytes(8).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, len);

const inactivePage = (what = "link") =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unavailable</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#1d2433">
<div style="text-align:center;max-width:360px;padding:24px"><h1 style="font-size:20px;margin:0 0 8px">This ${what} is not available</h1>
<p style="margin:0;color:#667085">It was paused or has expired. Contact the person who shared it.</p></div></body>`;

module.exports = { oid, getUserId, getBaseUrl, recordEvent, sparklines, isActive, cleanPhone, phoneOk, waUrl, randCode, inactivePage, parseUA };
