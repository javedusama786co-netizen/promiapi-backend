// routes/messageLog.js
const express = require("express");
const router = express.Router();
const MessageLog = require("../models/MessageLog");
const { protect } = require("../middleware/authMiddleware");

// GET /api/message-logs
router.get("/", protect, async (req, res) => {
  try {
    // Database se user ke specific logs nikalna
    const logs = await MessageLog.find({ userId: req.user.id }).sort({ createdAt: -1 });

    // AGAR DATABASE KHALI HAI: Toh user ko khali screen dikhane ke bajaye testing ke liye dummy logs bhej do
    if (logs.length === 0) {
      const temporaryLogs = [
        {
          _id: "dummy1",
          receiverNumber: "+923001234567",
          messageBody: "Salam! Yeh temporary campaign message hai kyunki aapka database abhi khali hai.",
          campaignName: "TikTok Earbuds Ad",
          status: "delivered",
          createdAt: new Date()
        },
        {
          _id: "dummy2",
          receiverNumber: "+923219876543",
          messageBody: "Direct chat dummy message log template testing.",
          campaignName: "Direct Message",
          status: "pending",
          createdAt: new Date()
        }
      ];
      return res.status(200).json({ success: true, logs: temporaryLogs });
    }

    // Agar database mein real data mil gaya toh wo send karein
    return res.status(200).json({
      success: true,
      logs: logs 
    });
  } catch (error) {
    console.error("Error fetching logs:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;