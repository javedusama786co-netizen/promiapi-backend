const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const axios = require("axios");
const MessageLog = require("../models/MessageLog");
const auth = require("../middleware/auth");

// 🌟 GET /api/message-logs - Fetch & dynamically resolve sender contact names across platforms
router.get("/", auth, async (req, res) => {
  try {
    const userId = req.user.adminId || req.user.id || req.user._id;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized: User identification failed." });
    }

    const logs = await MessageLog.find({ userId }).sort({ createdAt: -1 }).lean();

    if (!logs || logs.length === 0) {
      return res.status(200).json({ success: true, logs: [] });
    }

    const Contact = mongoose.models.Contact || require("../models/Contact");

    const resolvedLogs = await Promise.all(
      logs.map(async (logItem) => {
        const log = { ...logItem };

        // Ensure default platform if missing
        if (!log.platform) log.platform = "whatsapp";

        // Return if name is already correctly set
        if (log.receiverName && log.receiverName.trim() !== "" && log.receiverName !== "Unknown Contact") {
          return log;
        }

        try {
          const channel = (log.platform || "whatsapp").toLowerCase();

          // 1. WhatsApp Contact Name Matching (Using Phone Number Logic)
          if (channel === "whatsapp") {
            const cleanIdentifier = log.receiverNumber ? log.receiverNumber.replace(/\D/g, "") : "";

            let matchedContact = null;
            if (cleanIdentifier) {
              matchedContact = await Contact.findOne({
                $or: [{ userId: userId }, { adminId: userId }],$or: [
                  { phone: log.receiverNumber },
                  { phone: cleanIdentifier },
                  { phone: { $regex: cleanIdentifier.slice(-10) + "$" } }
                ]
              }).select("name").lean();
            }

            if (matchedContact && matchedContact.name) {
              log.receiverName = matchedContact.name;
            } else {
              const WhatsAppChat = mongoose.models.WhatsAppChat || (mongoose.models.WhatsAppChat ? mongoose.model("WhatsAppChat") : null);
              if (WhatsAppChat) {
                const linkedChat = await WhatsAppChat.findOne({
                  userId,
                  $or: [
                    { customerNumber: log.receiverNumber },
                    { customerNumber: cleanIdentifier },
                    { customerNumber: { $regex: cleanIdentifier.slice(-10) + "$" } }
                  ]
                }).select("customerName name").lean();

                if (linkedChat) {
                  log.receiverName = linkedChat.customerName || linkedChat.name || "WhatsApp Customer";
                }
              }
            }
          } 
          // 2. Instagram & Messenger Name Matching (Using Exact Scoped ID Matching)
          else if (channel === "instagram" || channel === "messenger") {
            const rawId = log.receiverNumber ? log.receiverNumber.trim() : "";

            // Check in Contacts model by socialId / psid / igsid or exact phone/id match
            let socialContact = await Contact.findOne({
              $or: [{ userId: userId }, { adminId: userId }],$or: [
                { instagramId: rawId },
                { messengerId: rawId },
                { psid: rawId },
                { phone: rawId }
              ]
            }).select("name").lean();

            if (socialContact && socialContact.name) {
              log.receiverName = socialContact.name;
            } else {
              // Check in Social/Direct Chat collections
              const SocialChat = mongoose.models.SocialChat || mongoose.models.DirectChat || mongoose.models.InstagramChat || mongoose.models.MessengerChat;
              if (SocialChat) {
                const socialMatch = await SocialChat.findOne({
                  userId,
                  $or: [
                    { recipientId: rawId },
                    { senderId: rawId },
                    { customerId: rawId },
                    { psid: rawId }
                  ]
                }).select("senderName username recipientName name customerName").lean();

                if (socialMatch) {
                  log.receiverName = socialMatch.senderName || socialMatch.username || socialMatch.recipientName || socialMatch.name || socialMatch.customerName;
                }
              }
            }
          }

          // Fallback if no match found
          if (!log.receiverName) {
            log.receiverName = log.receiverNumber || "Unknown Contact";
          }
        } catch (dbErr) {
          log.receiverName = log.receiverNumber || "Unknown Contact";
        }

        return log;
      })
    );

    return res.status(200).json({
      success: true,
      logs: resolvedLogs
    });
  } catch (error) {
    console.error("Error fetching logs:", error);
    return res.status(500).json({ success: false, message: "Server error fetching operational logs." });
  }
});

// 🌟 POST /api/message-logs/retry/:id - Smart Cross-Platform Resend Gateway Engine
router.post("/retry/:id", auth, async (req, res) => {
  try {
    const userId = req.user.adminId || req.user.id || req.user._id;
    const logId = req.params.id;

    const targetLog = await MessageLog.findOne({ _id: logId, userId });
    if (!targetLog) {
      return res.status(404).json({ success: false, message: "Log record not found." });
    }

    const channel = (targetLog.platform || "whatsapp").toLowerCase();

    // CHANNEL 1: WHATSAPP RETRY
    if (channel === "whatsapp") {
      const WhatsAppConfig = mongoose.models.WhatsAppConfig || mongoose.model("WhatsAppConfig");
      const configRecord = await WhatsAppConfig.findOne({ userId });
      
      if (!configRecord) {
        return res.status(400).json({ success: false, message: "WhatsApp configuration credentials missing." });
      }

      const cleanPhone = targetLog.receiverNumber.replace(/\D/g, "");
      let payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: cleanPhone,
      };

      if (targetLog.messageBody.startsWith("📢 Template:")) {
        const templateName = targetLog.messageBody.replace("📢 Template: ", "").trim();
        payload.type = "template";
        payload.template = {
          name: templateName,
          language: { code: "en_US" },
          components: [{
            type: "body",
            parameters: [{ type: "text", text: targetLog.receiverName || "Customer" }]
          }]
        };
      } else {
        payload.type = "text";
        payload.text = { preview_url: false, body: targetLog.messageBody };
      }

      const metaUrl = `https://graph.facebook.com/v20.0/${configRecord.phoneNumberId}/messages`;
      
      const response = await axios.post(metaUrl, payload, {
        headers: {
          Authorization: `Bearer ${configRecord.accessToken}`,
          "Content-Type": "application/json",
        },
      });

      targetLog.status = "sent";
      if (response.data?.messages?.[0]) {
        targetLog.metaMessageId = response.data.messages[0].id;
      }
      await targetLog.save();

      return res.json({ success: true, message: "WhatsApp message retried successfully!", log: targetLog });
    } 
    
    // CHANNEL 2 & 3: INSTAGRAM & MESSENGER RETRY
    else if (channel === "instagram" || channel === "messenger") {
      const SocialConfig = mongoose.models.SocialConfig || mongoose.models.MetaConfig;
      let accessToken = null;

      if (SocialConfig) {
        const socialAuth = await SocialConfig.findOne({ userId });
        if (socialAuth) accessToken = socialAuth.pageAccessToken || socialAuth.accessToken;
      }

      if (!accessToken) {
        return res.status(400).json({ success: false, message: `Active ${channel} credentials missing in configuration.` });
      }

      const payload = {
        recipient: { id: targetLog.receiverNumber },
        message: { text: targetLog.messageBody }
      };

      const metaGraphUrl = `https://graph.facebook.com/v20.0/me/messages?access_token=${accessToken}`;
      const response = await axios.post(metaGraphUrl, payload);

      targetLog.status = "sent";
      if (response.data?.message_id) {
        targetLog.metaMessageId = response.data.message_id;
      }
      await targetLog.save();

      return res.json({ success: true, message: `${channel.toUpperCase()} message retried successfully!`, log: targetLog });
    }

    return res.status(400).json({ success: false, message: "Unsupported communication channel provided." });

  } catch (err) {
    console.error("❌ RETRY Caught Error:", err.response ? JSON.stringify(err.response.data) : err.message);
    
    try {
      await MessageLog.updateOne({ _id: req.params.id }, { $set: { status: "failed" } });
    } catch (dbErr) {
      console.error("Failed status update error:", dbErr);
    }

    return res.status(500).json({ 
      success: false, 
      message: "Gateway server/Meta rejected the retry action.", 
      error: err.response ? err.response.data : err.message 
    });
  }
});

// 🌟 DELETE /api/message-logs/:id
router.delete("/:id", auth, async (req, res) => {
  try {
    const userId = req.user.adminId || req.user.id || req.user._id;
    const logId = req.params.id;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const deletedLog = await MessageLog.findOneAndDelete({ _id: logId, userId });

    if (!deletedLog) {
      return res.status(404).json({ success: false, message: "Log record not found." });
    }

    return res.status(200).json({ success: true, message: "Log entry deleted successfully." });
  } catch (error) {
    console.error("Error deleting log:", error);
    return res.status(500).json({ success: false, message: "Server error during deletion." });
  }
});

// 🌟 POST /api/message-logs/bulk-delete
router.post("/bulk-delete", auth, async (req, res) => {
  try {
    const userId = req.user.adminId || req.user.id || req.user._id;
    const { logIds } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    if (!logIds || !Array.isArray(logIds) || logIds.length === 0) {
      return res.status(400).json({ success: false, message: "No valid log IDs specified." });
    }

    const deleteResult = await MessageLog.deleteMany({
      _id: { $in: logIds },
      userId: userId
    });

    return res.status(200).json({
      success: true,
      message: `Cleared ${deleteResult.deletedCount} log(s) successfully.`
    });
  } catch (error) {
    console.error("Error in bulk deleting logs:", error);
    return res.status(500).json({ success: false, message: "Failed to execute bulk delete." });
  }
});

module.exports = router;