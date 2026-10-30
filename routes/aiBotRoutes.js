const express = require("express");
const router = express.Router();
const { getSettings, saveSettings } = require("../controllers/aiBotController");
const authMiddleware = require("../middleware/auth");

// ⚙️ AI Bot Settings & Bank CBS / External API Routes
router.get("/settings", authMiddleware, getSettings);
router.post("/settings", authMiddleware, saveSettings);

module.exports = router;