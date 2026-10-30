const express = require("express");
const router = express.Router();
const MessageLog = require("../models/MessageLog");
const { protect } = require("../middleware/authMiddleware"); // Aapka auth middleware

// @route   GET /api/logs
// @desc    Get all message logs based on user role
router.get("/", protect, async (req, res) => {
  try {
    let query = {};

    // Role-based logic: Admin sab dekh sakta hai, Agent sirf apne logs
    if (req.user.role === "Agent") {
      query.userId = req.user.id;
    } else {
      // Agar admin hai toh ho sakta hai aap pooray company/workspace ke logs dikhana chahein
      // query.companyId = req.user.companyId; (agar aap company level tracking kar rahe hain)
    }

    // Latest messages sabse upar dikhane ke liye sort by timestamp
    const logs = await MessageLog.find(query)
      .populate("userId", "firstName lastName") // Sender ka naam nikalne ke liye
      .sort({ timestamp: -1 })
      .limit(100); // UI performance ke liye limit lagai

    res.json({ success: true, logs });
  } catch (err) {
    console.error("Error fetching logs:", err);
    res.status(500).json({ success: false, message: "Server error while fetching logs" });
  }
});

module.exports = router;