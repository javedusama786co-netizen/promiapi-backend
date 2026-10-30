const mongoose = require("mongoose");

const userSessionSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true }, // Customer ka phone number
  currentStep: { type: String, default: "START" },       // User kis level par hai
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("UserSession", userSessionSchema);