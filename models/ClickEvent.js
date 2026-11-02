const mongoose = require("mongoose");

/**
 * One row per tracked interaction (QR scan, short-link click, CTA click, widget impression/open/lead).
 * Raw IPs are never stored; "visitor" is a salted SHA-256 hash used only for unique-visitor counts.
 */
const clickEventSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["qr", "shortlink", "cta", "widget"], required: true },
    refId: { type: mongoose.Schema.Types.ObjectId, required: true },
    refTitle: { type: String, default: "" },
    // click = scan/click, impression/open = widget funnel steps, lead = widget WhatsApp tap
    event: { type: String, enum: ["click", "impression", "open", "lead"], default: "click" },
    visitor: { type: String, default: "" },
    device: { type: String, default: "Unknown" }, // Mobile | Tablet | Desktop | Unknown
    os: { type: String, default: "Unknown" },
    browser: { type: String, default: "Unknown" },
    country: { type: String, default: "" }, // ISO-3166 alpha-2
    referrer: { type: String, default: "Direct" },
    page: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

clickEventSchema.index({ userId: 1, createdAt: -1 });
clickEventSchema.index({ userId: 1, type: 1, createdAt: -1 });
clickEventSchema.index({ userId: 1, refId: 1, createdAt: -1 });

module.exports = mongoose.model("ClickEvent", clickEventSchema);
