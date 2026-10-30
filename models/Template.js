const mongoose = require('mongoose');

const TemplateSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, 
  title: { type: String, required: true },
  name: { type: String }, 
  content: { type: String, required: true },
  
  // Header aur Footer fields
  headerType: { 
    type: String, 
    enum: ['none', 'text', 'image', 'document', 'audio', 'video'], 
    default: 'none' 
  },
  headerText: { type: String, default: "" }, 
  footerText: { type: String, default: "" },

  status: { 
    type: String, 
    enum: ['APPROVED', 'PENDING', 'REJECTED'], 
    default: 'PENDING' 
  },
  language: { type: String, default: 'en_US' },
  category: { type: String, default: 'UTILITY' },

  delayTime: { type: Number, default: 0 }, 
  mediaType: { 
    type: String, 
    enum: ['none', 'text', 'image', 'document', 'audio', 'video'], // 🟢 Fixed: 'text' added
    default: 'none' 
  },
  mediaUrl: { type: String, default: "" }, 
  buttons: [{
    buttonText: { type: String, trim: true },
    buttonType: { type: String, enum: ['reply', 'url', 'call'], default: 'reply' },
    value: { type: String, trim: true } 
  }]
}, { timestamps: true });

module.exports = mongoose.model('Template', TemplateSchema);