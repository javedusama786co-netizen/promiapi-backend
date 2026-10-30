const mongoose = require("mongoose");

const socialConfigSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      index: true
    },
    platform: {
      type: String,
      enum: ["whatsapp", "whatsapp_official", "whatsapp_qr", "instagram", "messenger"],
      required: true,
      default: "whatsapp"
    },
    accessToken: { 
      type: String, 
      required: false 
    },
    phoneNumberId: { 
      type: String,
      default: null 
    },
    businessAccountId: { 
      type: String,
      default: null 
    },
    pageId: { 
      type: String,
      default: null 
    },
    instagramAccountId: { 
      type: String,
      default: null 
    },
    webhookVerifyToken: { 
      type: String, 
      default: null
    },
    // 📞 New Call Integration Field added
    callEnabled: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true, strict: false }
);

socialConfigSchema.index({ userId: 1, platform: 1 }, { unique: true });

const SocialModel = mongoose.models.WhatsAppConfig || mongoose.model("WhatsAppConfig", socialConfigSchema);
if (!mongoose.models.MetaConfig) {
  mongoose.model("MetaConfig", socialConfigSchema);
}

module.exports = SocialModel;