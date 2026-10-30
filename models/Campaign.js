const mongoose = require("mongoose");

const FailureReasonSchema = new mongoose.Schema(
  {
    contactName: { type: String, default: "Unknown" },
    contactId: { type: String, default: "" },
    reason: { type: String, default: "UNKNOWN" },
    details: { type: String, default: "" }
  },
  { _id: false }
);

const CampaignSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, required: true },
    group: { type: String, required: true },
    targetGroup: { type: String, required: true },

    platform: {
      type: String,
      enum: ["whatsapp", "messenger", "instagram", "all"],
      default: "whatsapp"
    },

    templateName: { type: String, default: null },
    language: { type: String, default: "en_US" },
    mediaUrl: { type: String, default: null },
    message: { type: String, default: "" },

    totalContacts: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },

    lastError: { type: String, default: null },
    failureReasons: { type: [FailureReasonSchema], default: [] },

    status: {
      type: String,
      enum: ["PENDING", "SCHEDULED", "PROCESSING", "SENT", "CANCELLED", "FAILED"],
      default: "PENDING"
    },
    scheduledAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Campaign", CampaignSchema);