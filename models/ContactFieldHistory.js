const mongoose = require("mongoose");

// Audit trail: who changed which custom field of which contact (dashboard, import, bulk edit, AI ...)
const ContactFieldHistorySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // business owner
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
    key: { type: String, required: true },
    oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
    newValue: { type: mongoose.Schema.Types.Mixed, default: null },
    source: { type: String, enum: ["manual", "import", "bulk", "api", "ai", "flow"], default: "manual" },
    actor: { type: String, default: null }, // user id, or "ai"
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

ContactFieldHistorySchema.index({ contactId: 1, at: -1 });
ContactFieldHistorySchema.index({ userId: 1, at: -1 });

module.exports = mongoose.models.ContactFieldHistory || mongoose.model("ContactFieldHistory", ContactFieldHistorySchema);
