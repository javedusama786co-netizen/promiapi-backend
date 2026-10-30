const mongoose = require("mongoose");

const TeamMemberSchema = new mongoose.Schema({
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  firstName: {
    type: String,
    required: true,
    trim: true
  },
  lastName: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  phoneNumber: {
    type: String,
    required: true,
    trim: true
  },
  password: {
    type: String
  },
  role: {
    type: String,
    enum: ["Agent", "Manager"],
    default: "Agent"
  },
  permissions: {
    manageContacts: { type: Boolean, default: false },
    manageTemplates: { type: Boolean, default: false },
    manageCampaigns: { type: Boolean, default: false },
    administrative: { type: Boolean, default: false },
    manageBotflow: { type: Boolean, default: false }
  },
  status: {
    type: String,
    enum: ["Active", "Pending", "Inactive"],
    default: "Pending"
  },
  activationToken: {
    type: String
  },
  
  // AGENT PERFORMANCE & ACTIVITY TRACKING METRICS
  metrics: {
    totalMessagesSent: { type: Number, default: 0 },
    chatsHandled: { type: Number, default: 0 },
    lastActiveAt: { type: Date },
    totalActiveTimeMinutes: { type: Number, default: 0 }
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

TeamMemberSchema.index({ adminId: 1, email: 1 }, { unique: true });

module.exports = mongoose.model("TeamMember", TeamMemberSchema);