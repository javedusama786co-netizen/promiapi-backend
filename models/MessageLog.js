const mongoose = require("mongoose");

const MessageLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  platform: {
    type: String,
    enum: ["whatsapp", "instagram", "messenger", "all"],
    default: "whatsapp",
    lowercase: true,
    trim: true
  },
  receiverNumber: { // Stores Phone Number OR Instagram/Messenger Scoped ID (PSID)
    type: String,
    required: true,
    trim: true
  },
  receiverName: {
    type: String,
    default: "",
    trim: true
  },
  messageBody: {
    type: String,
    required: true
  },
  campaignName: {
    type: String,
    default: "Direct Message",
    trim: true
  },
  status: {
    type: String,
    enum: ["pending", "sent", "delivered", "failed"],
    default: "pending",
    lowercase: true
  },
  metaMessageId: {
    type: String,
    default: ""
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

module.exports = mongoose.models.MessageLog || mongoose.model("MessageLog", MessageLogSchema);