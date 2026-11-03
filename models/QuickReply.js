const mongoose = require("mongoose");

// 💬 Saved / canned replies ("Quick Replies") that agents can insert into the
// composer with one click. Scoped per business (same scope id used by chatRoutes).
const QuickReplySchema = new mongoose.Schema({
  // Business / admin scope (adminId || id) so a whole team shares one library
  businessId: {
    type: String,
    required: true,
    index: true
  },
  // Short label shown in the picker, e.g. "Price list"
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80
  },
  // Full message text. Supports the {{name}} placeholder (customer's first name)
  body: {
    type: String,
    required: true,
    trim: true,
    maxlength: 4096
  },
  // Optional grouping tag, e.g. "Pricing", "Delivery"
  category: {
    type: String,
    default: "",
    trim: true,
    maxlength: 40
  },
  // Who created it (used so only the creator or an admin can edit / delete)
  createdBy: {
    type: String,
    default: null
  }
}, { timestamps: true });

// Same title can't be saved twice inside one business
QuickReplySchema.index({ businessId: 1, title: 1 }, { unique: true });

module.exports = mongoose.models.QuickReply || mongoose.model("QuickReply", QuickReplySchema);
