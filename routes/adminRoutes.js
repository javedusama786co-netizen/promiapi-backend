const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const User = require("../models/User");

// MASTER OWNER SECURITY CONFIGURATION
// Better: set OWNER_EMAIL and JWT_SECRET in your .env file instead of hardcoding.
const DEVELOPER_OWNER_EMAIL = process.env.OWNER_EMAIL || "javedusama786.co@gmail.com";

const STATUSES = ["Active", "Suspended", "Terminated"];

// ADMIN PROTECTION MIDDLEWARE
const verifyOwnerAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Unauthorized access. Token missing." });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "your_jwt_secret_key");
    const userId = decoded.id || decoded._id || decoded.userId;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Invalid Token Structure: User ID missing in payload." });
    }

    const user = await User.findById(userId);

    if (!user || user.email.toLowerCase() !== DEVELOPER_OWNER_EMAIL.toLowerCase()) {
      return res.status(403).json({ success: false, message: "Access Denied: Only System Owner can access this panel." });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid or expired session token.", error: error.message });
  }
};

// Owner account must never be suspended / terminated / deleted from the panel
const isSelf = (req, id) => String(req.user._id) === String(id);
const blockSelf = (res) =>
  res.status(400).json({ success: false, message: "You cannot do this to the owner account." });

// 1. GET ALL USERS (every field except password)
router.get("/users", verifyOwnerAdmin, async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ createdAt: -1 }).lean();
    res.status(200).json({ success: true, count: users.length, users });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching users", error: error.message });
  }
});

// 2. BULK STATUS CHANGE  (must stay above the /users/:id routes)
router.post("/users/bulk-status", verifyOwnerAdmin, async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "No users selected." });
    }
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status value: " + status });
    }
    const safeIds = ids.filter((id) => !isSelf(req, id));
    const result = await User.updateMany({ _id: { $in: safeIds } }, { $set: { status } });
    res.status(200).json({
      success: true,
      message: `${result.modifiedCount ?? result.nModified ?? 0} user(s) set to ${status}`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error in bulk update", error: error.message });
  }
});

// 3. GET ONE USER
router.get("/users/:id", verifyOwnerAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password").lean();
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    res.status(200).json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching user", error: error.message });
  }
});

// 4. EDIT PROFILE (whitelisted fields only)
// NOTE: fields that are not in your User schema (e.g. phone, city, country) are silently ignored by
// Mongoose in strict mode, so add them to models/User.js if you want them saved.
router.patch("/users/:id", verifyOwnerAdmin, async (req, res) => {
  try {
    const allowed = ["firstName", "lastName", "phone", "city", "country"];
    const update = {};
    allowed.forEach((k) => {
      if (typeof req.body[k] === "string") update[k] = req.body[k].trim();
    });
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to update." });
    }
    const user = await User.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).select("-password");
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    res.status(200).json({ success: true, message: "Profile updated", user });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error updating profile", error: error.message });
  }
});

// 5. UPDATE USER STATUS
router.patch("/users/:id/status", verifyOwnerAdmin, async (req, res) => {
  try {
    const { status } = req.body;

    if (!STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status value: " + status });
    }
    if (isSelf(req, req.params.id) && status !== "Active") return blockSelf(res);

    const updatedUser = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true, runValidators: false }
    ).select("-password");

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.status(200).json({ success: true, message: `User status changed to ${status}`, user: updatedUser });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error updating status", error: error.message });
  }
});

// 6. MANUALLY UPDATE SUBSCRIPTION & ADD-ONS
router.patch("/users/:id/subscription", verifyOwnerAdmin, async (req, res) => {
  try {
    const { planId, days, supportCustomize, verifiedPortfolio } = req.body;

    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(startDate.getDate() + (parseInt(days) || 30));

    let dbPlanName = "Standard";
    if (planId === "price_premium" || planId === "price_pro") dbPlanName = "Premium";
    if (planId === "price_ultimate" || planId === "price_enterprise") dbPlanName = "Ultimate";

    const updatedUser = await User.findByIdAndUpdate(
      req.params.id,
      {
        plan: dbPlanName,
        subscribed: true,
        "subscription.planId": planId,
        "subscription.status": "active",
        "subscription.startDate": startDate,
        "subscription.endDate": endDate,
        "subscription.isManual": true,
        "subscription.addons": {
          supportCustomize: Boolean(supportCustomize),
          verifiedPortfolio: Boolean(verifiedPortfolio),
        },
        "addons.supportCustomize": Boolean(supportCustomize),
        "addons.verifiedPortfolio": Boolean(verifiedPortfolio),
      },
      { new: true }
    ).select("-password");

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.status(200).json({ success: true, message: "Subscription and add-ons updated successfully", user: updatedUser });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error updating subscription", error: error.message });
  }
});

// 7. EXTEND SUBSCRIPTION BY N DAYS (counts from today if already expired)
router.post("/users/:id/subscription/extend", verifyOwnerAdmin, async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 30;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const current = user.subscription?.endDate ? new Date(user.subscription.endDate) : new Date(0);
    const base = current > new Date() ? current : new Date();
    const endDate = new Date(base);
    endDate.setDate(endDate.getDate() + days);

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      {
        subscribed: true,
        "subscription.status": "active",
        "subscription.endDate": endDate,
        "subscription.isManual": true,
      },
      { new: true }
    ).select("-password");

    res.status(200).json({ success: true, message: `Subscription extended by ${days} days`, user: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error extending subscription", error: error.message });
  }
});

// 8. CANCEL SUBSCRIPTION
router.post("/users/:id/subscription/cancel", verifyOwnerAdmin, async (req, res) => {
  try {
    const updated = await User.findByIdAndUpdate(
      req.params.id,
      {
        subscribed: false,
        "subscription.status": "cancelled",
        "subscription.endDate": new Date(),
      },
      { new: true }
    ).select("-password");
    if (!updated) return res.status(404).json({ success: false, message: "User not found" });
    res.status(200).json({ success: true, message: "Subscription cancelled", user: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error cancelling subscription", error: error.message });
  }
});

// 9. DELETE USER PERMANENTLY
router.delete("/users/:id", verifyOwnerAdmin, async (req, res) => {
  try {
    if (isSelf(req, req.params.id)) return blockSelf(res);
    const deleted = await User.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: "User not found" });
    res.status(200).json({ success: true, message: "User deleted permanently" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error deleting user", error: error.message });
  }
});

module.exports = router;