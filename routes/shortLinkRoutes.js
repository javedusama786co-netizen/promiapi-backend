const express = require("express");
const router = express.Router();
const ShortLink = require("../models/ShortLink");
const authMiddleware = require("../middleware/auth");
const { getUserId, getBaseUrl, sparklines, cleanPhone, phoneOk, randCode } = require("../utils/track");

const RESERVED = new Set(["api", "admin", "s", "c", "widget", "login", "static", "assets"]);
const normSlug = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9-_]/g, "").slice(0, 40);
const parseDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; };

const format = (l, base, spark) => ({ ...l.toObject(), shortUrl: `${base}/s/${l.slug}`, spark });

// Live slug availability check
router.get("/check-slug/:slug", authMiddleware, async (req, res) => {
  const slug = normSlug(req.params.slug);
  if (slug.length < 3) return res.json({ success: true, available: false, reason: "Use at least 3 characters." });
  if (RESERVED.has(slug)) return res.json({ success: true, available: false, reason: "This word is reserved." });
  const taken = await ShortLink.exists({ slug });
  return res.json({ success: true, available: !taken, reason: taken ? "Already taken." : "" });
});

// Create
router.post("/create", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    const { title, slug, phoneNumber, defaultMessage, expiresAt } = req.body;
    if (!phoneOk(phoneNumber)) return res.status(400).json({ success: false, message: "Enter a valid WhatsApp number with country code (8–15 digits)." });

    let finalSlug = normSlug(slug);
    if (slug && finalSlug.length < 3) return res.status(400).json({ success: false, message: "Custom slug must be at least 3 characters (a–z, 0–9, - _)." });
    if (finalSlug && RESERVED.has(finalSlug)) return res.status(400).json({ success: false, message: "This slug is reserved. Choose another." });
    if (!finalSlug) { do { finalSlug = randCode(6).toLowerCase(); } while (await ShortLink.exists({ slug: finalSlug })); }
    else if (await ShortLink.exists({ slug: finalSlug })) return res.status(400).json({ success: false, message: "This custom slug is already taken. Choose another." });

    const link = await ShortLink.create({
      userId, title: String(title || "Untitled Short Link").trim().slice(0, 80), slug: finalSlug,
      phoneNumber: cleanPhone(phoneNumber), defaultMessage: String(defaultMessage || "").slice(0, 1000), expiresAt: parseDate(expiresAt),
    });
    return res.status(201).json({ success: true, message: "Short link created successfully!", data: format(link, getBaseUrl(req)) });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ success: false, message: "This slug is already taken." });
    return res.status(500).json({ success: false, message: error.message });
  }
});

// List
router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    const links = await ShortLink.find({ userId }).sort({ createdAt: -1 });
    const sp = await sparklines(userId, links.map((l) => l._id));
    const base = getBaseUrl(req);
    return res.status(200).json({ success: true, data: links.map((l) => format(l, base, sp[String(l._id)])) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error fetching short links." });
  }
});

// Update (slug is immutable so shared links never break)
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const b = req.body, set = {};
    if (b.title !== undefined) set.title = String(b.title).trim().slice(0, 80) || "Untitled Short Link";
    if (b.defaultMessage !== undefined) set.defaultMessage = String(b.defaultMessage).slice(0, 1000);
    if (b.phoneNumber !== undefined) {
      if (!phoneOk(b.phoneNumber)) return res.status(400).json({ success: false, message: "Invalid WhatsApp number." });
      set.phoneNumber = cleanPhone(b.phoneNumber);
    }
    if (["active", "paused"].includes(b.status)) set.status = b.status;
    if (b.expiresAt !== undefined) set.expiresAt = parseDate(b.expiresAt);
    const link = await ShortLink.findOneAndUpdate({ _id: req.params.id, userId: getUserId(req) }, { $set: set }, { new: true });
    if (!link) return res.status(404).json({ success: false, message: "Short link not found." });
    return res.status(200).json({ success: true, message: "Short link updated.", data: format(link, getBaseUrl(req)) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error updating short link." });
  }
});

// Delete (past click history stays in your analytics totals)
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const l = await ShortLink.findOneAndDelete({ _id: req.params.id, userId: getUserId(req) });
    if (!l) return res.status(404).json({ success: false, message: "Short link not found." });
    return res.status(200).json({ success: true, message: "Short link deleted." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error deleting short link." });
  }
});

// NOTE: the public /s/:slug redirect now lives in publicRoutes.js

module.exports = router;
