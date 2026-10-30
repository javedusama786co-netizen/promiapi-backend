const express = require("express");
const router = express.Router();
const AiSettings = require("../models/AiSettings");
const authMiddleware = require("../middleware/authMiddleware"); // Aapka JWT auth token handler

// 🟢 1. Fetch Current AI Settings
router.get("/ai-settings", authMiddleware, async (req, res) => {
  try {
    const aiSettings = await AiSettings.findOne({ vendorId: req.user.id });
    return res.status(200).json({ success: true, aiSettings });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Database lookup failed." });
  }
});

// 💾 2. Save / Update Configuration Pipelines
router.post("/ai-settings", authMiddleware, async (req, res) => {
  const { enableAIBot, openaiApiKey, aiModel, aiBotTone, businessPrompt, fallbackReply, replyDelaySeconds, stopKeywords } = req.body;

  try {
    let aiSettings = await AiSettings.findOne({ vendorId: req.user.id });

    if (aiSettings) {
      // Configuration update dynamic trigger
      aiSettings.enableAIBot = enableAIBot;
      aiSettings.openaiApiKey = openaiApiKey;
      aiSettings.aiModel = aiModel;
      aiSettings.aiBotTone = aiBotTone;
      aiSettings.businessPrompt = businessPrompt;
      aiSettings.fallbackReply = fallbackReply;
      aiSettings.replyDelaySeconds = replyDelaySeconds;
      aiSettings.stopKeywords = stopKeywords;
      await aiSettings.save();
    } else {
      // Create new record
      aiSettings = new AiSettings({
        vendorId: req.user.id,
        enableAIBot,
        openaiApiKey,
        aiModel,
        aiBotTone,
        businessPrompt,
        fallbackReply,
        replyDelaySeconds,
        stopKeywords
      });
      await aiSettings.save();
    }

    return res.status(200).json({ success: true, message: "Configurations securely cached.", aiSettings });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Critical database update lock." });
  }
});

module.exports = router;