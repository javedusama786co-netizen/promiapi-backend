const { OpenAI } = require("openai");
const axios = require("axios"); // 🟢 Flowise requests bhejne ke liye axios import kiya hai
const AiSettings = require("../models/AiSettings");

/**
 * Core Processing Engine For Inbound Messages (Supports OpenAI & Flowise)
 * @param {string} vendorId - Message pipeline target reference
 * @param {string} incomingMessage - Client query input
 * @param {string} clientPhoneNumber - Target phone number
 * @param {function} sendWhatsAppMessage - Callback function to deliver message
 */
async function processIncomingWithAI(vendorId, incomingMessage, clientPhoneNumber, sendWhatsAppMessage) {
  try {
    // 1. Fetch vendor setup configurations
    const config = await AiSettings.findOne({ vendorId });
    if (!config || !config.enableAIBot) {
      return; // Core dynamic silent exit agar configuration invalid ya power off ho
    }

    // 2. Human Intercept Guardrails Check (Stop Keywords Verification)
    const keywords = config.stopKeywords ? config.stopKeywords.split(",").map(k => k.trim().toLowerCase()) : [];
    const matchedKeyword = keywords.some(word => incomingMessage.toLowerCase().includes(word));
    
    if (matchedKeyword) {
      if (config.fallbackReply) {
        await sendWhatsAppMessage(clientPhoneNumber, config.fallbackReply);
      }
      return; 
    }

    let aiReply = "";

    // 🟢 PATHWAY A: FlowiseAI Webhook Route
    if (config.botPlatform === "flowise") {
      if (!config.flowiseApiUrl) return;

      try {
        // Flowise prediction API ko hit karna
        const response = await axios.post(config.flowiseApiUrl, {
          question: incomingMessage
        });

        // Flowise standard output key 'text' ya string response handle karna
        aiReply = response.data?.text || response.data;
      } catch (flowiseError) {
        console.error("Flowise webhook routing failure:", flowiseError.message);
        if (config.fallbackReply) {
          aiReply = config.fallbackReply;
        } else {
          return; // Fallback nahi hai to exit
        }
      }
    } 
    // 🟡 PATHWAY B: Direct OpenAI API Route (Default Failover)
    else {
      if (!config.openaiApiKey) return;

      const openai = new OpenAI({ apiKey: config.openaiApiKey });

      // Construct Identity Prompt Architecture
      const systemInstruction = `
        ${config.businessPrompt}
        
        CRITICAL OPERATIONAL RULES:
        1. Keep response text ultra concise and chat-friendly for instant messengers.
        2. Strictly adhere to the given conversation tone parameters: Tone should be strictly "${config.aiBotTone}".
        3. Do not generate fake links, data context, or break your baseline profile constraints.
      `;

      // Query Premium Model Nodes
      const completion = await openai.chat.completions.create({
        model: config.aiModel || "gpt-4o",
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: incomingMessage }
        ],
        max_tokens: 450,
        temperature: 0.5
      });

      aiReply = completion.choices[0].message.content;
    }

    // 6. Simulate Typing Latency (Safe Promise-based Delay for Async Operations)
    if (aiReply) {
      const delayTimeout = (config.replyDelaySeconds || 3) * 1000;
      
      // Node.js Event Loop handles this safely without setTimeout leakage
      await new Promise(resolve => setTimeout(resolve, delayTimeout));
      await sendWhatsAppMessage(clientPhoneNumber, aiReply);
    }

  } catch (error) {
    console.error("AI execution pipeline critical failure:", error.message);
  }
}

module.exports = { processIncomingWithAI };