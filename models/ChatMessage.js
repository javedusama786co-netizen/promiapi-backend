const mongoose = require("mongoose");

const ChatMessageSchema = new mongoose.Schema({
  // 🆔 Meta Message ID / QR Message ID
  messageId: {
    type: String,
    index: true,
    default: null
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: false
  },
  // 🌐 Platform Identification (Multi-channel & QR support added)
  platform: {
    type: String,
    enum: ["whatsapp", "whatsapp_qr", "instagram", "messenger"],
    default: "whatsapp",
    index: true
  },
  // 📱 Phone number for WhatsApp / Unique User ID for IG & Messenger
  customerPhone: {
    type: String,
    required: false,
    index: true
  },
  customerId: {
    type: String,
    default: null
  },
  customerName: {
    type: String,
    default: "Unknown Customer"
  },
  sender: {
    type: String,
    enum: ["me", "them"],
    default: "me"
  },
  text: {
    type: String,
    default: ""
  },
  // 📸 Multi-Media, Interactive & Call Support
  type: {
    type: String,
    enum: ["text", "image", "video", "audio", "document", "voice", "template", "interactive", "call"],
    default: "text"
  },
  mediaUrl: {
    type: String,
    default: null
  },
  // 📞 Call Specific Metadata Fields
  callDuration: {
    type: Number,
    default: 0
  },
  callDirection: {
    type: String,
    enum: ["inbound", "outbound", null],
    default: null
  },
  recordingUrl: {
    type: String,
    default: null
  },
  // 🤖 Bot Message Flag
  isBotMessage: {
    type: Boolean,
    default: false
  },
  // 📦 Archive Support for QR Reconnection
  archived: {
    type: Boolean,
    default: false,
    index: true
  },
  // 👤 Agent Assignment Context (🟢 FIXED: Changed from ObjectId to Mixed to support "human" string and IDs)
  assignedTo: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  // 📩 Message Transmission Status
  status: {
    type: String,
    enum: ["sent", "delivered", "read", "failed", "pending", "unread"],
    default: "sent"
  },
  // 🏷️ Overall Chat Thread Lifecycle Status
  chatStatus: {
    type: String,
    enum: ["active", "pending", "completed"],
    default: "active"
  },
  campaignName: {
    type: String,
    default: "Direct Message"
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, { strict: false });

module.exports = mongoose.models.ChatMessage || mongoose.model("ChatMessage", ChatMessageSchema);