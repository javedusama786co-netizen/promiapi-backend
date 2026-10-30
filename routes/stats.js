const express = require("express");
const router = express.Router();
const ChatMessage = require("../models/ChatMessage");
const Contact = require("../models/Contact");
const auth = require("../middleware/auth");

// @route   GET /api/stats/dashboard
router.get("/dashboard", auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const adminId = req.user.adminId; 
    const role = req.user.role ? req.user.role.toLowerCase() : "admin";

    let query = {};
    let contactQuery = {};

    // 🕵️‍♂️ Role configuration matrix for Chats & Stats
    if (role === "agent") {
      query.userId = userId;
      contactQuery = { $or: [{ userId: userId }, { userId: adminId }] };
    } else {
      query.userId = userId;
      
      // 👑 Admin security layer: count only his own + his agents' contacts
      try {
        const mongoose = require('mongoose');
        const User = mongoose.model('User'); 
        const agents = await User.find({ adminId: userId }).select('_id');
        const agentIds = agents.map(agent => agent._id);

        contactQuery = { $or: [{ userId: userId }, { userId: { $in: agentIds } }] };
      } catch (modelErr) {
        contactQuery = { userId: userId };
      }
    }

    // 📊 Ab counts database se filtered query ke sath uthenge
    const totalSent = await ChatMessage.countDocuments({ ...query, sender: "me" });
    const totalReceived = await ChatMessage.countDocuments({ ...query, sender: "them" });
    const totalDelivered = await ChatMessage.countDocuments({ ...query, sender: "me", status: "delivered" });
    const totalFailed = await ChatMessage.countDocuments({ ...query, sender: "me", status: "failed" });
    
    // 🚀 FIXED: Yahan pehle generic count thaa, ab filtered contactQuery chalegi
    const totalContacts = await Contact.countDocuments(contactQuery);

    return res.status(200).json({
      success: true,
      stats: {
        totalSent,
        totalReceived,
        totalDelivered,
        totalFailed,
        totalContacts,
        deliveryRate: totalSent > 0 ? ((totalDelivered / totalSent) * 100).toFixed(1) + "%" : "0%"
      }
    });

  } catch (error) {
    console.error("Dashboard Stats Error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch analytics metrics." });
  }
});

module.exports = router;