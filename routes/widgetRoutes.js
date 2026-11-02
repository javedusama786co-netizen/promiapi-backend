const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const WidgetConfig = require("../models/WidgetConfig");
const authMiddleware = require("../middleware/auth");
const { getUserId, getBaseUrl, phoneOk, cleanPhone } = require("../utils/track");

const HEX = /^#[0-9a-f]{6}$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const str = (v, max) => String(v ?? "").trim().slice(0, max);

const withEmbed = (cfg, req) => {
  const base = getBaseUrl(req);
  return { ...cfg.toObject(), embedCode: `<script src="${base}/widget.js" data-key="${cfg.publicKey}" async></script>` };
};

async function ensureKey(cfg) {
  if (!cfg.publicKey) { cfg.publicKey = crypto.randomBytes(8).toString("hex"); await cfg.save(); }
  return cfg;
}

// Get config (auto-creates defaults + public key)
router.get("/config", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    let cfg = await WidgetConfig.findOne({ userId });
    if (!cfg) cfg = new WidgetConfig({ userId });
    await ensureKey(cfg);
    if (cfg.isNew) await cfg.save();
    return res.status(200).json({ success: true, data: withEmbed(cfg, req) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error fetching widget config." });
  }
});

// Save config
router.post("/config", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    const b = req.body, set = {};
    if (b.phoneNumber !== undefined) {
      if (b.phoneNumber && !phoneOk(b.phoneNumber)) return res.status(400).json({ success: false, message: "Enter the WhatsApp number with country code (8–15 digits)." });
      set.phoneNumber = cleanPhone(b.phoneNumber);
    }
    ["title:60", "subtitle:80", "welcomeMessage:300", "prefilledMessage:300", "buttonLabel:40", "offlineMessage:300"].forEach((p) => {
      const [k, n] = p.split(":"); if (b[k] !== undefined) set[k] = str(b[k], +n);
    });
    if (["left", "right"].includes(b.position)) set.position = b.position;
    if (HEX.test(b.brandColor || "")) set.brandColor = b.brandColor;
    ["enabled", "showBadge", "showOnMobile", "showOnDesktop"].forEach((k) => { if (b[k] !== undefined) set[k] = !!b[k]; });
    if (b.autoOpenDelay !== undefined) set.autoOpenDelay = Math.min(120, Math.max(0, parseInt(b.autoOpenDelay, 10) || 0));
    if (b.hours) {
      const h = b.hours;
      set["hours.enabled"] = !!h.enabled;
      if (h.timezone) { try { new Intl.DateTimeFormat("en", { timeZone: h.timezone }); set["hours.timezone"] = h.timezone; } catch {} }
      if (HHMM.test(h.start || "")) set["hours.start"] = h.start;
      if (HHMM.test(h.end || "")) set["hours.end"] = h.end;
      if (Array.isArray(h.days)) set["hours.days"] = [...new Set(h.days.map(Number).filter((d) => d >= 0 && d <= 6))];
    }

    let cfg = await WidgetConfig.findOneAndUpdate({ userId }, { $set: set }, { new: true, upsert: true, setDefaultsOnInsert: true });
    await ensureKey(cfg);
    return res.status(200).json({ success: true, message: "Widget configuration saved!", data: withEmbed(cfg, req) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
