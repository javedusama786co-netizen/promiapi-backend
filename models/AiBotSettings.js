const mongoose = require("mongoose");

const AiBotSettingsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    general: {
      failedMessage: { type: String, default: "" },
      enableForNewContacts: { type: Boolean, default: false },
    },

    // 🤖 AI provider settings.
    // NOTE: the key is still called "openai" so the existing dashboard/API keep working,
    // but the backend now sends these values to GROQ (https://api.groq.com/openai/v1).
    //   apiKey -> your GROQ API key (starts with gsk_...)
    //   model  -> a GROQ model id. OpenAI names (gpt-4o etc.) and retired Llama models are auto-replaced in code.
    openai: {
      enabled: { type: Boolean, default: false },
      apiKey: { type: String, default: "" },
      model: { type: String, default: "openai/gpt-oss-120b" },
      systemPrompt: { type: String, default: "" },
      temperature: { type: Number, default: 0.7 },
    },

    flowise: {
      enabled: { type: Boolean, default: false },
      apiUrl: { type: String, default: "" },
    },

    // 🌐 External Server / Bank CBS API Settings
    externalApi: {
      enabled: { type: Boolean, default: false },
      baseUrl: { type: String, default: "" },
      apiKey: { type: String, default: "" },
      apiSecret: { type: String, default: "" },
      description: { type: String, default: "" },
    },

    timing: {
      enabled: { type: Boolean, default: false },
      startTime: { type: String, default: "" },
      endTime: { type: String, default: "" },
      timezone: { type: String, default: "UTC" },
      triggers: {
        welcome: { type: Boolean, default: false },
        is: { type: Boolean, default: false },
        startsWith: { type: Boolean, default: false },
        endsWith: { type: Boolean, default: false },
        containsWhole: { type: Boolean, default: false },
        contains: { type: Boolean, default: false },
        stopPromotional: { type: Boolean, default: false },
        startPromotional: { type: Boolean, default: false },
        startAiBot: { type: Boolean, default: false },
        stopAiBot: { type: Boolean, default: false },
      },
    },

    advanced: {
      handoverKeyword: { type: String, default: "" },
      responseDelay: { type: Number, default: 0 },
    },

    // 🧩 CUSTOM FIELDS x AI: what the AI may do with the contact's saved details
    contactData: {
      readEnabled: { type: Boolean, default: true },       // AI sees the customer profile (name, city ...) before answering
      writeEnabled: { type: Boolean, default: true },      // AI saves details the customer tells it (name, city ...)
      askForMissing: { type: Boolean, default: false },    // AI may politely ask for one missing detail when it fits
      overwriteManual: { type: Boolean, default: false },  // allow AI to overwrite values your team entered (not recommended)
    },
  },
  { timestamps: true }
);

// Safe re-registration (prevents OverwriteModelError on hot-reload)
module.exports =
  mongoose.models.AiBotSettings || mongoose.model("AiBotSettings", AiBotSettingsSchema);