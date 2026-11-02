// NOTE: superset of the fields the routes already used (userId, title, phoneNumber,
// defaultMessage, fgColor, bgColor, logoUrl, scansCount). If your existing model has
// extra fields, merge them in rather than deleting them.
const mongoose = require("mongoose");

const qrSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, default: "WhatsApp Marketing QR", trim: true },
    phoneNumber: { type: String, required: true, trim: true },
    defaultMessage: { type: String, default: "" },
    status: { type: String, enum: ["active", "paused"], default: "active" },

    // design
    fgColor: { type: String, default: "#101828" },
    bgColor: { type: String, default: "#ffffff" },
    eyeColor: { type: String, default: "" },
    logoUrl: { type: String, default: "" },
    logoSize: { type: Number, default: 17 }, // % of QR width
    logoPadding: { type: Number, default: 4 },
    removeBehindLogo: { type: Boolean, default: true },
    size: { type: Number, default: 512 },
    ecLevel: { type: String, enum: ["L", "M", "Q", "H"], default: "M" },
    quietZone: { type: Number, default: 10 },
    eyeRadius: { type: Number, default: 8 },
    qrStyle: { type: String, enum: ["squares", "dots", "fluid"], default: "dots" },

    scansCount: { type: Number, default: 0 },
    lastScannedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("QRCode", qrSchema);
