const User = require("../models/User");

// GET DASHBOARD STATS
exports.getStats = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select("-password");

    const stats = {
      contacts: 0,
      groups: 0,
      campaigns: 0,
      templates: 0,
      botReplies: 0,
      teamMembers: 0,
      queue: 0,
      processed: 0,
    };

    res.json({
      message: "Dashboard stats fetched successfully",
      user,
      stats,
    });

  } catch (error) {
    res.status(500).json({
      message: error.message,
    });
  }
};