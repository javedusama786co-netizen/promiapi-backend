const express = require("express");
const router = express.Router();
const QRCode = require("../models/QRCode");
const authMiddleware = require("../middleware/auth");
const { getUserId, getBaseUrl, recordEvent, sparklines, isActive, cleanPhone, phoneOk, waUrl, inactivePage } = require("../utils/track");

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v, min, max, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

// Whitelist + validate design/content fields (shared by create & update)
function pickFields(b, partial = false) {
  const o = {};
  const set = (k, v) => { if (v !== undefined) o[k] = v; };
  if (!partial || b.title !== undefined) set("title", String(b.title || "WhatsApp Marketing QR").trim().slice(0, 80));
  if (b.phoneNumber !== undefined) set("phoneNumber", cleanPhone(b.phoneNumber));
  if (b.defaultMessage !== undefined) set("defaultMessage", String(b.defaultMessage).slice(0, 1000));
  if (b.status !== undefined && ["active", "paused"].includes(b.status)) set("status", b.status);
  if (HEX.test(b.fgColor || "")) set("fgColor", b.fgColor);
  if (HEX.test(b.bgColor || "")) set("bgColor", b.bgColor);
  if (b.eyeColor !== undefined) set("eyeColor", HEX.test(b.eyeColor) ? b.eyeColor : "");
  if (b.logoUrl !== undefined) set("logoUrl", String(b.logoUrl).slice(0, 3_000_000));
  if (b.logoSize !== undefined) set("logoSize", num(b.logoSize, 8, 30, 17));
  if (b.logoPadding !== undefined) set("logoPadding", num(b.logoPadding, 0, 20, 4));
  if (b.removeBehindLogo !== undefined) set("removeBehindLogo", !!b.removeBehindLogo);
  if (b.size !== undefined) set("size", num(b.size, 128, 2048, 512));
  if (["L", "M", "Q", "H"].includes(b.ecLevel)) set("ecLevel", b.ecLevel);
  if (b.quietZone !== undefined) set("quietZone", num(b.quietZone, 0, 50, 10));
  if (b.eyeRadius !== undefined) set("eyeRadius", num(b.eyeRadius, 0, 50, 8));
  if (["squares", "dots", "fluid"].includes(b.qrStyle)) set("qrStyle", b.qrStyle);
  return o;
}

const withUrl = (qr, base, spark) => ({
  ...qr.toObject(),
  trackingUrl: `${base}/api/qr/track/${qr._id}`,
  spark: spark || undefined,
});

// 1. SAVE NEW QR
router.post("/save", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: "Authentication failed. User ID missing." });
    if (!phoneOk(req.body.phoneNumber)) return res.status(400).json({ success: false, message: "Enter a valid WhatsApp number with country code (8–15 digits)." });

    const qr = await QRCode.create({ userId, ...pickFields(req.body) });
    return res.status(201).json({ success: true, message: "QR Code saved successfully!", data: withUrl(qr, getBaseUrl(req)) });
  } catch (error) {
    console.error("Save QR Error:", error);
    return res.status(500).json({ success: false, message: error.message || "Server error saving QR Code" });
  }
});

// 2. LIST (with 14-day sparkline per QR)
router.get("/my-qrs", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    const qrs = await QRCode.find({ userId }).sort({ createdAt: -1 });
    const sp = await sparklines(userId, qrs.map((q) => q._id));
    const base = getBaseUrl(req);
    return res.status(200).json({ success: true, count: qrs.length, data: qrs.map((q) => withUrl(q, base, sp[String(q._id)])) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error fetching QR codes" });
  }
});

// 3. UPDATE (edit design, content, pause/resume). The tracking URL never changes, so printed codes keep working.
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    const fields = pickFields(req.body, true);
    if (fields.phoneNumber !== undefined && !phoneOk(fields.phoneNumber)) return res.status(400).json({ success: false, message: "Invalid WhatsApp number." });
    const qr = await QRCode.findOneAndUpdate({ _id: req.params.id, userId }, { $set: fields }, { new: true });
    if (!qr) return res.status(404).json({ success: false, message: "QR Code not found" });
    return res.status(200).json({ success: true, message: "QR Code updated", data: withUrl(qr, getBaseUrl(req)) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error updating QR code" });
  }
});

// 4. PUBLIC TRACKING + REDIRECT (path unchanged so existing printed QR codes keep working)
router.get("/track/:id", async (req, res) => {
  try {
    const qr = await QRCode.findById(req.params.id);
    if (!qr) return res.status(404).send("Invalid or expired QR Code.");
    if (!isActive(qr)) return res.status(410).send(inactivePage("QR code"));

    recordEvent(req, { userId: qr.userId, type: "qr", refId: qr._id, refTitle: qr.title });
    QRCode.updateOne({ _id: qr._id }, { $inc: { scansCount: 1 }, $set: { lastScannedAt: new Date() } }).catch(() => {});

    res.set("Cache-Control", "no-store");
    return res.redirect(waUrl(qr.phoneNumber, qr.defaultMessage));
  } catch (error) {
    console.error("Track QR Error:", error);
    return res.status(500).send("Error processing QR Code redirection.");
  }
});

// 5. DELETE
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const qr = await QRCode.findOneAndDelete({ _id: req.params.id, userId: getUserId(req) });
    if (!qr) return res.status(404).json({ success: false, message: "QR Code not found" });
    return res.status(200).json({ success: true, message: "QR Code deleted successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error deleting QR code" });
  }
});

module.exports = router;
