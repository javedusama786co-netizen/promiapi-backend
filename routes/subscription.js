const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware"); 
const User = require("../models/User"); 
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// 🛒 1. STRIPE CHECKOUT SESSION ROUTE (WITH OPTIONAL ADD-ONS)
router.post("/checkout", authMiddleware, async (req, res) => {
  const { planId, billingPeriod, addons } = req.body;
  
  let unitAmount = 0; 
  let planName = "";

  // Base Plan Pricing Calculation
  if (planId === "price_standard") {
    unitAmount = billingPeriod === "monthly" ? 1999 : 17999; // $19.99 / $179.99
    planName = "Standard Plan";
  } else if (planId === "price_premium") {
    unitAmount = billingPeriod === "monthly" ? 8999 : 79999; // $89.99 / $799.99
    planName = "Premium Engine";
  } else if (planId === "price_ultimate") {
    unitAmount = billingPeriod === "monthly" ? 44999 : 399999; // $449.99 / $3,999.99
    planName = "Ultimate Cluster";
  } else {
    return res.status(400).json({ success: false, message: "Invalid Plan Selected" });
  }

  try {
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

    // Build Line Items (Base Plan)
    const lineItems = [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `${planName} (${billingPeriod.toUpperCase()})`,
            description: "WhatsApp Cloud API Pipeline Subscription"
          },
          unit_amount: unitAmount, 
          recurring: {
            interval: billingPeriod === "monthly" ? "month" : "year",
          },
        },
        quantity: 1,
      }
    ];

    // Check & Add Selected Add-ons (One-time charges or recurring setup fees)
    if (addons?.supportCustomize) {
      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: {
            name: "Add-on: Support for Complete Customize Setup",
            description: "Hands-on technical guidance & setup"
          },
          unit_amount: 2999 // $29.99 in cents
        },
        quantity: 1
      });
    }

    if (addons?.verifiedPortfolio) {
      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: {
            name: "Add-on: Verified Business Portfolio Setup",
            description: "Meta Business Manager setup & official approval assistance"
          },
          unit_amount: 9999 // $99.99 in cents
        },
        quantity: 1
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: req.user.email || undefined,
      line_items: lineItems,
      success_url: `${frontendUrl}/dashboard/subscription?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/dashboard/subscription?false`,
      metadata: {
        userId: req.user.id || req.user._id, 
        planId: planId,
        billingPeriod: billingPeriod,
        addons: JSON.stringify(addons || {})
      }
    });

    res.json({ success: true, url: session.url });
  } catch (error) {
    console.error("Stripe Checkout Error:", error);
    res.status(500).json({ success: false, message: "Stripe session setup failed: " + error.message });
  }
});

// 🛍️ 2. DATABASE SYNCHRONIZATION ROUTE
router.post("/verify-payment", authMiddleware, async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ success: false, message: "Session ID missing." });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === "paid") {
      const { userId, planId, billingPeriod, addons } = session.metadata;

      const expiryDate = new Date();
      if (billingPeriod === "monthly") {
        expiryDate.setMonth(expiryDate.getMonth() + 1);
      } else {
        expiryDate.setFullYear(expiryDate.getFullYear() + 1);
      }

      let dbPlanName = "Standard";
      if (planId === "price_premium") dbPlanName = "Premium";
      if (planId === "price_ultimate") dbPlanName = "Ultimate";

      const parsedAddons = addons ? JSON.parse(addons) : {};

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        {
          $set: {
            plan: dbPlanName,
            subscribed: true,
            "subscription.planId": planId,
            "subscription.status": "active",
            "subscription.billingPeriod": billingPeriod,
            "subscription.startDate": new Date(),
            "subscription.endDate": expiryDate,
            "subscription.addons": {
              supportCustomize: Boolean(parsedAddons.supportCustomize),
              verifiedPortfolio: Boolean(parsedAddons.verifiedPortfolio)
            },
            "addons.supportCustomize": Boolean(parsedAddons.supportCustomize),
            "addons.verifiedPortfolio": Boolean(parsedAddons.verifiedPortfolio)
          }
        },
        { new: true }
      );

      return res.json({ 
        success: true, 
        message: "Subscription successfully activated!", 
        user: updatedUser 
      });
    }

    res.status(400).json({ success: false, message: "Payment status is pending or failed." });
  } catch (error) {
    console.error("Verification Error:", error);
    res.status(500).json({ success: false, message: "Internal Verification Error: " + error.message });
  }
});

// ⚡ 3. SUBSCRIPTION CHECK ENDPOINT
router.get("/user/subscription", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ success: false, message: "User workspace not found" });
    }

    const currentServerTime = new Date();
    let isPlanActive = user.subscribed || false;

    if (user.subscription && user.subscription.endDate) {
      if (currentServerTime > new Date(user.subscription.endDate)) {
        isPlanActive = false;
        await User.findByIdAndUpdate(userId, {
          $set: { "subscription.status": "expired", subscribed: false }
        });
      }
    }

    res.json({
      success: true,
      active: isPlanActive,
      subscribed: isPlanActive,
      planId: user.subscription?.planId || "price_free",
      addons: user.subscription?.addons || user.addons || {}
    });

  } catch (error) {
    console.error("Subscription checking failed:", error);
    res.status(500).json({ success: false, message: "Database validation crash." });
  }
});

module.exports = router;