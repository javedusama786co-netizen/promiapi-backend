const AiBotSettings = require("../models/AiBotSettings");

// Helper function: Safe User ID Extractor
const getUserId = (req) => req.user?.id || req.user?._id || req.user?.adminId;

// @desc    Get AI Settings
// @route   GET /api/ai-bot/settings
exports.getSettings = async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ success: false, message: "User authentication failed." });
    }

    let settings = await AiBotSettings.findOne({ userId });

    if (!settings) {
      // Empty document return karo agar pehle se saved nahi hai
      settings = await AiBotSettings.create({ userId });
    }

    return res.status(200).json({ success: true, data: settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Save/Update AI Settings
// @route   POST /api/ai-bot/settings
exports.saveSettings = async (req, res) => {
  try {
    const userId = getUserId(req);
    
    if (!userId) {
      return res.status(401).json({ success: false, message: "User authentication failed." });
    }

    const updateData = req.body;

    // Standard Mongoose syntax: { new: true }
    const settings = await AiBotSettings.findOneAndUpdate(
      { userId },
      { $set: updateData },
      { new: true, upsert: true, runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: "Settings saved successfully",
      data: settings,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};