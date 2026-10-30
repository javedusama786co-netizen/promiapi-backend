const AiSettings = require("../models/AiSettings");
const { OpenAI } = require("openai");

/**
 * 🟢 1. GET Current AI Settings Pipeline
 * Path: GET /api/vendor/ai-settings
 */
exports.getAiSettings = async (req, res) => {
  try {
    // req.user.id aapke authMiddleware se aayega (logged-in vendor)
    const aiSettings = await AiSettings.findOne({ vendorId: req.user.id });
    
    return res.status(200).json({
      success: true,
      aiSettings: aiSettings || null
    });
  } catch (error) {
    console.error("Error in getAiSettings:", error.message);
    return res.status(500).json({
      success: false,
      message: "Database lookup failed while fetching AI settings."
    });
  }
};

/**
 * 💾 2. POST / UPDATE Configuration Pipelines
 * Path: POST /api/vendor/ai-settings
 */
exports.updateAiSettings = async (req, res) => {
  const {
    enableAIBot,
    botPlatform,      // 🟢 Added tracking key
    openaiApiKey,
    aiModel,
    aiBotTone,
    businessPrompt,
    flowiseApiUrl,    // 🟢 Added custom flowise endpoint receiver
    fallbackReply,
    replyDelaySeconds,
    stopKeywords
  } = req.body;

  try {
    // Check if configuration already exists for this vendor
    let aiSettings = await AiSettings.findOne({ vendorId: req.user.id });

    if (aiSettings) {
      // Direct assignment configuration updates
      aiSettings.enableAIBot = enableAIBot;
      aiSettings.botPlatform = botPlatform; // 🟢 Synced
      aiSettings.openaiApiKey = openaiApiKey;
      aiSettings.aiModel = aiModel;
      aiSettings.aiBotTone = aiBotTone;
      aiSettings.businessPrompt = businessPrompt;
      aiSettings.flowiseApiUrl = flowiseApiUrl; // 🟢 Synced
      aiSettings.fallbackReply = fallbackReply;
      aiSettings.replyDelaySeconds = replyDelaySeconds;
      aiSettings.stopKeywords = stopKeywords;

      await aiSettings.save();
    } else {
      // Instantiate a new core AI config map
      aiSettings = new AiSettings({
        vendorId: req.user.id,
        enableAIBot,
        botPlatform, // 🟢 Synced
        openaiApiKey,
        aiModel,
        aiBotTone,
        businessPrompt,
        flowiseApiUrl, // 🟢 Synced
        fallbackReply,
        replyDelaySeconds,
        stopKeywords
      });

      await aiSettings.save();
    }

    return res.status(200).json({
      success: true,
      message: "AI engine configurations successfully synced and cached.",
      aiSettings
    });
  } catch (error) {
    console.error("Error in updateAiSettings:", error.message);
    return res.status(500).json({
      success: false,
      message: "Critical error encountered during database sync execution."
    });
  }
};

/**
 * ⚡ 3. LIVE SANDBOX KEY VALIDATION (Optional but Premium Feature)
 * Path: POST /api/vendor/ai-settings/validate
 * Frontend isko use kar ke real-time key check kar sakta hai platform.openai.com par
 */
exports.validateOpenAiKey = async (req, res) => {
  const { openaiApiKey } = req.body;

  if (!openaiApiKey) {
    return res.status(400).json({ success: false, message: "API Token string is required." });
  }

  try {
    // Initialize temporary secure connection pool
    const openai = new OpenAI({ apiKey: openaiApiKey });
    
    // Execute low-latency lightweight dummy check call to test authorization state
    await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 5
    });

    return res.status(200).json({
      success: true,
      message: "Token connection handshake successful. Key is active."
    });
  } catch (error) {
    console.error("OpenAI Validation Error:", error.message);
    return res.status(401).json({
      success: false,
      message: "Authentication handshake failed. Secret token is rejected by OpenAI."
    });
  }
};