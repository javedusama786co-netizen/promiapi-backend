/**
 * Public, unauthenticated endpoints. Mount at the ROOT of your app:
 *   app.use("/", require("./routes/publicRoutes"));
 *
 *   GET  /s/:slug                      short link redirect (tracked)
 *   GET  /c/:code                      CTA redirect (tracked, UTM appended)
 *   GET  /widget.js                    floating widget loader
 *   GET  /api/widgets/public/:key      public widget settings (CORS *)
 *   POST /api/widgets/event            widget impression/open/lead beacon (CORS *)
 */
const express = require("express");
const router = express.Router();
const ShortLink = require("../models/ShortLink");
const CtaUrl = require("../models/CtaUrl");
const WidgetConfig = require("../models/WidgetConfig");
const { recordEvent, isActive, waUrl, inactivePage } = require("../utils/track");
const widgetClient = require("../utils/widgetClient");

const WIDGET_JS = `(${widgetClient.toString()})();`;

// Short link redirect
router.get("/s/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug).toLowerCase();
    const link = await ShortLink.findOne({ slug });
    if (!link) return res.status(404).send(inactivePage("link"));
    if (!isActive(link)) return res.status(410).send(inactivePage("link"));

    recordEvent(req, { userId: link.userId, type: "shortlink", refId: link._id, refTitle: link.title });
    ShortLink.updateOne({ _id: link._id }, { $inc: { clicks: 1 }, $set: { lastClickedAt: new Date() } }).catch(() => {});
    res.set("Cache-Control", "no-store");
    return res.redirect(waUrl(link.phoneNumber, link.defaultMessage));
  } catch (e) {
    return res.status(500).send("Server error processing short link.");
  }
});

// CTA redirect (UTM params are appended without overwriting ones already in the URL)
router.get("/c/:code", async (req, res) => {
  try {
    const cta = await CtaUrl.findOne({ code: req.params.code });
    if (!cta) return res.status(404).send(inactivePage("link"));
    if (!isActive(cta)) return res.status(410).send(inactivePage("link"));

    recordEvent(req, { userId: cta.userId, type: "cta", refId: cta._id, refTitle: cta.label });
    CtaUrl.updateOne({ _id: cta._id }, { $inc: { clicks: 1 }, $set: { lastClickedAt: new Date() } }).catch(() => {});

    const url = new URL(cta.targetUrl);
    [["utm_source", cta.utmSource], ["utm_medium", cta.utmMedium], ["utm_campaign", cta.utmCampaign]].forEach(([k, v]) => {
      if (v && !url.searchParams.has(k)) url.searchParams.set(k, v);
    });
    res.set("Cache-Control", "no-store");
    return res.redirect(url.toString());
  } catch (e) {
    return res.status(500).send("Server error processing link.");
  }
});

// Widget loader script
router.get("/widget.js", (req, res) => {
  res.set({ "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" });
  res.send(WIDGET_JS);
});

const cors = (req, res, next) => {
  res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Cross-Origin-Resource-Policy": "cross-origin" });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
};

// Public widget settings
router.get("/api/widgets/public/:key", cors, async (req, res) => {
  try {
    const c = await WidgetConfig.findOne({ publicKey: req.params.key }).lean();
    if (!c || !c.enabled) return res.status(404).json({ success: false });
    res.set("Cache-Control", "public, max-age=60");
    const { phoneNumber, title, subtitle, welcomeMessage, prefilledMessage, buttonLabel, offlineMessage, position, brandColor, showBadge, autoOpenDelay, showOnMobile, showOnDesktop, hours, enabled } = c;
    return res.json({ success: true, data: { phoneNumber, title, subtitle, welcomeMessage, prefilledMessage, buttonLabel, offlineMessage, position, brandColor, showBadge, autoOpenDelay, showOnMobile, showOnDesktop, hours, enabled } });
  } catch (e) {
    return res.status(500).json({ success: false });
  }
});

// tiny in-memory rate limit: 120 events / minute / IP
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();

router.options("/api/widgets/event", cors);
router.post("/api/widgets/event", cors, express.text({ type: "*/*", limit: "2kb" }), async (req, res) => {
  try {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0];
    const n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
    if (n > 120) return res.sendStatus(429);

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    if (!["impression", "open", "lead"].includes(body.event) || !body.key) return res.sendStatus(400);
    const cfg = await WidgetConfig.findOne({ publicKey: String(body.key) }).select("userId title enabled");
    if (!cfg || !cfg.enabled) return res.sendStatus(404);

    recordEvent(req, { userId: cfg.userId, type: "widget", refId: cfg._id, refTitle: cfg.title, event: body.event, page: body.page });
    return res.sendStatus(204);
  } catch (e) {
    return res.sendStatus(400);
  }
});

module.exports = router;
