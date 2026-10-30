const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true,
    index: true 
  },
  title: { 
    type: String, 
    default: '' 
  },
  message: { 
    type: String, 
    required: true 
  },
  type: { 
    type: String, 
    enum: ['info', 'success', 'warning', 'error', 'campaign'], 
    default: 'info' 
  },
  link: { 
    type: String, 
    default: '' 
  },
  isRead: { 
    type: Boolean, 
    default: false,
    index: true 
  }
}, { timestamps: true });

module.exports = mongoose.model('Notification', NotificationSchema);