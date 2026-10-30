// models/MetaConfig.js
const mongoose = require("mongoose");

const metaConfigSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      index: true
    },
    platform: {
      type: String,
      enum: ["messenger", "instagram"],
      default: "messenger"
    },
    accessToken: { 
      type: String, 
      required: true 
    },
    pageId: { 
      type: String, 
      default: null 
    },
    instagramAccountId: { 
      type: String, 
      default: null 
    },
    appId: { 
      type: String, 
      default: null 
    },
    appSecret: { 
      type: String, 
      default: null 
    }
  },
  { timestamps: true, strict: false }
);

metaConfigSchema.index({ userId: 1, platform: 1 }, { unique: true });

module.exports = mongoose.models.MetaConfig || mongoose.model("MetaConfig", metaConfigSchema);