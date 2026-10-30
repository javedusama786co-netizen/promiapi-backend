const axios = require("axios");

/**
 * AI Response Resolution Core Engine
 */
exports.generateBotResponse = async (settings, userMessage) => {
  // 1. Human Handover Check (Safe Empty String Filter Added)
  if (settings.advanced?.handoverKeyword?.trim()) {
    const keywords = settings.advanced.handoverKeyword
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 0); // Empty values ko remove karta hai
      
    if (keywords.some((kw) => userMessage.toLowerCase().includes(kw))) {
      return { action: "PAUSE_BOT", reply: null };
    }
  }

  // 2. Flowise AI Execution (Priority 1)
  if (settings.flowise?.enabled && settings.flowise?.apiUrl) {
    try {
      const response = await axios.post(
        settings.flowise.apiUrl,
        { question: userMessage },
        { headers: { "Content-Type": "application/json" }, timeout: 10000 }
      );

      // Flowise Flexible Extraction Logic
      const reply =
        response.data?.text ||
        response.data?.json?.text ||
        (typeof response.data === "string" ? response.data : null);

      if (reply) return { action: "SEND_REPLY", reply };
    } catch (err) {
      console.error("Flowise Execution Error:", err.message);
    }
  }

  // 3. OpenAI Integration Execution (Priority 2)
  if (settings.openai?.enabled && settings.openai?.apiKey) {
    try {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: settings.openai.model || "gpt-4o",
          temperature: settings.openai.temperature ?? 0.7,
          messages: [
            {
              role: "system",
              content: settings.openai.systemPrompt || "You are a helpful assistant.",
            },
            { role: "user", content: userMessage },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${settings.openai.apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      );

      // Standard OpenAI Choices Response Extraction
      const reply = response.data?.choices?.[0]?.message?.content;
      if (reply) return { action: "SEND_REPLY", reply };
    } catch (err) {
      console.error("OpenAI Execution Error:", err.message);
    }
  }

  // 4. Fallback Failure Message
  return {
    action: "SEND_FALLBACK",
    reply: settings.general?.failedMessage || "Sorry, I am currently unavailable.",
  };
};