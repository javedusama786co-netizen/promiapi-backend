const express = require("express");
const router = express.Router();
const tenantController = require("../controllers/tenantController");
const auth = require("../middleware/auth"); // JWT auth middleware

// 🚀 Optional Auth Middleware:
// Agar request header mein token hai toh parse karega (User ID milne par isolate record milega),
// lakin token na hone par request block nahi karega (Public/Guest domain resolution ke liye).
const optionalAuth = (req, res, next) => {
  if (req.headers.authorization) {
    return auth(req, res, next);
  }
  next();
};

// ==========================================
// 1. GET Tenant Config (GET /api/tenant/config)
// ==========================================
// Domain query parameter aur optional Auth token dono ko support karta hai
router.get("/config", optionalAuth, tenantController.getBrandingByDomain);

// ==========================================
// 2. UPDATE Tenant Branding (PUT /api/tenant/update)
// ==========================================
// Fully Protected Route - Sirf logged-in Vendor Admin apna branding update kar sakega
router.put("/update", auth, tenantController.updateBranding);

module.exports = router;