const express = require("express");
const router = express.Router();
const CtaUrl = require("../models/CtaUrl");
const authMiddleware = require("../middleware/auth");

// Save CTA URL
router.post("/create", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.user?.adminId;
    const { label, targetUrl } = req.body;

    if (!label || !targetUrl) {
      return res.status(400).json({ success: false, message: "Label and Target URL are required." });
    }

    const newCta = new CtaUrl({ userId, label, targetUrl });
    await newCta.save();

    return res.status(201).json({ success: true, message: "CTA URL saved successfully!", data: newCta });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Get User CTA URLs
router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.user?.adminId;
    const ctas = await CtaUrl.find({ userId }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, data: ctas });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error fetching CTA URLs." });
  }
});

module.exports = router;