const express = require("express");
const router = express.Router();
const CtaUrl = require("../models/CtaUrl");
const authMiddleware = require("../middleware/auth");
const { getUserId, getBaseUrl, sparklines, randCode } = require("../utils/track");

const parseDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; };
const normUrl = (u) => {
  let s = String(u || "").trim();
  if (s && !/^https?:\/\//i.test(s)) s = "https://" + s;
  try { const x = new URL(s); return /^https?:$/.test(x.protocol) ? x.toString() : null; } catch { return null; }
};
const utm = (v) => String(v || "").trim().slice(0, 100);

const format = (c, base, spark) => ({
  ...c.toObject(),
  trackUrl: c.code ? `${base}/c/${c.code}` : "",
  templateUrl: `${base}/c/{{1}}`, // paste as the URL of a WhatsApp template button with a dynamic suffix; {{1}} = code
  spark,
});

async function uniqueCode() {
  let code;
  do { code = randCode(7); } while (await CtaUrl.exists({ code }));
  return code;
}

// Create
router.post("/create", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    const { label, targetUrl, expiresAt, utmSource, utmMedium, utmCampaign } = req.body;
    if (!String(label || "").trim() || !targetUrl) return res.status(400).json({ success: false, message: "Label and Target URL are required." });
    const url = normUrl(targetUrl);
    if (!url) return res.status(400).json({ success: false, message: "Enter a valid website URL (https://…)." });

    const cta = await CtaUrl.create({
      userId, label: String(label).trim().slice(0, 60), targetUrl: url, code: await uniqueCode(),
      expiresAt: parseDate(expiresAt), utmSource: utm(utmSource), utmMedium: utm(utmMedium), utmCampaign: utm(utmCampaign),
    });
    return res.status(201).json({ success: true, message: "CTA URL saved successfully!", data: format(cta, getBaseUrl(req)) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// List (back-fills a tracking code for CTAs created before tracking existed)
router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    const ctas = await CtaUrl.find({ userId }).sort({ createdAt: -1 });
    for (const c of ctas) if (!c.code) { c.code = await uniqueCode(); await c.save(); }
    const sp = await sparklines(userId, ctas.map((c) => c._id));
    const base = getBaseUrl(req);
    return res.status(200).json({ success: true, data: ctas.map((c) => format(c, base, sp[String(c._id)])) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error fetching CTA URLs." });
  }
});

// Update
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const b = req.body, set = {};
    if (b.label !== undefined) { if (!String(b.label).trim()) return res.status(400).json({ success: false, message: "Label is required." }); set.label = String(b.label).trim().slice(0, 60); }
    if (b.targetUrl !== undefined) { const u = normUrl(b.targetUrl); if (!u) return res.status(400).json({ success: false, message: "Enter a valid website URL." }); set.targetUrl = u; }
    if (["active", "paused"].includes(b.status)) set.status = b.status;
    if (b.expiresAt !== undefined) set.expiresAt = parseDate(b.expiresAt);
    ["utmSource", "utmMedium", "utmCampaign"].forEach((k) => { if (b[k] !== undefined) set[k] = utm(b[k]); });
    const cta = await CtaUrl.findOneAndUpdate({ _id: req.params.id, userId: getUserId(req) }, { $set: set }, { new: true });
    if (!cta) return res.status(404).json({ success: false, message: "CTA URL not found." });
    return res.status(200).json({ success: true, message: "CTA URL updated.", data: format(cta, getBaseUrl(req)) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error updating CTA URL." });
  }
});

// Delete
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const c = await CtaUrl.findOneAndDelete({ _id: req.params.id, userId: getUserId(req) });
    if (!c) return res.status(404).json({ success: false, message: "CTA URL not found." });
    return res.status(200).json({ success: true, message: "CTA URL deleted." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error deleting CTA URL." });
  }
});

module.exports = router;
