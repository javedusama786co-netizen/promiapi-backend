const mongoose = require("mongoose");

const AiSettingsSchema = new mongoose.Schema({
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  enableAIBot: { type: Boolean, default: false },
  openaiApiKey: { type: String, required: true },
  aiModel: { type: String, default: "gpt-4o" },
  aiBotTone: { type: String, default: "Professional" },
  businessPrompt: { type: String, required: true },
  fallbackReply: { type: String, default: "Connecting you with a human agent shortly..." },
  replyDelaySeconds: { type: Number, default: 3 },
  stopKeywords: { type: String, default: "stop, agent, human" }
}, { timestamps: true });

module.exports = mongoose.model("AiSettings", AiSettingsSchema);