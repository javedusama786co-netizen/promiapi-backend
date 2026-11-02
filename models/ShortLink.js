const mongoose = require("mongoose");

const shortLinkSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, default: "Untitled Short Link", trim: true },
    slug: { type: String, required: true, unique: true, trim: true },
    phoneNumber: { type: String, required: true, trim: true },
    defaultMessage: { type: String, default: "" },
    status: { type: String, enum: ["active", "paused"], default: "active" },
    expiresAt: { type: Date, default: null },
    clicks: { type: Number, default: 0 },
    lastClickedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ShortLink", shortLinkSchema);
