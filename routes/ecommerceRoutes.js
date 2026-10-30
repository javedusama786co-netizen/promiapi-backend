const express = require("express");
const router = express.Router();
const User = require("../models/User");
// Aapka existing WhatsApp messaging service / helper import karein
const { sendWhatsAppTemplate } = require("../services/whatsappService");

// ==========================================
// 1. SHOPIFY ABANDONED CART WEBHOOK
// ==========================================
router.post("/shopify/abandoned-cart/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const cartData = req.body;

    // User & Plan Subscription Check
    const user = await User.findById(userId);
    if (!user || !user.subscribed || user.plan === "price_standard") {
      return res.status(403).json({ 
        success: false, 
        message: "E-commerce Automation requires Premium or Ultimate Plan." 
      });
    }

    // Cart Details Extract Karein
    const customerPhone = cartData.phone || cartData.customer?.phone;
    const customerName = cartData.customer?.first_name || "Customer";
    const checkoutUrl = cartData.abandoned_checkout_url;

    if (customerPhone) {
      // Automatic WhatsApp Template Trigger
      await sendWhatsAppTemplate({
        adminId: userId,
        to: customerPhone,
        templateName: "abandoned_cart_reminder",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: customerName },
              { type: "text", text: checkoutUrl }
            ]
          }
        ]
      });
    }

    res.status(200).json({ success: true, message: "Abandoned cart webhook processed" });
  } catch (error) {
    console.error("🚨 Shopify Webhook Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 2. WOOCOMMERCE ORDER CONFIRMATION WEBHOOK
// ==========================================
router.post("/woocommerce/order-created/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const orderData = req.body;

    const user = await User.findById(userId);
    if (!user || !user.subscribed) {
      return res.status(403).json({ success: false, message: "Subscription inactive." });
    }

    const customerPhone = orderData.billing?.phone;
    const customerName = orderData.billing?.first_name || "Customer";
    const orderId = orderData.id;
    const totalAmount = orderData.total;

    if (customerPhone) {
      await sendWhatsAppTemplate({
        adminId: userId,
        to: customerPhone,
        templateName: "order_confirmation",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: customerName },
              { type: "text", text: String(orderId) },
              { type: "text", text: String(totalAmount) }
            ]
          }
        ]
      });
    }

    res.status(200).json({ success: true, message: "WooCommerce order webhook processed" });
  } catch (error) {
    console.error("🚨 WooCommerce Webhook Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;