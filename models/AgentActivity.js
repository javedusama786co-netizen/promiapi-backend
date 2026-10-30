const mongoose = require("mongoose");

/**
 * One document per team member per calendar day (in APP_TIMEZONE).
 *
 * `hours` holds the same numbers split by hour of the day, so the "Today"
 * chart can show a real hour-by-hour breakdown:
 *   hours: { "9": { messages: 4, minutes: 25, chats: 1 }, "10": { ... } }
 */
const AgentActivitySchema = new mongoose.Schema({
  memberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "TeamMember",
    required: true
  },
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  day: {
    type: String, // "YYYY-MM-DD"
    required: true
  },
  messagesSent: { type: Number, default: 0 },
  activeMinutes: { type: Number, default: 0 },
  chatsHandled: { type: Number, default: 0 },
  hours: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { minimize: false });

// One row per member per day. Also makes range queries fast.
AgentActivitySchema.index({ memberId: 1, day: 1 }, { unique: true });
// Used by the team list to fetch "today" for every member at once.
AgentActivitySchema.index({ adminId: 1, day: 1 });

module.exports = mongoose.model("AgentActivity", AgentActivitySchema);
