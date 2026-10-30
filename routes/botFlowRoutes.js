const express = require("express");
const router = express.Router();
const BotFlow = require("../models/BotFlow");
const User = require("../models/User"); // User Model for fetching subscription plans dynamically
const auth = require("../middleware/auth");

// 1. SAVE OR UPDATE BOT FLOW (WITH DYNAMIC SUBSCRIPTION PLAN LIMITS)
router.post("/save", auth, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.body.userId || "user_101";
    const { id, name, nodes, edges } = req.body;

    if (!nodes || !Array.isArray(nodes) || !edges) {
      return res.status(400).json({ 
        success: false, 
        error: "Valid nodes and edges array are required." 
      });
    }

    // Node levels and data sanitization
    const sanitizedNodes = nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        level: node.data?.level ? String(node.data.level).trim().toUpperCase() : "ANY",
        nextLevel: node.data?.nextLevel ? String(node.data.nextLevel).trim().toUpperCase() : "ANY",
      },
    }));

    // Extract trigger keyword from triggerNode/startNode
    const triggerNode = sanitizedNodes.find(
      (n) => n.type === "triggerNode" || n.type === "startNode"
    );
    const extractedKeyword =
      triggerNode?.data?.keyword ||
      triggerNode?.data?.triggerKeyword ||
      triggerNode?.data?.label ||
      "N/A";

    let flow = null;

    // Step A: Search by exact ID
    if (id) {
      flow = await BotFlow.findOne({ _id: id, userId });
    }

    // Step B: Search by Flow Name (trimmed)
    if (!flow && name) {
      flow = await BotFlow.findOne({ userId, name: name.trim() });
    }

    if (flow) {
      // ✅ Existing Flow Update: Bypasses Quota Check
      flow.name = name ? name.trim() : flow.name;
      flow.nodes = sanitizedNodes;
      flow.edges = edges;
      flow.triggerKeyword = extractedKeyword;
      await flow.save();
    } else {
      // 🚀 Step C: Dynamic Plan Limit Check for New Flow Creation
      let userPlan = (req.user?.plan || req.user?.subscriptionPlan || "standard").toLowerCase();

      // Fallback: Fetch plan directly from database if missing in auth token
      if (!req.user?.plan && userId && userId !== "user_101") {
        const userDoc = await User.findById(userId).select("plan subscriptionPlan");
        if (userDoc) {
          userPlan = (userDoc.subscriptionPlan || userDoc.plan || "standard").toLowerCase();
        }
      }

      let maxLimit = 5; // Default: Standard / Free Plan

      if (userPlan === "premium") {
        maxLimit = 10;
      } else if (userPlan === "ultimate" || userPlan === "unlimited") {
        maxLimit = Infinity; // Unlimited Flows
      }

      const existingFlowsCount = await BotFlow.countDocuments({ userId });

      if (existingFlowsCount >= maxLimit) {
        return res.status(403).json({
          success: false,
          quotaExceeded: true,
          error: "Quota Reached. Upgrade Plan to increase limits.",
          currentCount: existingFlowsCount,
          maxLimit: maxLimit === Infinity ? "Unlimited" : maxLimit,
        });
      }

      flow = await BotFlow.create({
        userId,
        name: name ? name.trim() : "Main Flow",
        nodes: sanitizedNodes,
        edges,
        triggerKeyword: extractedKeyword,
        isActive: true,
      });
    }

    res.status(200).json({
      success: true,
      message: "Bot Flow saved successfully with Level Mapping! 🚀",
      flow,
    });
  } catch (error) {
    console.error("Save Flow Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. GET ALL SAVED FLOWS FOR A USER
router.get("/list", auth, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.query.userId || "user_101";

    const flows = await BotFlow.find({ userId })
      .select("name isActive triggerKeyword nodes updatedAt createdAt")
      .sort({ updatedAt: -1 });

    res.status(200).json({ success: true, flows });
  } catch (error) {
    console.error("Fetch Flows List Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. GET CURRENT / SPECIFIC FLOW
router.get("/current", auth, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.query.userId || "user_101";
    const { id } = req.query;

    let flow = null;

    if (id && id !== "null" && id !== "undefined") {
      flow = await BotFlow.findOne({ _id: id, userId });
    } else {
      flow = await BotFlow.findOne({ userId, isActive: true }).sort({ updatedAt: -1 });
      if (!flow) {
        flow = await BotFlow.findOne({ userId }).sort({ updatedAt: -1 });
      }
    }

    res.status(200).json({ success: true, flow: flow || null });
  } catch (error) {
    console.error("Fetch Current Flow Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. TOGGLE ACTIVE STATUS
router.put("/:id/toggle", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    const userId = req.user?.id || req.user?._id || req.body.userId || "user_101";

    const updatedFlow = await BotFlow.findOneAndUpdate(
      { _id: id, userId },
      { isActive: Boolean(isActive) },
      { new: true }
    );

    if (!updatedFlow) {
      return res.status(404).json({ success: false, message: "Flow not found" });
    }

    res.status(200).json({
      success: true,
      message: `Flow is now ${updatedFlow.isActive ? "Active" : "Disabled"}`,
      flow: updatedFlow,
    });
  } catch (error) {
    console.error("Toggle Flow Status Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. DELETE FLOW
router.delete("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id || req.user?._id || req.query.userId || "user_101";

    const deleted = await BotFlow.findOneAndDelete({ _id: id, userId });
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Flow not found" });
    }

    res.status(200).json({ success: true, message: "Flow deleted successfully!" });
  } catch (error) {
    console.error("Delete Flow Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;