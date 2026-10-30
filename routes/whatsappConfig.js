const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth"); 
const WhatsAppConfig = require("../models/whatsappConfigModel");
const axios = require("axios"); 
const crypto = require("crypto");
const mongoose = require("mongoose");
const fs = require("fs");

// ⚡ Centralized Baileys Service Import from Root (Memory sync ke liye)
const { startWhatsAppSession, getQrCode, getActiveSocket, removeSession } = require("../routes/whatsappBaileysService");

function generateVerifyToken() {
  return "v_token_" + crypto.randomBytes(16).toString("hex");
}

const getUserQueryFilter = (userId, platform) => {
  const isObjectId = mongoose.Types.ObjectId.isValid(userId);
  const userConditions = [
    { userId: userId },
    { userId: String(userId) }
  ];
  if (isObjectId) {
    userConditions.push({ userId: new mongoose.Types.ObjectId(userId) });
  }
  return {
    $or: userConditions,
    platform: platform
  };
};

// ==========================================
// WHATSAPP QR SCAN (WEB ENGINE) ROUTES
// ==========================================

// 1. QR Session Status Check
router.get("/whatsapp-qr/status", auth, async (req, res) => {
    try {
        const userId = req.user?.adminId || req.user?.id || req.user?._id;
        const filter = getUserQueryFilter(userId, "whatsapp_qr");
        const config = await WhatsAppConfig.findOne(filter).lean();
        const currentQr = getQrCode(userId);

        if (!config && !currentQr) {
            return res.json({
                success: true,
                status: "DISCONNECTED",
                qrCode: null,
                phoneNumber: null
            });
        }

        return res.json({
            success: true,
            status: config?.status || (currentQr ? "SCAN_REQUIRED" : "DISCONNECTED"),
            qrCode: currentQr || config?.qrCode || null,
            phoneNumber: config?.phoneNumber || null
        });
    } catch (error) {
        console.error("QR Status Error:", error);
        return res.status(500).json({ success: false, message: "QR status प्राप्त करने में विफल।" });
    }
});

// 2. Start QR Session & Archive Previous Chats (No Deletion)
router.post("/whatsapp-qr/start", auth, async (req, res) => {
    try {
        const userId = req.user?.adminId || req.user?.id || req.user?._id;
        
        const isObjectId = mongoose.Types.ObjectId.isValid(userId);
        const userCond = [{ userId: userId }, { userId: String(userId) }];
        if (isObjectId) userCond.push({ userId: new mongoose.Types.ObjectId(userId) });

        await WhatsAppConfig.deleteMany({
            $or: userCond,
            platform: { $in: ["whatsapp", "whatsapp_official"] }
        });

        const ChatMessage = mongoose.models.ChatMessage || require("../models/ChatMessage");
        const Contact = mongoose.models.Contact || require("../models/Contact");
        
        await ChatMessage.updateMany({ $or: userCond }, {$set: { archived: true } });
        await Contact.updateMany({ $or: userCond }, {$set: { archived: true } });
        console.log(`📦 [DATA ARCHIVED] Previous chats and contacts hidden for user: ${userId}`);

        startWhatsAppSession(userId);

        setTimeout(async () => {
            const qr = getQrCode(userId) || null;
            return res.json({
                success: true,
                message: "पुराना डेटा सुरक्षित है और नया QR code जनरेट हो रहा है।",
                qrCode: qr
            });
        }, 1500);

    } catch (error) {
        console.error("Start QR Session Error:", error);
        return res.status(500).json({ success: false, message: "QR session शुरू करने में विफल।" });
    }
});

// 3. Disconnect QR Session (NO DATA WIPE - Chats & Contacts Preserved Safely)
router.post("/whatsapp-qr/disconnect", auth, async (req, res) => {
    try {
        const userId = req.user?.adminId || req.user?.id || req.user?._id;
        const isObjectId = mongoose.Types.ObjectId.isValid(userId);
        const userCond = [{ userId: userId }, { userId: String(userId) }];
        if (isObjectId) userCond.push({ userId: new mongoose.Types.ObjectId(userId) });

        // 1. Active socket ko logout aur terminate karein
        const activeSock = getActiveSocket(userId);
        if (activeSock) {
            try {
                await activeSock.logout();
            } catch (e) {
                /* ignore */
            }
        }
        removeSession(userId);

        // 2. WhatsApp Config record delete karein (Sirf config hatao, messages nahi)
        await WhatsAppConfig.deleteMany({
            $or: userCond,
            platform: "whatsapp_qr"
        });

        // 3. Local Baileys Auth Session Folder ko delete karein
        const authFolderName = `./auth_info_baileys_${userId}`;
        if (fs.existsSync(authFolderName)) {
            try {
                fs.rmSync(authFolderName, { recursive: true, force: true });
            } catch (fsErr) {
                console.log("⚠️ Failed to delete auth folder:", fsErr.message);
            }
        }

        console.log(`🧹 [QR DISCONNECT] Session closed safely without deleting any chat messages for user: ${userId}.`);

        return res.json({
            success: true,
            message: "WhatsApp QR session disconnect ho gaya hai aur aapka saara data database mein bilkul محفوظ (safe) hai."
        });
    } catch (error) {
        console.error("Disconnect QR Error:", error);
        return res.status(500).json({ success: false, message: "QR session disconnect karne mein nakaam." });
    }
});


// ==========================================
// META OFFICIAL & STANDARD CONFIG ROUTES
// ==========================================

// 4. GET Config
router.get("/:platform/config", auth, async (req, res) => {
    try {
        const platform = req.params.platform?.toLowerCase() || "whatsapp_official";
        const userId = req.user?.adminId || req.user?.id || req.user?._id; 
        
        const filter = getUserQueryFilter(userId, platform);
        let config = await WhatsAppConfig.findOne(filter).lean();
        
        if (!config) {
            return res.json({ success: true, config: null }); 
        }

        if (!config.webhookVerifyToken) {
            const token = generateVerifyToken();
            await WhatsAppConfig.updateOne({ _id: config._id }, { $set: { webhookVerifyToken: token } });
            config.webhookVerifyToken = token;
        }

        return res.json({ success: true, config }); 
    } catch (error) {
        console.error("GET Config Error:", error);
        return res.status(500).json({ success: false, message: "Configuration प्राप्त करने में विफल।" }); 
    }
});

// 5. 1-CLICK OAUTH ROUTE (FIXED TOKEN & CALLING ENABLE)
router.post("/:platform/oauth-connect", auth, async (req, res) => {
    try {
        const platform = req.params.platform?.toLowerCase() || "whatsapp_official";
        const userId = req.user?.adminId || req.user?.id || req.user?._id;
        let { accessToken } = req.body;

        if (!accessToken) {
            return res.status(400).json({ success: false, message: "Meta access token जरूरी है।" });
        }

        // 🟢 Robust Token Clean & Formatting Fix
        accessToken = String(accessToken).replace(/^["']|["']$/g, "").trim().replace(/[\r\n]+/g, "");
        let updateData = { accessToken, platform, userId, callEnabled: true };

        if (platform === "whatsapp_official" || platform === "whatsapp") {
            const isObjectId = mongoose.Types.ObjectId.isValid(userId);
            const userCond = [{ userId: userId }, { userId: String(userId) }];
            if (isObjectId) userCond.push({ userId: new mongoose.Types.ObjectId(userId) });

            // 🛑 TERMINATE QR SESSION WITHOUT WIPING DATA
            const activeSock = getActiveSocket(userId);
            if (activeSock) {
                try {
                    await activeSock.logout();
                } catch (e) {
                    /* ignore */
                }
            }
            removeSession(userId);

            const authFolderName = `./auth_info_baileys_${userId}`;
            if (fs.existsSync(authFolderName)) {
                try {
                    fs.rmSync(authFolderName, { recursive: true, force: true });
                } catch (err) {
                    console.log("⚠️ Failed to delete auth folder during Meta connect:", err.message);
                }
            }

            await WhatsAppConfig.deleteMany({
                $or: userCond,
                platform: "whatsapp_qr"
            });
            console.log(`🧹 [META OAUTH CONNECTED] QR session terminated safely (Data preserved) for user: ${userId}`);

            let wabaId = null;
            try {
                const wabaRes = await axios.get(`https://graph.facebook.com/v20.0/me?fields=whatsapp_business_accounts,businesses`, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                });

                if (wabaRes.data?.whatsapp_business_accounts?.data?.[0]?.id) {
                    wabaId = wabaRes.data.whatsapp_business_accounts.data[0].id;
                } else if (wabaRes.data?.businesses?.data?.[0]?.id) {
                    const busId = wabaRes.data.businesses.data[0].id;
                    const busWabaRes = await axios.get(`https://graph.facebook.com/v20.0/${busId}/client_whatsapp_business_accounts`, {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    });
                    wabaId = busWabaRes.data?.data?.[0]?.id;
                }
            } catch (err) {
                console.log("⚠️ Primary WABA lookup bypassed...");
            }

            if (!wabaId) {
                return res.status(400).json({
                    success: false,
                    message: "आपके Meta account पर कोई active WhatsApp Business Account नहीं मिला।"
                });
            }

            const phoneRes = await axios.get(`https://graph.facebook.com/v20.0/${wabaId}/phone_numbers`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            const phoneNumberId = phoneRes.data?.data?.[0]?.id;

            if (!phoneNumberId) {
                return res.status(400).json({ success: false, message: "Active WhatsApp Phone Number ID नहीं मिली।" });
            }

            updateData.businessAccountId = wabaId;
            updateData.phoneNumberId = phoneNumberId;
        } 
        else if (platform === "instagram" || platform === "messenger") {
            let finalToken = accessToken;
            const appId = process.env.FACEBOOK_APP_ID || "1543305467331355";
            const appSecret = process.env.FACEBOOK_APP_SECRET;

            if (appSecret) {
                try {
                    const exchangeRes = await axios.get(`https://graph.facebook.com/v20.0/oauth/access_token`, {
                        params: {
                            grant_type: 'fb_exchange_token',
                            client_id: appId,
                            client_secret: appSecret,
                            fb_exchange_token: accessToken
                        }
                    });
                    if (exchangeRes.data?.access_token) {
                        finalToken = exchangeRes.data.access_token;
                    }
                } catch (exErr) {
                    console.log("⚠️ Long-lived exchange bypassed:", exErr.response?.data || exErr.message);
                }
            }

            const accountsRes = await axios.get(`https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token,instagram_business_account`, {
                headers: { Authorization: `Bearer ${finalToken}` }
            });

            const page = accountsRes.data?.data?.[0];
            if (!page) {
                return res.status(400).json({ success: false, message: "कोई Linked Facebook Page नहीं मिला।" });
            }

            const pageAccessToken = (page.access_token || finalToken).trim().replace(/[\r\n]+/g, "");

            if (platform === "messenger") {
                updateData.pageId = page.id;
                updateData.accessToken = pageAccessToken;
            } else if (platform === "instagram") {
                const igId = page.instagram_business_account?.id;
                if (!igId) {
                    return res.status(400).json({ success: false, message: "इस Facebook Page से linked Instagram Business Account नहीं मिला।" });
                }
                updateData.instagramAccountId = igId;
                updateData.pageId = page.id;
                updateData.accessToken = pageAccessToken;
            }
        }

        const filter = getUserQueryFilter(userId, platform);
        let existingConfig = await WhatsAppConfig.findOne(filter).lean();
        updateData.webhookVerifyToken = existingConfig?.webhookVerifyToken || generateVerifyToken();

        const updatedConfig = await WhatsAppConfig.findOneAndUpdate(
            filter,
            { $set: updateData },
            { new: true, upsert: true, runValidators: true }
        );

        return res.json({
            success: true,
            message: `🎉 ${platform.toUpperCase()} account successfully link हो गया है!`,
            config: updatedConfig
        });

    } catch (error) {
        console.error("❌ OAuth Auto-Connect Error:", error.response?.data || error.message);
        return res.status(500).json({
            success: false,
            message: error.response?.data?.error?.message || error.message || "Meta से details fetch करने में विफल।"
        });
    }
});

// 6. POST Config: Manual Save
router.post("/:platform/config", auth, async (req, res) => {
    try {
        const platform = req.params.platform?.toLowerCase() || "whatsapp_official";
        const userId = req.user?.adminId || req.user?.id || req.user?._id; 
        const { accessToken, phoneNumberId, businessAccountId, pageId, instagramAccountId } = req.body; 

        if (!userId) {
            return res.status(401).json({ success: false, message: "User authentication missing." });
        }

        if (!accessToken) {
            return res.status(400).json({ success: false, message: "Access Token जरूरी है।" }); 
        }

        const cleanToken = String(accessToken).replace(/^["']|["']$/g, "").trim().replace(/[\r\n]+/g, "");

        if (platform === "whatsapp_official" || platform === "whatsapp") {
            const isObjectId = mongoose.Types.ObjectId.isValid(userId);
            const userCond = [{ userId: userId }, { userId: String(userId) }];
            if (isObjectId) userCond.push({ userId: new mongoose.Types.ObjectId(userId) });

            const activeSock = getActiveSocket(userId);
            if (activeSock) {
                try {
                    await activeSock.logout();
                } catch (e) {
                    /* ignore */
                }
            }
            removeSession(userId);

            const authFolderName = `./auth_info_baileys_${userId}`;
            if (fs.existsSync(authFolderName)) {
                try {
                    fs.rmSync(authFolderName, { recursive: true, force: true });
                } catch (err) {
                    console.log("⚠️ Failed to delete auth folder during Meta manual save:", err.message);
                }
            }

            await WhatsAppConfig.deleteMany({
                $or: userCond,
                platform: "whatsapp_qr"
            });
            console.log(`🧹 [META MANUAL SAVED] QR session terminated safely for user: ${userId}`);
        }

        let updateData = { accessToken: cleanToken, platform, userId, callEnabled: true };

        if (platform === "whatsapp_official" || platform === "whatsapp") {
            updateData.phoneNumberId = phoneNumberId?.trim();
            updateData.businessAccountId = businessAccountId?.trim();
        } else if (platform === "instagram") {
            updateData.instagramAccountId = instagramAccountId?.trim();
        } else if (platform === "messenger") {
            updateData.pageId = pageId?.trim();
        }

        const filter = getUserQueryFilter(userId, platform);
        let existingConfig = await WhatsAppConfig.findOne(filter).lean();
        updateData.webhookVerifyToken = existingConfig?.webhookVerifyToken || generateVerifyToken();

        const updatedConfig = await WhatsAppConfig.findOneAndUpdate(
            filter,
            { $set: updateData },
            { new: true, upsert: true, runValidators: true } 
        );
        
        return res.json({ 
            success: true, 
            message: "Configurations safely save हो गई हैं!", 
            config: updatedConfig 
        });
    } catch (error) {
        console.error("❌ POST Config Error:", error);
        return res.status(500).json({ 
            success: false, 
            message: error.message || "Internal Server Error." 
        }); 
    }
});

// 7. POST Outbound Message Sender
router.post("/:platform/send", auth, async (req, res) => {
    console.log("📦 OUTBOUND PAYLOAD RECEIVED:", JSON.stringify(req.body, null, 2));

    const platform = req.params.platform?.toLowerCase() || "whatsapp_official";
    try {
        const userId = req.user?.adminId || req.user?.id || req.user?._id; 
        
        const recipientId = 
            req.body.recipientId || 
            req.body.receptionId || 
            req.body.reception_id || 
            req.body.recipient_id || 
            req.body.to || 
            req.body.phone;

        const messageText = 
            req.body.messageText || 
            req.body.message_text || 
            req.body.message || 
            req.body.text || 
            req.body.body || 
            req.body.caption ||
            (req.body.templateName ? `Template: ${req.body.templateName}` : "");

        if (!recipientId && !req.body.targetGroup && !req.body.group) {
            return res.status(400).json({ 
                success: false, 
                message: "Missing required fields: Target Recipient ID/Phone or Group Name." 
            }); 
        }

        // ⚡ DUAL LOGIC 1: WhatsApp QR
        if (platform === "whatsapp_qr") {
            let sock = getActiveSocket(userId);

            if (!sock) {
                const isObjectId = mongoose.Types.ObjectId.isValid(userId);
                const userCond = [{ userId: userId }, { userId: String(userId) }];
                if (isObjectId) userCond.push({ userId: new mongoose.Types.ObjectId(userId) });

                const qrConfigRecord = await WhatsAppConfig.findOne({ $or: userCond, platform: "whatsapp_qr", status: "CONNECTED" }).lean();
                
                if (qrConfigRecord) {
                    console.log(`⚠️ [WHATSAPP CONFIG QR RECOVERY] Socket missing in memory for user ${userId}. Restoring session...`);
                    try {
                        startWhatsAppSession(userId);
                        for (let attempt = 0; attempt < 10; attempt++) {
                            await new Promise((resolve) => setTimeout(resolve, 1000));
                            sock = getActiveSocket(userId);
                            if (sock) break;
                        }
                    } catch (err) {
                        console.error("❌ Failed to auto-restore session in config:", err.message);
                    }
                }
            }

            if (!sock) {
                return res.status(400).json({ 
                    success: false, 
                    message: "WhatsApp QR session active nahi hai. Baraye meherbani page refresh karein ya dobara QR scan karein." 
                });
            }

            let recipientJid = "";
            const rawRecipient = String(recipientId || "").trim();

            if (rawRecipient.includes("@lid") || rawRecipient.includes("@g.us") || rawRecipient.includes("@s.whatsapp.net")) {
                recipientJid = rawRecipient;
            } else if (rawRecipient.length > 13 && /^\d+$/.test(rawRecipient)) {
                recipientJid = `${rawRecipient}@lid`;
            } else {
                let cleanPhone = rawRecipient.replace(/\D/g, "");
                if (cleanPhone.startsWith("03") && cleanPhone.length === 11) {
                    cleanPhone = "92" + cleanPhone.substring(1);
                }
                
                recipientJid = `${cleanPhone}@s.whatsapp.net`;
                try {
                    const [result] = await sock.onWhatsApp(cleanPhone);
                    if (result && result.exists) {
                        recipientJid = result.jid;
                    }
                } catch (err) {
                    console.log("⚠️ onWhatsApp lookup warning in whatsappConfig:", err.message);
                }
            }

            console.log(`📡 [QR TRANSMISSION] Target JID Resolved: ${recipientJid} | Message: ${messageText}`);
            await sock.sendMessage(recipientJid, { text: messageText });

            return res.json({
                success: true,
                message: "📩 Message successfully sent via WhatsApp QR Web Engine!",
                engine: "QR_BAILEYS"
            });
        }

        // ⚡ DUAL LOGIC 2: Official Meta Cloud API
        const filter = getUserQueryFilter(userId, platform);
        const config = await WhatsAppConfig.findOne(filter).lean(); 

        if (!config || !config.accessToken) {
            return res.status(404).json({ 
                success: false, 
                message: `${platform.toUpperCase()} API details nahi mili. Pehle setup complete karein.` 
            });
        }

        let url = "";
        let payload = {};
        const cleanToken = String(config.accessToken).trim().replace(/^["']|["']$/g, "").replace(/[\r\n]+/g, "");

        if (platform === "whatsapp_official" || platform === "whatsapp") {
            if (!config.phoneNumberId) {
                return res.status(400).json({ success: false, message: "WhatsApp Phone Number ID configuration missing hai." });
            }
            
            let cleanPhone = String(recipientId || "").replace(/\D/g, "");
            if (cleanPhone.startsWith("03") && cleanPhone.length === 11) {
                cleanPhone = "92" + cleanPhone.substring(1);
            }

            url = `https://graph.facebook.com/v20.0/${config.phoneNumberId}/messages`;
            payload = {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: cleanPhone,
                type: "text",
                text: { preview_url: false, body: messageText }
            };
        } else if (platform === "messenger" || platform === "facebook") {
            const pageId = config.pageId || "me";
            url = `https://graph.facebook.com/v20.0/${pageId}/messages`;
            payload = {
                recipient: { id: recipientId },
                message: { text: messageText }
            };
        } else if (platform === "instagram") {
            const igId = config.instagramAccountId || config.pageId || "me";
            url = `https://graph.facebook.com/v20.0/${igId}/messages`;
            payload = {
                recipient: { id: recipientId },
                message: { text: messageText }
            };
        }

        const response = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${cleanToken}`, 
                "Content-Type": "application/json" 
            }
        });
        
        return res.json({
            success: true,
            message: `📩 Message successfully sent via ${platform.toUpperCase()}!`, 
            metaResponse: response.data 
        });

    } catch (error) {
        console.error("❌ Send Message Error:", error.response?.data || error.message); 
        return res.status(500).json({
            success: false,
            message: `Failed to send message via ${platform.toUpperCase()}.`, 
            error: error.response?.data || error.message 
        });
    }
});

module.exports = router;