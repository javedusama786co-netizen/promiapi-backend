const mongoose = require("mongoose");

const qrCodeSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    title: {
      type: String,
      default: "Untitled WhatsApp QR",
      trim: true,
    },
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
    },
    defaultMessage: {
      type: String,
      default: "",
    },
    fgColor: {
      type: String,
      default: "#0f172a",
    },
    bgColor: {
      type: String,
      default: "#ffffff",
    },
    logoUrl: {
      type: String,
      default: "",
    },
    scansCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("QRCode", qrCodeSchema);