const mongoose = require("mongoose");

const BOT_TYPES = ["simple", "media", "interactive", "template"];
const MATCH_TYPES = ["exact", "contains", "startsWith"];
const BUTTON_TYPES = ["quick_reply", "url", "phone"];

const ButtonSchema = new mongoose.Schema(
  {
    id: { type: String },
    type: { type: String, enum: BUTTON_TYPES, default: "quick_reply" },
    text: { type: String, required: true, trim: true, maxlength: 20 },
    payload: { type: String },
    url: { type: String },
    phone: { type: String },
  },
  { _id: false }
);

const BotReplySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    botType: { type: String, required: true, enum: BOT_TYPES },

    keyword: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    matchType: { type: String, enum: MATCH_TYPES, default: "exact" },
    level: { type: String, default: "ANY", trim: true }, // session routing: "ANY" or a specific level
    isActive: { type: Boolean, default: true },

    replyText: { type: String, maxlength: 4096 },
    footerText: { type: String, maxlength: 60 },
    mediaUrl: { type: String },
    templateId: { type: String },
    buttons: { type: [ButtonSchema], default: [] },

    // Usage stats (updated by the webhook through BotReply.recordHit)
    hitCount: { type: Number, default: 0 },
    lastTriggeredAt: { type: Date },
  },
  { timestamps: true } // adds createdAt (existing values are kept) + updatedAt
);

BotReplySchema.index({ userId: 1, keyword: 1 }, { unique: true });
BotReplySchema.index({ userId: 1, isActive: 1 });

// ---------- Matching (single source of truth for webhook + "Test a message") ----------

const normalizeText = (value) =>
  String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

const MATCH_RANK = { exact: 3, startsWith: 2, contains: 1 };

const ruleMatches = (rule, text) => {
  const keyword = normalizeText(rule.keyword);
  if (!keyword) return false;
  switch (rule.matchType || "exact") {
    case "contains":
      return text.includes(keyword);
    case "startsWith":
      return text.startsWith(keyword);
    case "exact":
    default:
      return text === keyword;
  }
};

/**
 * Finds the best active rule for an incoming message.
 * Priority: exact > startsWith > contains, then the longer (more specific) keyword.
 * `level` is optional: when given, only rules for "ANY" or that level are considered.
 */
BotReplySchema.statics.findMatch = async function (userId, incomingText, level) {
  const text = normalizeText(incomingText);
  if (!text) return null;

  const filter = { userId, isActive: true };
  if (level && level !== "ANY") filter.level = { $in: ["ANY", level] };

  const candidates = await this.find(filter).lean();

  const hits = candidates
    .filter((rule) => ruleMatches(rule, text))
    .sort((a, b) => {
      const rank = (MATCH_RANK[b.matchType || "exact"] || 0) - (MATCH_RANK[a.matchType || "exact"] || 0);
      return rank || b.keyword.length - a.keyword.length;
    });

  return hits[0] || null;
};

/** Call from the webhook after a rule actually replied. */
BotReplySchema.statics.recordHit = function (ruleId) {
  return this.updateOne(
    { _id: ruleId },
    { $inc: { hitCount: 1 }, $set: { lastTriggeredAt: new Date() } },
    { timestamps: false }
  );
};

module.exports = mongoose.model("BotReply", BotReplySchema);
module.exports.BOT_TYPES = BOT_TYPES;
module.exports.MATCH_TYPES = MATCH_TYPES;
module.exports.BUTTON_TYPES = BUTTON_TYPES;