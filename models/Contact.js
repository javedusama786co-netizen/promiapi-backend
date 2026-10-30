const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    platform: {
      type: String,
      enum: ['whatsapp', 'messenger', 'instagram'],
      default: 'whatsapp',
      lowercase: true,
      trim: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    // Required flag removed for multi-platform flexibility
    phone: {
      type: String,
      default: null,
      trim: true
    },
    recipientId: {
      type: String,
      default: null,
      trim: true
    },
    facebookId: {
      type: String,
      default: null,
      trim: true
    },
    instagramId: {
      type: String,
      default: null,
      trim: true
    },
    profilePicUrl: {
      type: String,
      default: null,
      trim: true
    },
    group: {
      type: String,
      default: 'General Leads',
      trim: true
    },
    sourceAd: {
      type: String,
      default: null,
      trim: true
    },
    tags: [
      {
        type: String,
        trim: true
      }
    ],
    status: {
      type: String,
      enum: ['ACTIVE', 'INVALID', 'BLOCKED', 'PENDING'],
      default: 'ACTIVE'
    }
  },
  {
    timestamps: true
  }
);

// Search optimization indexing
contactSchema.index({ userId: 1, platform: 1 });
contactSchema.index({ userId: 1, phone: 1 });
contactSchema.index({ userId: 1, recipientId: 1 });

module.exports = mongoose.model('Contact', contactSchema);