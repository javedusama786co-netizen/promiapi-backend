const mongoose = require("mongoose");

const FIELD_TYPES = ["text", "number", "date", "select", "boolean", "email", "phone", "url"];
const RESERVED_KEYS = [
  "name", "full_name", "first_name", "last_name", "phone", "group", "tags", "source_ad", "platform", "today",
  "id", "status", "created_at", "customer", "cf", "number", "email_address",
];

// Definition of one custom contact field (city, budget, interest ...). Values live on Contact.customFields.<key>
const CustomFieldSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // business owner (admin) id
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: [/^[a-z][a-z0-9_]{0,39}$/, "Key must start with a letter and contain only a-z, 0-9 and _ (max 40)."],
      validate: { validator: (v) => !RESERVED_KEYS.includes(v), message: "This key is reserved by the system." },
    },
    label: { type: String, required: true, trim: true, maxlength: 60 },
    type: { type: String, enum: FIELD_TYPES, default: "text" },
    options: { type: [{ type: String, trim: true, maxlength: 60 }], default: [] }, // for type "select"
    defaultValue: { type: String, default: "", maxlength: 120 }, // used in {{variables}} when the contact has no value
    description: { type: String, default: "", maxlength: 200 },  // shown in the UI and given to the AI as a hint
    aiRead: { type: Boolean, default: true },  // the AI may see this value in the customer profile
    aiWrite: { type: Boolean, default: true }, // the AI may save a value the customer tells it in chat
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

CustomFieldSchema.index({ userId: 1, key: 1 }, { unique: true });

CustomFieldSchema.pre("validate", function (next) {
  if (this.type === "select") {
    const clean = [...new Set((this.options || []).map((o) => String(o).trim()).filter(Boolean))];
    if (clean.length < 1) return next(new Error("A dropdown field needs at least one option."));
    this.options = clean.slice(0, 50);
  } else {
    this.options = [];
  }
  next();
});

module.exports = mongoose.models.CustomField || mongoose.model("CustomField", CustomFieldSchema);
module.exports.FIELD_TYPES = FIELD_TYPES;
module.exports.RESERVED_KEYS = RESERVED_KEYS;
