const mongoose = require("mongoose");

const widgetConfigSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    phoneNumber: {
      type: String,
      default: "",
    },
    title: {
      type: String,
      default: "Support Team",
    },
    welcomeMessage: {
      type: String,
      default: "Hi! How can we help you?",
    },
    position: {
      type: String,
      enum: ["right", "left"],
      default: "right",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WidgetConfig", widgetConfigSchema);