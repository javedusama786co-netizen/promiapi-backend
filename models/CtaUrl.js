const mongoose = require("mongoose");

const ctaUrlSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    label: { type: String, required: true, trim: true },
    targetUrl: { type: String, required: true, trim: true },
    // Short public code used in the tracking link: {BASE}/c/{code}
    // Also the value for the dynamic {{1}} suffix of a WhatsApp template URL button.
    code: { type: String, unique: true, sparse: true, trim: true },
    status: { type: String, enum: ["active", "paused"], default: "active" },
    expiresAt: { type: Date, default: null },
    utmSource: { type: String, default: "", trim: true },
    utmMedium: { type: String, default: "", trim: true },
    utmCampaign: { type: String, default: "", trim: true },
    clicks: { type: Number, default: 0 },
    lastClickedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CtaUrl", ctaUrlSchema);
