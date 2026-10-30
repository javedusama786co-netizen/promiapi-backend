const express = require('express');
const router = express.Router();
const moment = require('moment');
const mongoose = require('mongoose');
const auth = require('../middleware/auth');

// Models
const ChatMessage = mongoose.models.ChatMessage || require("../models/ChatMessage");
const Contact = mongoose.models.Contact || require("../models/Contact");
const MessageLog = mongoose.models.MessageLog || require("../models/MessageLog");
const Order = mongoose.models.Order || (mongoose.models.Order ? mongoose.model("Order") : null);

// Helper: MongoDB _id se Date range calculate karne ke liye
const objectIdFromDate = (date) => {
  return new mongoose.Types.ObjectId(Math.floor(date.getTime() / 1000).toString(16) + "0000000000000000");
};

// GET /api/analytics/overview?range=7d|28d|90d
router.get('/overview', auth, async (req, res) => {
  try {
    // 1. User ID Extraction
    let rawUserId = req.user?.adminId || req.user?.id || req.user?._id || req.user;
    if (typeof rawUserId === 'object' && rawUserId._id) {
      rawUserId = rawUserId._id;
    }

    let userObjectId = null;
    const rawUserIdStr = rawUserId ? String(rawUserId) : null;

    if (rawUserIdStr && mongoose.Types.ObjectId.isValid(rawUserIdStr)) {
      userObjectId = new mongoose.Types.ObjectId(rawUserIdStr);
    }

    // 🟢 Filter for ChatMessage, MessageLog, Contact (where userId is ObjectId)
    const chatUserConditions = [];
    if (userObjectId) {
      chatUserConditions.push({ userId: userObjectId });
      chatUserConditions.push({ userId: rawUserIdStr });
    }
    const chatUserFilter = chatUserConditions.length > 0 ? { $or: chatUserConditions } : {};

    // 🟢 Filter for Order (where userId is String and can include "global_store_user")
    const orderUserConditions = [
      { userId: "global_store_user" }
    ];
    if (rawUserIdStr) {
      orderUserConditions.push({ userId: rawUserIdStr });
    }
    if (userObjectId) {
      orderUserConditions.push({ userId: userObjectId });
    }
    const orderUserFilter = { $or: orderUserConditions };

    // 2. Date Range
    const { range = '28d' } = req.query;
    let days = 28;
    if (range === '7d') days = 7;
    if (range === '90d') days = 90;

    const startDate = moment().subtract(days, 'days').startOf('day').toDate();
    const endDate = moment().endOf('day').toDate();

    const startObjectId = objectIdFromDate(startDate);
    const endObjectId = objectIdFromDate(endDate);

    const dateFilter = {
      $or: [
        { createdAt: { $gte: startDate, $lte: endDate } },
        { timestamp: { $gte: startDate, $lte: endDate } },
        { _id: { $gte: startObjectId, $lte: endObjectId } }
      ]
    };

    // 3. Total Messages Sent (All Outbound)
    const totalSent = await ChatMessage.countDocuments({
      ...chatUserFilter,
      $and: [
        dateFilter,
        {
          $or: [
            { sender: "me" },
            { direction: "outbound" }
          ]
        }
      ]
    });

    // 4. CAMPAIGN MESSAGES COUNT
    let campaignSentCount = await MessageLog.countDocuments({
      ...chatUserFilter,
      $and: [
        dateFilter,
        { status: "sent" }
      ]
    });

    if (campaignSentCount === 0) {
      campaignSentCount = await ChatMessage.countDocuments({
        ...chatUserFilter,
        $and: [
          dateFilter,
          { sender: "me" },
          {
            $or: [
              { isCampaign: true },
              { campaignId: { $exists: true, $ne: null } },
              { text: { $regex: /Broadcast|Template/i } }
            ]
          }
        ]
      });
    }

    // 5. Total Replies Received
    const totalReceived = await ChatMessage.countDocuments({
      ...chatUserFilter,
      $and: [
        dateFilter,
        {
          $or: [
            { sender: "them" },
            { direction: "inbound" }
          ]
        }
      ]
    });

    // 6. Total Audience Leads
    const totalLeads = await Contact.countDocuments({
      ...chatUserFilter,
      ...dateFilter
    });

    // 7. Order Confirmation Messages Count
    let confirmedMessagesCount = await ChatMessage.countDocuments({
      ...chatUserFilter,
      $and: [
        dateFilter,
        { sender: "me" },
        {
          $or: [
            { text: { $regex: /received successfully|has been received|order confirmed|dispatched|shipped/i } },
            { isOrderConfirmation: true }
          ]
        }
      ]
    });

    if (confirmedMessagesCount === 0) {
      confirmedMessagesCount = await ChatMessage.countDocuments({
        ...chatUserFilter,
        $and: [
          dateFilter,
          { sender: "me" },
          { text: { $regex: /received|confirmed|dispatched|shipped|order/i } }
        ]
      });
    }

    // 8. Cancelled Orders & Confirmed Sales Metrics (Using orderUserFilter)
    let cancelledOrdersCount = 0;
    let totalSalesCount = 0;

    if (Order) {
      const cancelRegex = /cancelled|refunded|failed|cancel|voided/i;

      cancelledOrdersCount = await Order.countDocuments({
        ...orderUserFilter,
        ...dateFilter,
        status: { $regex: cancelRegex }
      });

      totalSalesCount = await Order.countDocuments({
        ...orderUserFilter,
        ...dateFilter,
        $nor: [{ status: cancelRegex }]
      });
    }

    // Estimated Spend
    const estimatedSpend = (campaignSentCount * 0.008).toFixed(2);

    // 9. Aggregations for Daily Chart
    const messagesAgg = await ChatMessage.aggregate([
      { $match: { $and: [chatUserFilter, dateFilter] } },
      {
        $group: {
          _id: {
            date: { 
              $dateToString: { 
                format: "%Y-%m-%d", 
                date: { $ifNull: ["$createdAt", "$timestamp", "$_id"] } 
              } 
            },
            isReceived: { $eq: ["$sender", "them"] }
          },
          count: { $sum: 1 }
        }
      }
    ]);

    const confirmedMsgsAgg = await ChatMessage.aggregate([
      { 
        $match: { 
          $and: [
            chatUserFilter,
            dateFilter, 
            { sender: "me" },
            {
              $or: [
                { text: { $regex: /received successfully|has been received|order confirmed|dispatched|shipped/i } },
                { isOrderConfirmation: true }
              ]
            }
          ] 
        } 
      },
      {
        $group: {
          _id: {
            $dateToString: { 
              format: "%Y-%m-%d", 
              date: { $ifNull: ["$createdAt", "$timestamp", "$_id"] } 
            }
          },
          count: { $sum: 1 }
        }
      }
    ]);

    let dailySalesAgg = [];
    let dailyCancelledAgg = [];

    if (Order) {
      const cancelRegex = /cancelled|refunded|failed|cancel|voided/i;

      dailySalesAgg = await Order.aggregate([
        { 
          $match: { 
            $and: [
              orderUserFilter,
              dateFilter, 
              { $nor: [{ status: cancelRegex }] }
            ] 
          } 
        },
        {
          $group: {
            _id: {
              $dateToString: { 
                format: "%Y-%m-%d", 
                date: { $ifNull: ["$createdAt", "_id"] } 
              }
            },
            count: { $sum: 1 }
          }
        }
      ]);

      dailyCancelledAgg = await Order.aggregate([
        { 
          $match: { 
            $and: [
              orderUserFilter,
              dateFilter, 
              { status: { $regex: cancelRegex } }
            ] 
          } 
        },
        {
          $group: {
            _id: {
              $dateToString: { 
                format: "%Y-%m-%d", 
                date: { $ifNull: ["$createdAt", "_id"] } 
              }
            },
            count: { $sum: 1 }
          }
        }
      ]);
    }

    const campaignLogsAgg = await MessageLog.aggregate([
      { 
        $match: { 
          $and: [
            chatUserFilter, 
            dateFilter, 
            { status: "sent" }
          ] 
        } 
      },
      {
        $group: {
          _id: {
            $dateToString: { 
              format: "%Y-%m-%d", 
              date: { $ifNull: ["$createdAt", "_id"] } 
            }
          },
          count: { $sum: 1 }
        }
      }
    ]);

    const leadsAgg = await Contact.aggregate([
      { $match: { $and: [chatUserFilter, dateFilter] } },
      {
        $group: {
          _id: { 
            $dateToString: { 
              format: "%Y-%m-%d", 
              date: { $ifNull: ["$createdAt", "_id"] } 
            } 
          },
          count: { $sum: 1 }
        }
      }
    ]);

    // Daily Chart Mapping
    const dailyMap = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = moment().subtract(i, 'days').format('YYYY-MM-DD');
      const formattedDate = moment(d).format('D MMM');
      dailyMap[d] = {
        date: formattedDate,
        spend: 0,
        sent: 0,
        received: 0,
        leads: 0,
        confirmedMessages: 0,
        totalSales: 0,
        cancelledOrders: 0
      };
    }

    messagesAgg.forEach(item => {
      const dateKey = item._id.date;
      if (dailyMap[dateKey]) {
        if (item._id.isReceived) {
          dailyMap[dateKey].received += item.count;
        } else {
          dailyMap[dateKey].sent += item.count;
        }
      }
    });

    confirmedMsgsAgg.forEach(item => {
      const dateKey = item._id;
      if (dailyMap[dateKey]) {
        dailyMap[dateKey].confirmedMessages = item.count;
      }
    });

    dailySalesAgg.forEach(item => {
      const dateKey = item._id;
      if (dailyMap[dateKey]) {
        dailyMap[dateKey].totalSales = item.count;
      }
    });

    dailyCancelledAgg.forEach(item => {
      const dateKey = item._id;
      if (dailyMap[dateKey]) {
        dailyMap[dateKey].cancelledOrders = item.count;
      }
    });

    campaignLogsAgg.forEach(item => {
      const dateKey = item._id;
      if (dailyMap[dateKey]) {
        dailyMap[dateKey].spend = Number((item.count * 0.008).toFixed(2));
      }
    });

    leadsAgg.forEach(item => {
      const dateKey = item._id;
      if (dailyMap[dateKey]) {
        dailyMap[dateKey].leads = item.count;
      }
    });

    const chartData = Object.values(dailyMap);

    return res.status(200).json({
      success: true,
      data: {
        totals: {
          spend: estimatedSpend,
          sent: totalSent.toLocaleString(),
          received: totalReceived.toLocaleString(),
          leads: totalLeads.toLocaleString(),
          confirmedMessages: confirmedMessagesCount.toLocaleString(),
          totalSales: totalSalesCount.toLocaleString(),
          cancelledOrders: cancelledOrdersCount.toLocaleString()
        },
        chart: chartData
      }
    });

  } catch (error) {
    console.error("Analytics Backend Error:", error);
    return res.status(500).json({ success: false, message: "Server error fetching analytics" });
  }
});

module.exports = router;