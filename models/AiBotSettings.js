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

    // 🤖 Two AI providers, both can be ON at the same time. They share the same engine (see processAiBotResponse
    // in webhookRoutes.js and whatsappBaileysService.js).
    //
    // GROQ  -> settings.groq    apiKey starts with gsk_..., model is a Groq model id (default openai/gpt-oss-120b)
    // OPENAI -> settings.openai apiKey starts with sk-...,  model is an OpenAI model id (default gpt-4o-mini)
    //
    // `groq.enabled` has NO default on purpose: older documents (before the groq block existed) kept their Groq key
    // inside `openai`, and the server detects them by "groq.enabled is undefined".
    groq: {
      enabled: { type: Boolean },
      apiKey: { type: String, default: "" },
      model: { type: String, default: "openai/gpt-oss-120b" },
      systemPrompt: { type: String, default: "" },
      temperature: { type: Number, default: 0.7 },
    },

    openai: {
      enabled: { type: Boolean, default: false },
      apiKey: { type: String, default: "" },
      model: { type: String, default: "gpt-4o-mini" },
      systemPrompt: { type: String, default: "" }, // empty = use the Groq instructions
      temperature: { type: Number, default: 0.7 },
    },

    // Which provider answers first when both are ON (the other one is the automatic backup)
    aiProvider: { type: String, enum: ["groq", "openai"], default: "groq" },

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