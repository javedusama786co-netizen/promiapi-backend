const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  orderId: { type: String, required: true, unique: true, index: true },
  customerName: { type: String },
  customerPhone: { type: String },
  totalPrice: { type: String, default: "0.00" },
  items: { type: String },
  status: { type: String, default: 'received', index: true },
  trackingNumber: { type: String },
  trackingUrl: { type: String },
  source: { type: String } // shopify ya woocommerce
}, { timestamps: true });

module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);