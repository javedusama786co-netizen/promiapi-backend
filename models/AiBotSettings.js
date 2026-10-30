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
    openai: {
      enabled: { type: Boolean, default: false },
      apiKey: { type: String, default: "" },
      model: { type: String, default: "gpt-4o" },
      systemPrompt: { type: String, default: "" },
      temperature: { type: Number, default: 0.7 },
    },
    flowise: {
      enabled: { type: Boolean, default: false },
      apiUrl: { type: String, default: "" },
    },
    // 🌐 External Server / Bank CBS API Settings Schema Added
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
  },
  { timestamps: true }
);

module.exports = mongoose.model("AiBotSettings", AiBotSettingsSchema);