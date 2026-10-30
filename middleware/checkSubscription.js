// middleware/checkSubscription.js
const PLAN_LIMITS = require("../config/planLimits");

const checkPlanAccess = (requiredFeature) => {
  return (req, res, next) => {
    const user = req.user;

    // 1. Check active subscription
    if (!user.subscribed || user.subscription?.status !== "active") {
      return res.status(403).json({ 
        success: false, 
        message: "Aap ka subscription plan active nahi hai. Barah-e-karam plan upgrade karein." 
      });
    }

    const userPlanId = user.subscription?.planId || "price_free";
    const limits = PLAN_LIMITS[userPlanId] || PLAN_LIMITS.price_free;

    // 2. Check feature permission
    if (requiredFeature && !limits[requiredFeature]) {
      return res.status(403).json({ 
        success: false, 
        message: "Yeh feature aap ke current plan mein available nahi hai." 
      });
    }

    req.userLimits = limits;
    next();
  };
};

module.exports = checkPlanAccess;