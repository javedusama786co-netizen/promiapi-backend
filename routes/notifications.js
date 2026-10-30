const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const authMiddleware = require('../middleware/auth');

// Get all notifications with pagination and unread count
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [notifications, unreadCount, totalCount] = await Promise.all([
      Notification.find({ userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments({ userId, isRead: false }),
      Notification.countDocuments({ userId })
    ]);

    res.json({
      success: true,
      notifications,
      unreadCount,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ success: false, message: "Server error while fetching notifications" });
  }
});

// Mark a single notification as read
router.put('/:id/read', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid notification ID format" });
    }

    const updatedNotification = await Notification.findOneAndUpdate(
      { _id: id, userId },
      { isRead: true },
      { new: true }
    );

    if (!updatedNotification) {
      return res.status(404).json({ success: false, message: "Notification not found or unauthorized" });
    }

    res.json({ success: true, message: "Notification marked as read", notification: updatedNotification });
  } catch (error) {
    console.error("Error updating notification status:", error);
    res.status(500).json({ success: false, message: "Server error while updating notification" });
  }
});

// Mark all notifications as read (Bulk update for real production performance)
router.put('/read-all', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;

    await Notification.updateMany(
      { userId, isRead: false },
      { $set: { isRead: true } }
    );

    res.json({ success: true, message: "All notifications marked as read" });
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    res.status(500).json({ success: false, message: "Server error while updating notifications" });
  }
});

// Delete notification route
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid notification ID format" });
    }

    const deleted = await Notification.findOneAndDelete({ _id: id, userId });

    if (!deleted) {
      return res.status(404).json({ success: false, message: "Notification not found or unauthorized" });
    }

    res.json({ success: true, message: "Notification deleted successfully" });
  } catch (error) {
    console.error("Error deleting notification:", error);
    res.status(500).json({ success: false, message: "Server error while deleting notification" });
  }
});

module.exports = router;