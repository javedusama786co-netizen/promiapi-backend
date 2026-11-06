const mongoose = require("mongoose");

// A help / support request sent from the dashboard "Help & Support" window.
const supportTicketSchema = new mongoose.Schema(
  {
    ticketNo: { type: String, required: true, unique: true, index: true }, // e.g. PM-7K2X9A
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true }, // who sent it
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }, // the account it belongs to (admin)
    name: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    role: { type: String, default: "", trim: true },
    category: {
      type: String,
      enum: ["technical", "billing", "whatsapp", "campaigns", "feature", "other"],
      default: "other",
    },
    subject: { type: String, required: true, trim: true, maxlength: 140 },
    message: { type: String, required: true, trim: true, maxlength: 4000 },
    pageUrl: { type: String, default: "", maxlength: 500 },
    userAgent: { type: String, default: "", maxlength: 300 },
    status: { type: String, enum: ["open", "in_progress", "resolved", "closed"], default: "open", index: true },
    // optional reply from your team (shown to the customer in "My tickets")
    reply: { type: String, default: "", maxlength: 4000 },
    repliedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

supportTicketSchema.index({ ownerId: 1, createdAt: -1 });

module.exports = mongoose.models.SupportTicket || mongoose.model("SupportTicket", supportTicketSchema);
