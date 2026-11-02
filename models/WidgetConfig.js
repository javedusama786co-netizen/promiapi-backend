const mongoose = require("mongoose");

const widgetConfigSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    // Public key used in the embed snippet, so settings can change without re-pasting code.
    publicKey: { type: String, unique: true, sparse: true },
    enabled: { type: Boolean, default: true },

    phoneNumber: { type: String, default: "" },
    title: { type: String, default: "Support Team" },
    subtitle: { type: String, default: "Typically replies within minutes" },
    welcomeMessage: { type: String, default: "Hi! How can we help you?" },
    prefilledMessage: { type: String, default: "Hi! I have a question." },
    buttonLabel: { type: String, default: "Chat on WhatsApp" },
    offlineMessage: { type: String, default: "We're offline right now. Leave a message and we'll reply when we're back." },

    position: { type: String, enum: ["right", "left"], default: "right" },
    brandColor: { type: String, default: "#128C7E" },
    showBadge: { type: Boolean, default: true },
    autoOpenDelay: { type: Number, default: 0, min: 0, max: 120 }, // seconds, 0 = never
    showOnMobile: { type: Boolean, default: true },
    showOnDesktop: { type: Boolean, default: true },

    hours: {
      enabled: { type: Boolean, default: false },
      timezone: { type: String, default: "Asia/Karachi" },
      start: { type: String, default: "09:00" },
      end: { type: String, default: "18:00" },
      days: { type: [Number], default: [1, 2, 3, 4, 5] }, // 0 = Sunday
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WidgetConfig", widgetConfigSchema);
