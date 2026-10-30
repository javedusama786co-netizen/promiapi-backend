const express = require("express");
const router = express.Router();
const axios = require("axios");
const mongoose = require("mongoose");
const { WooCommerceRestApi } = require("@woocommerce/woocommerce-rest-api");
const User = require("../models/User");

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://unawake-oversized-moneybags.ngrok-free.dev";

// 🔐 SUBSCRIPTION PLAN CHECK MIDDLEWARE
const verifySubscription = async (req, res, next) => {
  try {
    const { userId } = req.body;

    if (!userId || userId === "guest") {
      return res.status(403).json({
        success: false,
        error: "Access Denied: Please log in to connect stores."
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: "User account not found." });
    }

    const planId = user.subscription?.planId || user.plan || "price_free";
    const isSubscribed = user.subscribed !== undefined ? user.subscribed : planId !== "price_free";

    if (!isSubscribed || planId === "price_free") {
      return res.status(403).json({
        success: false,
        error: "Subscription Required: Upgrading your plan is required to auto-connect stores."
      });
    }

    req.targetUser = user;
    next();
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// 🛍️ 1. AUTO-REGISTER SHOPIFY WEBHOOK
router.post("/shopify/auto-connect", verifySubscription, async (req, res) => {
  try {
    const { userId, shopDomain, shopifyAccessToken } = req.body;

    if (!shopDomain || !shopifyAccessToken || !userId) {
      return res.status(400).json({ success: false, error: "Missing required store credentials!" });
    }

    const cleanDomain = shopDomain.replace(/https?:\/\//, "").replace(/\/$/, "");
    const targetWebhookUrl = `${PUBLIC_BASE_URL}/api/webhook/shopify/${userId}`;
    const shopifyApiUrl = `https://${cleanDomain}/admin/api/2024-01/webhooks.json`;
    
    const response = await axios.post(
      shopifyApiUrl,
      {
        webhook: {
          topic: "orders/create",
          address: targetWebhookUrl,
          format: "json"
        }
      },
      {
        headers: {
          "X-Shopify-Access-Token": shopifyAccessToken,
          "Content-Type": "application/json"
        }
      }
    );

    return res.json({
      success: true,
      message: "Shopify Store Connected & Webhook Auto-Registered Successfully!",
      webhookData: response.data
    });

  } catch (err) {
    console.error("❌ Shopify Auto-Connect Error:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      error: err.response?.data?.errors || "Failed to register Shopify Webhook automatically."
    });
  }
});

// 🛒 2. AUTO-REGISTER WOOCOMMERCE WEBHOOK
router.post("/woocommerce/auto-connect", verifySubscription, async (req, res) => {
  try {
    const { userId, storeUrl, consumerKey, consumerSecret } = req.body;

    if (!storeUrl || !consumerKey || !consumerSecret || !userId) {
      return res.status(400).json({ success: false, error: "Missing WooCommerce API details!" });
    }

    const WooCommerce = new WooCommerceRestApi({
      url: storeUrl,
      consumerKey: consumerKey,
      consumerSecret: consumerSecret,
      version: "wc/v3"
    });

    const targetWebhookUrl = `${PUBLIC_BASE_URL}/api/webhook/woocommerce/${userId}`;

    const response = await WooCommerce.post("webhooks", {
      name: "WhatsApp Engine Order Webhook",
      topic: "order.created",
      delivery_url: targetWebhookUrl,
      status: "active"
    });

    return res.json({
      success: true,
      message: "WooCommerce Connected & Webhook Auto-Created!",
      webhookData: response.data
    });

  } catch (err) {
    console.error("❌ WooCommerce Auto-Connect Error:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      error: "Failed to connect WooCommerce Store automatically."
    });
  }
});

// 🌐 3. EXTERNAL SERVER / BANK CBS API SETTINGS CONFIGURATION
router.post("/external-api/save-config", verifySubscription, async (req, res) => {
  try {
    const { userId, baseUrl, apiKey, apiSecret, description } = req.body;

    if (!userId || !baseUrl) {
      return res.status(400).json({ success: false, error: "Missing required External API / CBS URL!" });
    }

    const AiBotSettings = mongoose.models.AiBotSettings || require("../models/AiBotSettings");

    let settings = await AiBotSettings.findOne({ userId });
    if (!settings) {
      settings = new AiBotSettings({ userId });
    }

    settings.externalApi = {
      enabled: true,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey ? apiKey.trim() : "",
      apiSecret: apiSecret ? apiSecret.trim() : "",
      description: description || "Bank CBS / External Private Server API"
    };

    await settings.save();

    return res.json({
      success: true,
      message: "External Server / Bank CBS API Settings Saved & Connected Successfully!",
      externalApi: settings.externalApi
    });

  } catch (err) {
    console.error("❌ External API Config Error:", err.message);
    return res.status(500).json({
      success: false,
      error: "Failed to save External Server / Bank CBS configuration."
    });
  }
});

module.exports = router;