const express = require("express");
const router = express.Router();
const Group = require("../models/Group");
const auth = require("../middleware/auth"); // Guard active kiya

// =========================================================
// 🔌 1. GET ALL GROUPS (FIXED FOR AGENT & ADMIN SCOPE MATCHING)
// =========================================================
router.get("/", auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const adminId = req.user.adminId;
    const role = req.user.role ? req.user.role.toLowerCase().trim() : 'admin';

    let query = {};

    if (role === 'agent' && adminId) {
      // Agent dekh sake: apne groups + admin ke groups
      query = { $or: [{ userId: userId }, { userId: adminId }] };
    } else {
      // 🌟 ADMIN FIX: Admin dekh sake apne groups + apne kisi agent dwara banaye gaye groups
      query = { $or: [{ userId: userId }, { adminId: userId }] };
    }

    const groups = await Group.find(query).sort({ createdAt: -1 });
    res.json({ success: true, groups });
  } catch (err) {
    console.error("❌ Fetch Groups Error:", err.message);
    res.status(500).json({ success: false, message: "Server Error", error: err.message });
  }
});

// =========================================================
// 🚀 2. CREATE NEW GROUP
// =========================================================
router.post("/create", auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const adminId = req.user.adminId || null;
    const role = req.user.role ? req.user.role.toLowerCase().trim() : 'admin';
    // Groups belong to the business owner (the same rule contacts.js and the webhooks use), so the admin
    // and every agent see them. Before, an agent's group got userId = the agent and no adminId and was invisible to the admin.
    const ownerId = (role === 'agent' && adminId) ? adminId : userId;
    const name = String(req.body.name || "").replace(/\s+/g, " ").trim();

    if (!name) {
      return res.status(400).json({ success: false, message: "Group name is required" });
    }
    if (name.toLowerCase() === "all") {
      return res.status(400).json({ success: false, message: '"All" is a reserved name (it means every contact).' });
    }
    if (name.length > 60) {
      return res.status(400).json({ success: false, message: "Group name can have at most 60 characters" });
    }

    // Already exists? (case-insensitive: "ad leads" and "Ad Leads" are the same group)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const existingGroup = await Group.findOne({ userId: ownerId, name: new RegExp("^" + escaped + "$", "i") });
    if (existingGroup) {
      return res.status(400).json({ success: false, message: "Group already exists in your account" });
    }

    const newGroup = new Group({ name, userId: ownerId, adminId: adminId || (role === 'agent' ? null : userId) });
    await newGroup.save();

    res.json({ success: true, group: newGroup });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to create group", error: err.message });
  }
});

// =========================================================
// 🗑️ 3. DELETE GROUP
// =========================================================
router.delete("/:name", auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const adminId = req.user.adminId || null;
    const role = req.user.role ? req.user.role.toLowerCase().trim() : 'admin';
    const ownerId = (role === 'agent' && adminId) ? adminId : userId;
    const groupName = req.params.name;
    
    // the owner's group (agents delete through the owner's scope as well, same as they create)
    const deletedGroup = await Group.findOneAndDelete({ name: groupName, userId: ownerId });
    if (!deletedGroup) {
      return res.status(404).json({ success: false, message: "Group not found or unauthorized" });
    }

    res.json({ success: true, message: "Group deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to delete group", error: err.message });
  }
});

module.exports = router;