const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const axios = require("axios"); 
const multer = require("multer"); 
const path = require("path");
const FormData = require("form-data");
const crypto = require("crypto");

// 🌐 BASE URL CONFIGURATION
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://api.promiapi.com";

// 🛡 Safe Mongoose Models Resolution
const ChatMessage = mongoose.models.ChatMessage || require("../models/ChatMessage");
const BotReply = mongoose.models.BotReply || require("../models/BotReply"); 
const BotFlow = mongoose.models.BotFlow || require("../models/BotFlow");
const UserSession = mongoose.models.UserSession || require("../models/UserSession");
const AiBotSettings = mongoose.models.AiBotSettings || require("../models/AiBotSettings");
const Contact = mongoose.models.Contact || require("../models/Contact");
const Template = mongoose.models.Template || require("../models/Template");
const User = mongoose.models.User || (mongoose.models.User ? mongoose.model("User") : null);
const Order = mongoose.models.Order || (mongoose.models.Order ? mongoose.model("Order") : null);
const WhatsAppConfig = mongoose.models.WhatsAppConfig || (mongoose.models.WhatsAppConfig ? mongoose.model("WhatsAppConfig") : null);

// 📞 CALL LOG & RECORDING MODEL FOR ADMIN MONITORING
const CallLog = mongoose.models.CallLog || mongoose.model("CallLog", new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  callId: { type: String, required: true, unique: true },
  customerPhone: { type: String, required: true },
  direction: { type: String, enum: ["inbound", "outbound"], default: "inbound" },
  status: { type: String, default: "initiated" },
  duration: { type: Number, default: 0 },
  recordingUrl: { type: String, default: null }
}, { timestamps: true }));

// 🔥 DYNAMIC FFMPEG PATH (Updated for Render / Linux using ffmpeg-static)
if (process.platform === "win32") {
  ffmpeg.setFfmpegPath("C:\\ffmpeg\\bin\\ffmpeg.exe");
  console.log("💻 Running on Local Windows - Loaded C:\\ffmpeg path");
} else {
  try {
    const ffmpegStatic = require("ffmpeg-static");
    if (ffmpegStatic) {
      ffmpeg.setFfmpegPath(ffmpegStatic);
      console.log("🐧 Running on Linux Production - Loaded ffmpeg-static path");
    }
  } catch (e) {
    console.log("🐧 Running on Linux Production Environment - Auto detecting global FFmpeg");
  }
}

// 📁 AUTO CREATE UPLOADS FOLDER IF MISSING
if (!fs.existsSync("uploads/")) {
  fs.mkdirSync("uploads/", { recursive: true });
}

// 📁 MULTER FILE STORAGE CONFIGURATION
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/"); 
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

const WEBHOOK_VERIFY_TOKEN_FALLBACK = process.env.WEBHOOK_VERIFY_TOKEN || "usama_javed_secret_token_123";

// Helper function to emit socket events for badge & sound effect
function emitNewMessageNotification(req, messageData, totalUnread = 0) {
  try {
    const io = req.app.get("io");
    if (io) {
      io.emit("new_message", messageData);
      io.emit("update_unread_count", {
        userId: messageData.userId,
        customerPhone: messageData.customerPhone,
        platform: messageData.platform,
        unreadCount: totalUnread
      });
    }
  } catch (err) {
    console.error("⚠️ Socket Notification Emission Error:", err.message);
  }
}

// =========================================================================
// 🛡️ DYNAMIC CHANNEL & META CREDENTIALS ENGINE (QR & OFFICIAL SUPPORT)
// =========================================================================
async function getActiveWhatsAppChannel(userId = null) {
  try {
    let conditions = [];
    if (userId) {
      const isObjectId = mongoose.Types.ObjectId.isValid(userId);
      conditions.push({ userId: userId }, { userId: String(userId) });
      if (isObjectId) conditions.push({ userId: new mongoose.Types.ObjectId(userId) });
    }
    let query = conditions.length > 0 ? { $or: conditions } : {};
    
    if (WhatsAppConfig) {
      const config = await WhatsAppConfig.findOne(query).sort({ updatedAt: -1 }).lean();
      if (config) {
        return {
          platformType: config.platform === "whatsapp_qr" ? "QR" : "OFFICIAL",
          config
        };
      }
    }
  } catch (err) {
    console.error("⚠️ Active WhatsApp Channel Resolution Error:", err.message);
  }
  return { platformType: "OFFICIAL", config: null };
}

async function getActiveMetaCredentials(userId = null, platform = "whatsapp") {
  let credentials = {
    accessToken: null,
    appSecret: null,
    phoneNumberId: null,
    pageId: null,
    instagramAccountId: null,
    userId: null
  };

  try {
    const MetaConfig = mongoose.models.MetaConfig || WhatsAppConfig;
    let config = null;

    if (userId) {
      const userConditions = [
        { userId: userId },
        { userId: String(userId) }
      ];
      if (mongoose.Types.ObjectId.isValid(userId)) {
        userConditions.push({ userId: new mongoose.Types.ObjectId(userId) });
      }

      if (WhatsAppConfig) {
        config = await WhatsAppConfig.findOne({ $or: userConditions, platform }).sort({ updatedAt: -1 }).lean();
        if (!config) {
          config = await WhatsAppConfig.findOne({ $or: userConditions }).sort({ updatedAt: -1 }).lean();
        }
      }

      if (!config && MetaConfig) {
        config = await MetaConfig.findOne({ $or: userConditions }).sort({ updatedAt: -1 }).lean();
      }
    }

    if (!config) {
      if (WhatsAppConfig) {
        config = await WhatsAppConfig.findOne({ 
          $or: [
            { accessToken: { $exists: true, $ne: "" } },
            { pageAccessToken: { $exists: true, $ne: "" } }
          ] 
        }).sort({ updatedAt: -1 }).lean();
      }

      if (!config && MetaConfig) {
        config = await MetaConfig.findOne({ 
          $or: [
            { accessToken: { $exists: true, $ne: "" } },
            { pageAccessToken: { $exists: true, $ne: "" } }
          ] 
        }).sort({ updatedAt: -1 }).lean();
      }
    }

    if (config) {
      const rawToken = config.pageAccessToken || config.accessToken || "";
      credentials.accessToken = String(rawToken).replace(/^["']|["']$/g, "").trim() || null;
      credentials.appSecret = config.appSecret || config.facebookAppSecret || null;
      credentials.phoneNumberId = config.phoneNumberId || null;
      credentials.pageId = config.pageId || null;
      credentials.instagramAccountId = config.instagramAccountId || null;
      credentials.userId = config.userId || null;

      if (credentials.accessToken) {
        console.log(`🔑 [DB CREDENTIALS RESOLVED] Platform: ${platform} | User: ${credentials.userId || "Global"}`);
        return credentials;
      }
    }
  } catch (err) {
    console.error("⚠️ Dynamic Meta Credentials Extraction Error:", err.message);
  }

  return credentials;
}

// 📱 Helper function to send WhatsApp message via QR / Baileys Engine with JID Resolution
async function sendQrWhatsAppMessage(userId, to, messageText) {
  try {
    const { getActiveSocket, startWhatsAppSession } = require("../routes/whatsappBaileysService");
    let sock = getActiveSocket(userId);

    if (!sock && userId) {
      const isObjectId = mongoose.Types.ObjectId.isValid(userId);
      const userCond = [{ userId: userId }, { userId: String(userId) }];
      if (isObjectId) userCond.push({ userId: new mongoose.Types.ObjectId(userId) });

      const qrConfigRecord = await WhatsAppConfig.findOne({ $or: userCond, platform: "whatsapp_qr", status: "CONNECTED" }).lean();
      if (qrConfigRecord) {
        console.log(`⚠️ [WEBHOOK QR RECOVERY] Socket missing in memory for user ${userId}. Auto-restoring session...`);
        try {
          await startWhatsAppSession(userId);
          await new Promise((resolve) => setTimeout(resolve, 2500));
          sock = getActiveSocket(userId);
        } catch (err) {
          console.error("❌ Failed to auto-restore session in webhook:", err.message);
        }
      }
    }

    if (!sock) {
      console.error(`❌ [QR SEND ERROR] Baileys active socket not found for user: ${userId}`);
      return null;
    }

    let cleanPhone = String(to || "").replace(/\D/g, "");
    if (cleanPhone.startsWith("03") && cleanPhone.length === 11) {
      cleanPhone = "92" + cleanPhone.substring(1);
    }

    let targetJid = `${cleanPhone}@s.whatsapp.net`;
    try {
      const [result] = await sock.onWhatsApp(cleanPhone);
      if (result && result.exists) {
        targetJid = result.jid;
      }
    } catch (err) {
      console.log("⚠️ onWhatsApp lookup warning in webhookRoutes:", err.message);
    }

    console.log(`📡 [QR WEB ENGINE TRANSMISSION] Target JID Resolved: ${targetJid} | Message: ${messageText}`);

    const sentResult = await sock.sendMessage(targetJid, { text: messageText });

    return { 
      success: true, 
      engine: "QR_BAILEYS", 
      messages: [{ id: sentResult?.key?.id || `qr-${Date.now()}` }] 
    };
  } catch (err) {
    console.error("❌ QR WhatsApp transmission failed:", err.message);
    return null;
  }
}

// 🟢 Helper function to send Meta WhatsApp message
async function sendMetaWhatsAppMessage(phoneNumberId, accessToken, to, metaPayload) {
  try {
    const cleanToken = accessToken ? accessToken.replace(/^["']|["']$/g, "").trim() : "";
    const metaUrl = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
    console.log(`📡 [META TRANSMISSION - WHATSAPP] Target Phone: ${to}`);
    const response = await axios.post(metaUrl, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to,
      ...metaPayload
    }, {
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip, deflate, br"
      },
      decompress: true
    });
    return response.data;
  } catch (err) {
    console.error("❌ Meta WhatsApp transmission API failed:", err.response?.data || err.message);
    return null;
  }
}

// ⚡ UNIVERSAL SENDER (AUTOMATICALLY SWITCHES BETWEEN QR AND OFFICIAL META)
async function sendUniversalWhatsAppMessage(userId, phoneNumberId, accessToken, to, metaPayload, messageText) {
  const channelInfo = await getActiveWhatsAppChannel(userId);

  if (channelInfo.platformType === "QR") {
    const plainText = messageText || metaPayload?.text?.body || "Media Message";
    return await sendQrWhatsAppMessage(userId, to, plainText);
  } else {
    return await sendMetaWhatsAppMessage(phoneNumberId, accessToken, to, metaPayload);
  }
}

// 🟣 Helper function to send Instagram / Messenger Direct Message payload with App Secret Proof
// 📎 Messenger attachment cache + direct byte upload (Meta's servers often time out fetching our ngrok URL)
const messengerAttachmentCache = new Map(); // `${pageId}|${url}` -> { id, at }
const ATTACH_MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".3gp": "video/3gpp", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".pdf": "application/pdf", ".txt": "text/plain", ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

async function uploadMessengerAttachment(pageId, cleanToken, queryParams, mediaUrl, attachType) {
  const cacheKey = `${pageId}|${mediaUrl}`;
  const cached = messengerAttachmentCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) return cached.id;

  const cleanPath = String(mediaUrl).split("?")[0];
  const ext = path.extname(cleanPath).toLowerCase();
  const fileName = path.basename(cleanPath) || `file${ext}`;

  // Read the bytes from local disk when it is one of our own /uploads files, else download them
  let buffer = null;
  try {
    const u = new URL(mediaUrl);
    if (u.pathname.startsWith("/uploads/")) {
      const localPath = path.resolve("uploads", path.basename(decodeURIComponent(u.pathname)));
      if (fs.existsSync(localPath)) buffer = fs.readFileSync(localPath);
    }
  } catch (e) { /* not a URL */ }

  if (!buffer) {
    const dl = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
      headers: { "ngrok-skip-browser-warning": "true", "User-Agent": "Mozilla/5.0" }
    });
    buffer = Buffer.from(dl.data);
  }

  const form = new FormData();
  form.append("message", JSON.stringify({ attachment: { type: attachType, payload: { is_reusable: true } } }));
  form.append("filedata", buffer, { filename: fileName, contentType: ATTACH_MIME[ext] || "application/octet-stream" });

  const up = await axios.post(`https://graph.facebook.com/v20.0/${pageId}/message_attachments`, form, {
    params: queryParams,
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 90000
  });

  const attachmentId = up.data?.attachment_id;
  if (attachmentId) messengerAttachmentCache.set(cacheKey, { id: attachmentId, at: Date.now() });
  return attachmentId || null;
}

// 🟣 Helper function to send Instagram / Messenger Direct Message payload with App Secret Proof
async function sendMetaDirectMessage(platform, pageOrIgId, recipientId, accessToken, appSecret, messagePayload) {
  try {
    const cleanToken = accessToken ? accessToken.replace(/^["']|["']$/g, "").trim() : "";
    const metaUrl = `https://graph.facebook.com/v20.0/${pageOrIgId}/messages`;
    console.log(`📡 [META TRANSMISSION - ${platform.toUpperCase()}] Target Recipient ID: ${recipientId}`);

    const queryParams = { access_token: cleanToken };
    if (appSecret) {
      queryParams.appsecret_proof = crypto.createHmac("sha256", appSecret).update(cleanToken).digest("hex");
    }

    const payload = JSON.parse(JSON.stringify(messagePayload || {}));
    const fallbackText = payload._fallbackText || null;
    delete payload._fallbackText;

    const post = async (msg) => {
      const response = await axios.post(
        metaUrl,
        { recipient: { id: recipientId }, message: msg },
        {
          params: queryParams,
          headers: { "Content-Type": "application/json", "Accept-Encoding": "gzip, deflate, br" },
          decompress: true,
          timeout: 60000
        }
      );
      return response.data;
    };

    const isTimeoutErr = (err) => {
      const e = err.response?.data?.error;
      return Boolean(
        (e && (e.code === -2 || e.error_subcode === 2018386 || /timeout/i.test(e.message || ""))) ||
        err.code === "ECONNABORTED"
      );
    };

    // one automatic retry on a Meta attachment timeout
    const sendWithRetry = async (msg) => {
      try {
        return await post(msg);
      } catch (err) {
        if (!isTimeoutErr(err)) throw err;
        console.warn(`⏳ Meta ${platform} attachment timeout - retrying once...`);
      }
      return await post(msg);
    };

    // 1) Messenger: upload the media bytes ourselves instead of letting Meta fetch our (slow) public URL
    const att = payload.attachment;
    if (platform === "messenger" && att?.payload?.url && !att.payload.attachment_id) {
      try {
        const attachmentId = await uploadMessengerAttachment(pageOrIgId, cleanToken, queryParams, att.payload.url, att.type);
        if (attachmentId) att.payload = { attachment_id: attachmentId };
      } catch (upErr) {
        console.warn("⚠️ Messenger attachment pre-upload failed, falling back to URL:", upErr.response?.data?.error?.message || upErr.message);
      }
    }

    // 2) Messenger / Instagram cannot show text inside a media message => media first, then the text (+ buttons)
    const splitText = Boolean(payload.attachment && payload.attachment.type !== "template" && fallbackText);
    const mediaMsg = splitText ? { attachment: payload.attachment } : payload;

    try {
      const mediaResp = await sendWithRetry(mediaMsg);
      if (splitText) {
        try {
          await post({ text: fallbackText, ...(payload.quick_replies ? { quick_replies: payload.quick_replies } : {}) });
        } catch (txtErr) {
          console.error(`❌ Meta ${platform} follow-up text failed:`, txtErr.response?.data || txtErr.message);
        }
      }
      return mediaResp;
    } catch (err) {
      const errCode = err.response?.data?.error?.code;
      const cannotRecover = [190, 10, 200, 551, 4, 17, 32, 613].includes(errCode); // token / permission / 24h-window / rate-limit
      if (!payload.attachment || cannotRecover) throw err;
      console.warn(`⚠️ Meta ${platform} media send failed (${err.response?.data?.error?.message || err.message}) - sending the reply without media so it is not lost.`);
    }

    // 3) last resort: drop the media so the clicked button's answer still reaches the customer
    const lite = { ...payload };
    if (lite.attachment?.type === "template") {
      const els = (lite.attachment.payload?.elements || []).map((el) => {
        const { image_url, ...rest } = el;
        return rest;
      });
      lite.attachment = { ...lite.attachment, payload: { ...lite.attachment.payload, elements: els } };
    } else if (lite.attachment) {
      delete lite.attachment;
      lite.text = fallbackText || "Please choose an option:";
    }
    return await post(lite);
  } catch (err) {
    console.error(`❌ Meta ${platform} transmission API failed:`, err.response?.data || err.message);
    return null;
  }
}

// 🟣 DYNAMIC DIRECT MESSAGE PAYLOAD BUILDER FOR INSTAGRAM & MESSENGER
function buildMetaDirectPayload(platform, textContent, buttonsArray = [], mediaUrl = null, templateObj = null) {
  let cleanMedia = mediaUrl ? normalizePublicMediaLink(mediaUrl) : null;
  const isInstagram = platform === "instagram";

  // Case 1: Template Object Attached (Generic Card Template)
  if (templateObj) {
    const title = templateObj.name || templateObj.title || "Template Card";
    const subtitle = templateObj.content || templateObj.description || textContent || "";
    const cardImage = normalizePublicMediaLink(templateObj.mediaUrl || mediaUrl);

    let templateButtons = [];
    if (buttonsArray && buttonsArray.length > 0) {
      templateButtons = buttonsArray.slice(0, 3).map((btn, idx) => {
        const bText = (typeof btn === "string" ? btn : (btn.text || btn.title || "Option")).substring(0, 20);
        const bType = String((btn && typeof btn === "object" && btn.type) || "").toLowerCase();
        if (bType === "url" || bType === "cta_url" || (btn && btn.url)) {
          return { type: "web_url", url: btn.url || btn.payload || "https://meta.com", title: bText };
        }
        return { type: "postback", title: bText, payload: String((btn && (btn.payload || btn.id)) || `btn_${idx}`) };
      });
    }

    return {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: title.substring(0, 80),
            subtitle: subtitle.substring(0, 80),
            ...(cardImage && { image_url: cardImage }),
            ...(templateButtons.length > 0 && { buttons: templateButtons })
          }]
        }
      }
    };
  }

  // Case 2: Buttons Present (Quick Replies / Button Template)
  if (buttonsArray && buttonsArray.length > 0) {
    const formattedQuickReplies = buttonsArray.slice(0, 13).map((btn, idx) => {
      const bText = (typeof btn === "string" ? btn : (btn.text || btn.title || "Option")).substring(0, 20);
      const bPayload = (btn && typeof btn === "object" && (btn.payload || btn.id)) ? (btn.payload || btn.id) : `btn_${idx}`;
      return {
        content_type: "text",
        title: bText,
        payload: String(bPayload)
      };
    });

    if (cleanMedia) {
      const ext = path.extname(cleanMedia.split("?")[0]).toLowerCase();
      let attachType = "image";
      if ([".mp4", ".mov", ".3gp", ".avi", ".mkv"].includes(ext)) attachType = "video";
      else if ([".mp3", ".ogg", ".wav", ".m4a"].includes(ext)) attachType = "audio";
      else if ([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt"].includes(ext)) attachType = "file";

      if (isInstagram && (attachType === "file" || attachType === "audio")) attachType = "image";

      return {
        attachment: {
          type: attachType,
          payload: { url: cleanMedia, is_reusable: true }
        },
        quick_replies: formattedQuickReplies,
        _fallbackText: textContent || "Please choose an option:"
      };
    }

    return {
      text: textContent || "Please choose an option:",
      quick_replies: formattedQuickReplies
    };
  }

  // Case 3: Media Only or Media + Text
  if (cleanMedia) {
    const ext = path.extname(cleanMedia.split("?")[0]).toLowerCase();
    let attachType = "image";
    if ([".mp4", ".mov", ".3gp", ".avi", ".mkv"].includes(ext)) attachType = "video";
    else if ([".mp3", ".ogg", ".wav", ".m4a"].includes(ext)) attachType = "audio";
    else if ([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt"].includes(ext)) attachType = "file";

    if (isInstagram && (attachType === "file" || attachType === "audio")) attachType = "image";

    return {
      attachment: {
        type: attachType,
        payload: { url: cleanMedia, is_reusable: true }
      },
      ...(textContent ? { _fallbackText: textContent } : {})
    };
  }

  // Case 4: Plain Text Fallback
  return { text: textContent || "Hello!" };
}

// 🧩 TEMPLATE HEADER RESOLVER (FIXES META ERROR 132012: "expected IMAGE, received UNKNOWN")
const TEMPLATE_MEDIA_FORMATS = ["IMAGE", "VIDEO", "DOCUMENT"];
const metaTemplateInfoCache = new Map();

// Purane ngrok / localhost / relative upload URLs ko current PUBLIC_BASE_URL par la deta hai
function normalizePublicMediaLink(rawUrl) {
  if (!rawUrl) return "";
  const url = String(rawUrl).trim();
  if (!url) return "";
  if (url.startsWith("/")) return `${PUBLIC_BASE_URL}${url}`;
  if (/^uploads\//i.test(url)) return `${PUBLIC_BASE_URL}/${url}`;
  try {
    const u = new URL(url);
    const isLocalHost = ["localhost", "127.0.0.1"].includes(u.hostname) || /ngrok/i.test(u.hostname);
    if (isLocalHost && u.pathname.startsWith("/uploads/")) {
      return `${PUBLIC_BASE_URL}${u.pathname}${u.search}`;
    }
  } catch (e) {}
  return url;
}

// Meta se template ki asli definition (header format, example media, body) laata hai. 10 min cache.
async function fetchMetaTemplateInfo(userId, templateName, language) {
  try {
    const Cfg = mongoose.models.WhatsAppConfig;
    if (!Cfg || !templateName) return null;

    const cacheKey = `${userId}:${templateName}:${language || ""}`;
    const cached = metaTemplateInfoCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;

    const cfg = await Cfg.findOne({ userId }).sort({ updatedAt: -1 }).lean();
    const waba = cfg?.businessAccountId;
    const token = cfg?.accessToken ? String(cfg.accessToken).replace(/^["']|["']$/g, "").trim() : "";
    if (!waba || !token) return null;

    const resp = await axios.get(`https://graph.facebook.com/v20.0/${waba}/message_templates`, {
      params: { name: templateName, limit: 20 },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000
    });

    const list = resp.data?.data || [];
    const picked =
      list.find(t => t.language === language && t.status === "APPROVED") ||
      list.find(t => t.status === "APPROVED") ||
      list[0];
    if (!picked) return null;

    const comps = picked.components || [];
    const header = comps.find(c => String(c.type).toUpperCase() === "HEADER");
    const body = comps.find(c => String(c.type).toUpperCase() === "BODY");
    const footer = comps.find(c => String(c.type).toUpperCase() === "FOOTER");

    const data = {
      format: header?.format ? String(header.format).toUpperCase() : "NONE",
      exampleUrl: header?.example?.header_handle?.[0] || "",
      bodyText: body?.text || "",
      footerText: footer?.text || "",
      language: picked.language || ""
    };
    metaTemplateInfoCache.set(cacheKey, { at: Date.now(), data });
    return data;
  } catch (err) {
    console.error("⚠️ Meta template info fetch failed:", err.response?.data?.error?.message || err.message);
    return null;
  }
}

// 📤 MEDIA SEEDHA META PAR UPLOAD (public link / ngrok par dependency khatam; 403 "Downloading media from weblink failed" ka hal)
const metaMediaIdCache = new Map();
const MEDIA_MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".mp4": "video/mp4", ".3gp": "video/3gpp",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".aac": "audio/aac", ".m4a": "audio/mp4", ".amr": "audio/amr"
};

// "/uploads/templates/a.jpg" jaisay link se local file dhoondta hai (100% robust)
function findLocalUploadFile(link) {
  try {
    let pathname = String(link || "");
    if (pathname.startsWith("http://") || pathname.startsWith("https://")) {
      pathname = decodeURIComponent(new URL(pathname).pathname);
    }
    const idx = pathname.indexOf("/uploads/");
    const rel = idx !== -1 ? pathname.slice(idx + "/uploads/".length) : path.basename(pathname);

    const candidates = [
      path.join(process.cwd(), "uploads", rel),
      path.join(__dirname, "..", "uploads", rel),
      path.join(__dirname, "uploads", rel),
      path.join(process.cwd(), "uploads", path.basename(pathname))
    ];
    for (const full of candidates) {
      if (fs.existsSync(full)) return full;
    }
  } catch (e) {}
  return null;
}

// File ke pehle bytes se asli type pehchano (extension par bharosa nahi)
function sniffMediaKind(buf) {
  if (!buf || buf.length < 4) return "empty";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buf.slice(0, 3).toString("ascii") === "GIF") return "gif";
  if (buf.slice(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.slice(8, 12).toString("ascii");
    return /^(avif|avis)$/.test(brand) ? "avif" : /^(heic|heix|mif1|msf1)$/.test(brand) ? "heic" : "mp4";
  }
  if (buf.slice(0, 4).toString("ascii") === "%PDF") return "pdf";
  const head = buf.slice(0, 200).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<")) return "html";
  return "unknown";
}

// Image ko Meta ke supported format (8-bit sRGB baseline JPEG, max 2048px) mein convert karta hai
async function normalizeImageForWhatsApp(buffer) {
  // 1) sharp (agar installed ho)
  try {
    const sharp = require("sharp");
    return await sharp(buffer)
      .rotate()
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (sharpErr) {
    if (sharpErr.code !== "MODULE_NOT_FOUND") console.warn("⚠️ sharp convert fail:", sharpErr.message);
  }

  // 2) ffmpeg (fluent-ffmpeg already project mein hai)
  const os = require("os");
  const tmpIn = path.join(os.tmpdir(), `wa-in-${Date.now()}-${Math.round(Math.random() * 1e6)}`);
  const tmpOut = `${tmpIn}.jpg`;
  try {
    fs.writeFileSync(tmpIn, buffer);
    await new Promise((resolve, reject) => {
      ffmpeg(tmpIn)
        .outputOptions(["-frames:v", "1", "-q:v", "2", "-pix_fmt", "yuvj420p", "-vf", "scale='min(2048,iw)':-2"])
        .on("end", resolve)
        .on("error", reject)
        .save(tmpOut);
    });
    return fs.readFileSync(tmpOut);
  } catch (ffErr) {
    console.warn("⚠️ ffmpeg image convert fail:", ffErr.message);
    return null;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (e) {}
    try { fs.unlinkSync(tmpOut); } catch (e) {}
  }
}

async function uploadMediaToMeta(phoneNumberId, accessToken, link) {
  try {
    if (!phoneNumberId || !accessToken || !link) return null;
    const cleanToken = String(accessToken).replace(/^["']|["']$/g, "").trim();

    const cacheKey = `v2:${phoneNumberId}:${link}`;
    const cached = metaMediaIdCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 20 * 24 * 60 * 60 * 1000) return cached.id;

    const ext = path.extname(link.split("?")[0]).toLowerCase();
    let filename = path.basename(link.split("?")[0]) || `file${ext}`;
    let mime = MEDIA_MIME_BY_EXT[ext];

    let buffer;
    let source;
    const localFile = findLocalUploadFile(link);
    
    if (localFile && fs.existsSync(localFile)) {
      buffer = fs.readFileSync(localFile);
      source = `local:${localFile}`;
    } else {
      try {
        const dl = await axios.get(link, { 
          responseType: "arraybuffer", 
          timeout: 15000, 
          maxRedirects: 3,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "ngrok-skip-browser-warning": "true"
          }
        });
        buffer = Buffer.from(dl.data);
        source = `download:${link}`;
        if (!mime) mime = String(dl.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
      } catch (dlErr) {
        console.warn(`⚠️ Direct download failed for ${link}: ${dlErr.message}. Trying direct uploads path fallback...`);
        const fallbackPath = path.join(process.cwd(), "uploads", path.basename(link.split("?")[0]));
        if (fs.existsSync(fallbackPath)) {
          buffer = fs.readFileSync(fallbackPath);
          source = `local-fallback:${fallbackPath}`;
        } else {
          throw dlErr;
        }
      }
    }

    const kind = sniffMediaKind(buffer);
    console.log(`🔬 [MEDIA INSPECT] ${source} | bytes=${buffer.length} | detected=${kind} | ext=${ext || "-"}`);

    if (kind === "html" || kind === "empty") {
      console.error(`❌ Ye file image/video nahi hai (${kind}). Link ya file kharab hai: ${source}`);
      return null;
    }

    const isImage = ["jpeg", "png", "webp", "gif", "avif", "heic"].includes(kind) || (mime || "").startsWith("image/");
    if (isImage) {
      const converted = await normalizeImageForWhatsApp(buffer);
      if (converted && sniffMediaKind(converted) === "jpeg") {
        buffer = converted;
        mime = "image/jpeg";
        filename = filename.replace(/\.[^.]+$/, "") + ".jpg";
        console.log(`🖼️ Image Meta-safe JPEG mein convert ho gayi (${buffer.length} bytes)`);
      } else {
        console.warn("⚠️ Image conversion skipped or failed, using original buffer/mime safely.");
        if (!mime || mime === "application/octet-stream") {
          mime = kind === "png" ? "image/png" : "image/jpeg";
        }
      }
      if (buffer.length > 5 * 1024 * 1024) {
        console.error(`❌ Image ${(buffer.length / 1048576).toFixed(1)}MB hai; WhatsApp header image 5MB se chhoti honi chahiye.`);
        return null;
      }
    } else if (!mime) {
      mime = "application/octet-stream";
    }

    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mime);
    form.append("file", buffer, { filename, contentType: mime });

    const resp = await axios.post(`https://graph.facebook.com/v20.0/${phoneNumberId}/media`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${cleanToken}` },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 60000
    });

    const id = resp.data?.id || null;
    if (id) {
      metaMediaIdCache.set(cacheKey, { at: Date.now(), id });
      console.log(`📤 [META MEDIA UPLOADED] ${filename} (${mime}) -> media id ${id}`);
    }
    return id;
  } catch (err) {
    console.error("⚠️ Meta media upload failed:", err.response?.data?.error?.message || err.message);
    return null;
  }
}

// Payload mein "link" ko Meta media "id" se badal deta hai (agar upload ho jaye)
async function swapMediaLinkForId(payload, phoneNumberId, accessToken) {
  try {
    const kind = payload?.type;
    if (!["image", "video", "document", "audio"].includes(kind)) return payload;
    const node = payload[kind];
    if (!node?.link) return payload;
    const id = await uploadMediaToMeta(phoneNumberId, accessToken, node.link);
    if (!id) return payload;
    const { link, ...rest } = node;
    return { ...payload, [kind]: { ...rest, id } };
  } catch (e) {
    return payload;
  }
}

// 🔎 Bhejne se pehle check: kya Meta is media link ko download kar sakega?
const mediaLinkCheckCache = new Map();
async function verifyPublicMediaLink(link, format) {
  if (!link) return { ok: false, reason: "empty link" };
  const key = `${format}:${link}`;
  const cached = mediaLinkCheckCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.result;

  let result = { ok: true };
  try {
    const resp = await axios.get(link, {
      headers: { 
        Range: "bytes=0-1023",
        "User-Agent": "Mozilla/5.0",
        "ngrok-skip-browser-warning": "true"
      },
      responseType: "arraybuffer",
      timeout: 6000,
      maxRedirects: 3,
      validateStatus: () => true
    });
    const ct = String(resp.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();

    if (resp.status < 200 || resp.status >= 300) {
      result = { ok: false, reason: `HTTP ${resp.status} (file/tunnel nahi mil raha)` };
    } else if (ct === "text/html") {
      result = { ok: false, reason: "link media ki jagah HTML page de raha hai (ngrok warning page ya tunnel band?)" };
    } else if (format === "IMAGE" && !["image/jpeg", "image/png"].includes(ct)) {
      result = { ok: false, reason: `image type "${ct || "unknown"}" supported nahi (WhatsApp header sirf JPG/PNG)` };
    } else if (format === "VIDEO" && !["video/mp4", "video/3gpp"].includes(ct)) {
      result = { ok: false, reason: `video type "${ct || "unknown"}" supported nahi (sirf MP4/3GPP)` };
    }
  } catch (err) {
    console.warn(`⚠️ Media link check inconclusive (${link}): ${err.message}`);
  }

  mediaLinkCheckCache.set(key, { at: Date.now(), result });
  return result;
}

// Header ka format + media link decide karta hai
async function resolveTemplateHeader(userId, templateObj, templateName, rule, phoneNumberId = null, accessToken = null) {
  const localFormat = String(templateObj?.headerType || "").toUpperCase();
  const localUrl = normalizePublicMediaLink(templateObj?.mediaUrl || rule?.mediaUrl || "");

  let format = "NONE";
  let link = "";
  let meta = null;

  if (TEMPLATE_MEDIA_FORMATS.includes(localFormat) && localUrl) {
    format = localFormat;
    link = localUrl;
  } else {
    meta = await fetchMetaTemplateInfo(userId, templateName, templateObj?.language);
    format = meta ? meta.format : (localFormat || "NONE");
    if (TEMPLATE_MEDIA_FORMATS.includes(format)) {
      link = localUrl || normalizePublicMediaLink(meta?.exampleUrl);
    }
  }

  let mediaId = null;
  if (TEMPLATE_MEDIA_FORMATS.includes(format) && link) {
    mediaId = await uploadMediaToMeta(phoneNumberId, accessToken, link);
  }

  if (TEMPLATE_MEDIA_FORMATS.includes(format) && link && !mediaId) {
    const check = await verifyPublicMediaLink(link, format);
    if (!check.ok) {
      console.error(`❌ [MEDIA LINK UNUSABLE] ${link} -> ${check.reason}. Isse Meta baad mein "failed" status deta. Normal fallback use hoga.`);
      link = "";
    }
  }

  return { format, link, mediaId, meta };
}

// Template fail ho jaye to 24h window ke andar normal media/text message bhej do
function buildTemplateFallbackPayload(hdr, templateObj, rule) {
  const bodyText = templateObj?.content || hdr?.meta?.bodyText || rule?.replyText || "";
  const footer = templateObj?.footerText || hdr?.meta?.footerText || "";
  let full = footer ? `${bodyText}\n\n${footer}` : bodyText;
  if (!String(full).trim()) full = "Hello!";

  if (TEMPLATE_MEDIA_FORMATS.includes(hdr?.format) && (hdr?.mediaId || hdr?.link)) {
    const kind = hdr.format.toLowerCase();
    const caption = full.slice(0, 1000);
    const ref = hdr.mediaId ? { id: hdr.mediaId } : { link: hdr.link };
    if (kind === "document") {
      const filename = path.basename((hdr.link || "file").split("?")[0]) || "file";
      return { type: "document", document: { ...ref, caption, filename } };
    }
    return { type: kind, [kind]: { ...ref, caption } };
  }
  return { type: "text", text: { body: full.slice(0, 4000) } };
}

// 🎯 HELPER TO CONSTRUCT DYNAMIC PUBLIC MEDIA PAYLOAD FOR META
function buildMediaPayload(mediaUrl, captionText = "") {
  if (!mediaUrl) return null;
  
  let cleanUrl = mediaUrl.trim();

  if (cleanUrl.includes("localhost:5000") || cleanUrl.includes("127.0.0.1:5000")) {
    cleanUrl = cleanUrl.replace(/http:\/\/(localhost|127\.0\.0\.1):5000/, PUBLIC_BASE_URL);
  } else if (cleanUrl.startsWith("/uploads/")) {
    cleanUrl = `${PUBLIC_BASE_URL}${cleanUrl}`;
  }

  const urlWithoutParams = cleanUrl.split("?")[0];
  const ext = path.extname(urlWithoutParams).toLowerCase();

  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) || cleanUrl.includes("image")) {
    return { type: "image", image: { link: cleanUrl, caption: captionText } };
  } else if ([".mp4", ".3gp", ".mov", ".mkv", ".avi"].includes(ext) || cleanUrl.includes("video")) {
    return { type: "video", video: { link: cleanUrl, caption: captionText } };
  } else if ([".mp3", ".aac", ".ogg", ".wav", ".m4a", ".webm"].includes(ext) || cleanUrl.includes("audio")) {
    return { type: "audio", audio: { link: cleanUrl } };
  } else {
    return { 
      type: "document", 
      document: { 
        link: cleanUrl, 
        caption: captionText, 
        filename: path.basename(urlWithoutParams) || "Attachment" 
      } 
    };
  }
}

// 🛠️ DOWNLOAD & SAVE INCOMING META MEDIA LOCALLY
async function downloadAndSaveMetaMedia(mediaId, accessToken, mimeType = "") {
  try {
    if (!mediaId || !accessToken) return null;
    const cleanToken = accessToken.replace(/^["']|["']$/g, "").trim();

    const mediaMetaRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${cleanToken}` }
    });

    const downloadUrl = mediaMetaRes.data?.url;
    if (!downloadUrl) return null;

    let ext = ".jpg";
    const detectedMime = mediaMetaRes.data?.mime_type || mimeType;
    
    if (detectedMime.includes("image/png")) ext = ".png";
    else if (detectedMime.includes("image/gif")) ext = ".gif";
    else if (detectedMime.includes("image/webp")) ext = ".webp";
    else if (detectedMime.includes("video/mp4")) ext = ".mp4";
    else if (detectedMime.includes("audio/ogg") || detectedMime.includes("opus")) ext = ".ogg";
    else if (detectedMime.includes("audio/mpeg") || detectedMime.includes("mp3")) ext = ".mp3";
    else if (detectedMime.includes("pdf")) ext = ".pdf";

    const fileResponse = await axios.get(downloadUrl, {
      headers: { Authorization: `Bearer ${cleanToken}` },
      responseType: "arraybuffer"
    });

    const fileName = `whatsapp-media-${Date.now()}-${Math.round(Math.random() * 1e4)}${ext}`;
    const filePath = path.join("uploads", fileName);
    fs.writeFileSync(filePath, Buffer.from(fileResponse.data));

    const publicMediaUrl = `${PUBLIC_BASE_URL}/uploads/${fileName}`;
    console.log(`✅ [MEDIA SAVED LOCALLY]: ${publicMediaUrl}`);
    return publicMediaUrl;
  } catch (err) {
    console.error("❌ Error downloading and saving Meta Media:", err.response?.data || err.message);
    return null;
  }
}

// 🇵🇰 Helper to format local and international phone numbers cleanly
function formatToInternationalPhone(phoneStr) {
  if (!phoneStr) return null;
  let cleaned = String(phoneStr).replace(/\D/g, "");
  
  if (cleaned.startsWith("9203") && cleaned.length === 12) {
    cleaned = "92" + cleaned.substring(3);
  } 
  else if (cleaned.startsWith("03") && cleaned.length === 11) {
    cleaned = "92" + cleaned.substring(1);
  }
  return cleaned;
}

function resolveCourierTrackingUrl(courierName, trackingCode, fallbackUrl) {
  if (!trackingCode) return fallbackUrl;

  const courier = (courierName || "").toLowerCase();
  const code = encodeURIComponent(trackingCode.trim());

  if (courier.includes("trax")) {
    return `https://trax.pk/tracking?cn=${code}`;
  } else if (courier.includes("postex")) {
    return `https://postex.pk/tracking?cn=${code}`;
  } else if (courier.includes("leopard")) {
    return `https://www.leopardscourier.com/tracking?cn=${code}`;
  } else if (courier.includes("tcs")) {
    return `https://www.tcsexpress.com/tracking?consignmentNo=${code}`;
  } else if (courier.includes("mnp") || courier.includes("m&p")) {
    return `https://mulphilog.com/tracking?consignmentNo=${code}`;
  }

  return fallbackUrl;
}

function extractShopifyPhone(shopifyData) {
  return (
    shopifyData.customer?.phone ||
    shopifyData.shipping_address?.phone ||
    shopifyData.billing_address?.phone ||
    shopifyData.destination?.phone ||
    shopifyData.fulfillments?.[0]?.destination?.phone ||
    shopifyData.phone ||
    null
  );
}

function extractWooPhone(wooData) {
  return (
    wooData.billing?.phone ||
    wooData.shipping?.phone ||
    wooData.customer?.phone ||
    null
  );
}

function isWithinOperatingHours(timing) {
  if (!timing || !timing.enabled) return true;
  if (!timing.startTime || !timing.endTime) return true;

  try {
    const tz = timing.timezone || "UTC";
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hour = parts.find((p) => p.type === "hour").value;
    const minute = parts.find((p) => p.type === "minute").value;
    const currentTimeStr = `${hour}:${minute}`;

    return currentTimeStr >= timing.startTime && currentTimeStr <= timing.endTime;
  } catch (e) {
    console.error("⚠️ Timezone Evaluation Error:", e.message);
    return true;
  }
}

async function verifyUserAiSubscription(userId) {
  if (!userId) return false;
  try {
    const settings = await AiBotSettings.findOne({ userId }).lean();
    if (settings) {
      if (settings.isAiSubscribed === true || settings.subscriptionActive === true || settings.isSubscribed === true) {
        return true;
      }
      if (settings.subscriptionStatus === "active" || settings.planType === "ai" || settings.plan === "pro") {
        return true;
      }
    }

    if (User) {
      const user = await User.findById(userId).lean();
      if (user) {
        if (user.isAiSubscribed === true || user.subscriptionActive === true || user.isSubscribed === true) {
          return true;
        }
        if (user.subscriptionStatus === "active" || user.planType === "ai" || user.plan === "pro" || user.aiEnabled === true) {
          return true;
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Subscription Verification Error:", err?.message);
  }
  return false;
}

async function fetchExternalCBSData(functionName, args, customerPhone, settings) {
  try {
    console.log(`🌐 [UNIVERSAL TOOL EXECUTION] Function: ${functionName} | Customer: ${customerPhone}`);

    if (functionName === "get_customer_orders_status") {
      if (Order) {
        const cleanPhone = formatToInternationalPhone(customerPhone);
        const orders = await Order.find({ 
          $or: [
            { customerPhone: cleanPhone },
            { customerPhone: customerPhone },
            { phone: cleanPhone }
          ] 
        }).sort({ createdAt: -1 }).limit(5).lean();

        if (orders && orders.length > 0) {
          return { status: "success", count: orders.length, orders };
        }
      }
      return { status: "no_orders_found", message: "No recent orders found in system for this phone number." };
    }

    const externalApiConfig = settings?.externalApi || {};
    const targetApiUrl = externalApiConfig.baseUrl || process.env.EXTERNAL_CBS_API_URL;
    const apiSecretKey = externalApiConfig.apiKey || process.env.EXTERNAL_CBS_API_KEY;

    if (targetApiUrl) {
      const response = await axios.post(
        targetApiUrl,
        {
          functionName,
          customerPhone,
          parameters: args
        },
        {
          headers: {
            "Authorization": `Bearer ${apiSecretKey}`,
            "Content-Type": "application/json"
          },
          timeout: 10000
        }
      );
      return response.data;
    }

    if (functionName === "get_bank_account_balance") {
      return { status: "success", accountNumber: `PK36XXXX${customerPhone.slice(-4)}`, balance: "125,450 PKR", currency: "PKR", accountStatus: "Active", lastTransaction: "10,000 PKR Received" };
    }
    if (functionName === "get_transaction_history") {
      return { status: "success", transactions: ["10,000 PKR Received (Today)", "5,000 PKR Sent (Yesterday)", "1,200 PKR Utility Bill (3 days ago)"] };
    }
    if (functionName === "block_credit_card") {
      return { status: "success", message: "Your credit card has been temporarily blocked for security reasons." };
    }
    if (functionName === "request_cheque_book") {
      return { status: "success", message: "Cheque book request registered successfully. It will be delivered to your registered address in 3-5 working days." };
    }
    if (functionName === "apply_for_personal_loan") {
      return { status: "success", eligibility: "Pre-approved up to 500,000 PKR", message: "Loan application initiated. Our representative will contact you shortly." };
    }
    if (functionName === "get_forex_rates") {
      return { status: "success", rates: { USD: "278.50 PKR", EUR: "302.20 PKR", GBP: "360.10 PKR" } };
    }

    return { status: "success", message: `Function ${functionName} executed successfully with arguments: ${JSON.stringify(args)}` };
  } catch (err) {
    console.error("❌ External Server Tool Execution Error:", err.response?.data || err.message);
    return { error: "Failed to connect to external system server." };
  }
}

async function handleManualFunctionExecution(targetUserId, customerPhone, cleanKeyword, userSession) {
  try {
    const settings = await AiBotSettings.findOne({ userId: targetUserId });
    
    let functionName = null;
    const text = cleanKeyword.toLowerCase();

    if (text.includes("balance") || text.includes("account") || text === "1" || (userSession && userSession.currentStep === "BALANCE_CHECK")) {
      functionName = "get_bank_account_balance";
    } else if (text.includes("order") || text.includes("tracking") || text.includes("history") || text.includes("status") || text === "2" || (userSession && userSession.currentStep === "ORDER_HISTORY")) {
      functionName = "get_customer_orders_status";
    } else if (text.includes("transaction") || text.includes("statement")) {
      functionName = "get_transaction_history";
    } else if (text.includes("block") || text.includes("card")) {
      functionName = "block_credit_card";
    } else if (text.includes("cheque") || text.includes("checkbook")) {
      functionName = "request_cheque_book";
    } else if (text.includes("loan") || text.includes("finance")) {
      functionName = "apply_for_personal_loan";
    }

    if (functionName) {
      const data = await fetchExternalCBSData(functionName, {}, customerPhone, settings);
      if (data) {
        if (functionName === "get_bank_account_balance" && data.status === "success") {
          return `🏦 *Bank Account Details*\n\nAccount: ${data.accountNumber}\nBalance: *${data.balance}*\nStatus: ${data.accountStatus}\nLast Tx: ${data.lastTransaction}`;
        } else if (functionName === "get_customer_orders_status" && data.status === "success" && data.orders) {
          let textReply = `📦 *Your Recent Orders (${data.count}):*\n\n`;
          data.orders.forEach((ord, idx) => {
            textReply += `${idx + 1}. ID: *${ord.orderId}* | Status: *${ord.status}* | RS ${ord.totalPrice}\n`;
          });
          return textReply;
        } else if (data.message) {
          return `ℹ️ ${data.message}`;
        }
      }
    }
  } catch (err) {
    console.error("❌ Manual Function Execution Error:", err.message);
  }
  return null;
}

async function processAiBotResponse(userId, customerPhone, userText) {
  try {
    const isSubscribed = await verifyUserAiSubscription(userId);
    if (!isSubscribed) {
      return null;
    }

    const settings = await AiBotSettings.findOne({ userId });
    if (!settings) return null;

    if (!isWithinOperatingHours(settings.timing)) {
      return null;
    }

    if (settings.advanced?.responseDelay > 0) {
      await new Promise((res) => setTimeout(res, settings.advanced.responseDelay * 1000));
    }

    if (settings.flowise?.enabled && settings.flowise?.apiUrl) {
      try {
        const flowiseRes = await axios.post(
          settings.flowise.apiUrl, 
          { question: userText },
          {
            headers: { "Accept-Encoding": "gzip, deflate, br" },
            decompress: true
          }
        );
        const text = flowiseRes.data?.text || flowiseRes.data?.textResponse || flowiseRes.data;
        if (typeof text === "string" && text.trim()) {
          return text.trim();
        }
      } catch (fErr) {
        console.error("❌ Flowise Request Failed:", fErr.message);
      }
    }

    if (settings.openai?.enabled && settings.openai?.apiKey) {
      try {
        const messages = [];
        if (settings.openai.systemPrompt) {
          messages.push({ role: "system", content: settings.openai.systemPrompt });
        }

        const chatHistory = await ChatMessage.find({ userId, customerPhone })
          .sort({ createdAt: -1 })
          .limit(12);
        
        chatHistory.reverse().forEach((msg) => {
          messages.push({
            role: msg.sender === "me" ? "assistant" : "user",
            content: msg.text || "",
          });
        });

        messages.push({ role: "user", content: userText });

        const tools = [
          {
            type: "function",
            function: {
              name: "get_bank_account_balance",
              description: "Fetch customer bank account balance, account number, and status from CBS.",
              parameters: { type: "object", properties: {}, required: [] }
            }
          },
          {
            type: "function",
            function: {
              name: "get_transaction_history",
              description: "Fetch recent transaction history for customer bank account.",
              parameters: { type: "object", properties: {}, required: [] }
            }
          },
          {
            type: "function",
            function: {
              name: "block_credit_card",
              description: "Block lost or stolen credit or debit card immediately.",
              parameters: { type: "object", properties: {}, required: [] }
            }
          },
          {
            type: "function",
            function: {
              name: "request_cheque_book",
              description: "Order a new cheque book delivery for customer account.",
              parameters: { type: "object", properties: {}, required: [] }
            }
          },
          {
            type: "function",
            function: {
              name: "apply_for_personal_loan",
              description: "Check personal loan eligibility and initiate new loan application.",
              parameters: { type: "object", properties: {}, required: [] }
            }
          },
          {
            type: "function",
            function: {
              name: "get_forex_rates",
              description: "Get current live foreign exchange rates for currencies.",
              parameters: { type: "object", properties: {}, required: [] }
            }
          },
          {
            type: "function",
            function: {
              name: "get_customer_orders_status",
              description: "Fetch real-time order status, courier tracking, and details from database for this customer.",
              parameters: { type: "object", properties: {}, required: [] }
            }
          }
        ];

        const openAiRes = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          {
            model: settings.openai.model || "gpt-4o",
            messages,
            tools,
            tool_choice: "auto",
            temperature: settings.openai.temperature ?? 0.7,
          },
          {
            headers: {
              Authorization: `Bearer ${settings.openai.apiKey}`,
              "Content-Type": "application/json",
              "Accept-Encoding": "gzip, deflate, br"
            },
            decompress: true
          }
        );

        const responseMessage = openAiRes.data?.choices?.[0]?.message;

        if (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0) {
          const toolCall = responseMessage.tool_calls[0];
          const functionName = toolCall.function.name;
          const functionArgs = JSON.parse(toolCall.function.arguments || "{}");

          const toolExecutionData = await fetchExternalCBSData(functionName, functionArgs, customerPhone, settings);

          messages.push(responseMessage);
          messages.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: functionName,
            content: JSON.stringify(toolExecutionData)
          });

          const secondAiRes = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
              model: settings.openai.model || "gpt-4o",
              messages,
              temperature: settings.openai.temperature ?? 0.7
            },
            {
              headers: {
                Authorization: `Bearer ${settings.openai.apiKey}`,
                "Content-Type": "application/json",
                "Accept-Encoding": "gzip, deflate, br"
              },
              decompress: true
            }
          );

          const finalReply = secondAiRes.data?.choices?.[0]?.message?.content;
          if (finalReply && finalReply.trim()) {
            return finalReply.trim();
          }
        }

        if (responseMessage?.content && responseMessage.content.trim()) {
          return responseMessage.content.trim();
        }
      } catch (oErr) {
        console.error("❌ OpenAI API Request Failed:", oErr.response?.data || oErr.message);
      }
    }

    if (settings.general?.failedMessage) {
      return settings.general.failedMessage;
    }

    return null;
  } catch (err) {
    console.error("❌ AI Bot Engine Execution Crash:", err.message);
    return null;
  }
}

function checkRuleMatch(rule, cleanKeyword) {
  const rawKw = String(rule.keyword || "").trim().toLowerCase();
  if (!rawKw) return false;
  
  const keywords = rawKw.split(",").map((k) => k.trim().replace(/\s+/g, " ")).filter(Boolean);

  return keywords.some((keyword) => {
    switch (rule.matchType || "exact") {
      case "contains":
        return cleanKeyword.includes(keyword);
      case "startsWith":
        return cleanKeyword.startsWith(keyword);
      case "exact":
      default:
        return cleanKeyword === keyword;
    }
  });
}

async function processShopifyNotification(shopifyData, topic, userId = null) {
  const rawPhone = extractShopifyPhone(shopifyData);
  if (!rawPhone) return "NO_PHONE_NUMBER";

  const cleanPhone = formatToInternationalPhone(rawPhone);
  const customerName = shopifyData.customer?.first_name || shopifyData.billing_address?.first_name || shopifyData.shipping_address?.first_name || "Customer";
  const orderId = shopifyData.name || (shopifyData.order_number ? `#${shopifyData.order_number}` : `#${shopifyData.id}`);
  const totalPrice = shopifyData.total_price || shopifyData.current_total_price || "0.00";

  const itemsList = (shopifyData.line_items && shopifyData.line_items.length > 0)
    ? shopifyData.line_items.map(item => `${item.title} (x${item.quantity})`).join(", ")
    : "Items details unavailable";

  const orderStatusUrl = shopifyData.order_status_url || `${PUBLIC_BASE_URL}/orders/${shopifyData.id}`;

  let trackingNumber = shopifyData.fulfillments?.[0]?.tracking_number || shopifyData.tracking_number || null;
  let trackingCompany = shopifyData.fulfillments?.[0]?.tracking_company || shopifyData.tracking_company || null;
  let finalTrackingUrl = shopifyData.fulfillments?.[0]?.tracking_url || resolveCourierTrackingUrl(trackingCompany, trackingNumber, orderStatusUrl);

  let currentOrderStatus = "received";
  let messageText = "";

  if (topic.includes("fulfillments") || topic.includes("ship") || shopifyData.fulfillment_status === "fulfilled") {
    currentOrderStatus = "dispatched";
    messageText = 
      `Great news ${customerName}! 🚚\n` +
      `Your Order *${orderId}* has been dispatched!\n\n` +
      `📦 *Tracking ID:* ${trackingNumber || "Assigned Soon"}\n` +
      `📌 *Track Parcel:* ${finalTrackingUrl}\n\n` +
      `Keep an eye out for your package!`;
  } 
  else if (topic.includes("cancelled") || shopifyData.cancelled_at) {
    currentOrderStatus = "cancelled";
    messageText = 
      `Hi ${customerName}, your order *${orderId}* has been cancelled.\n` +
      `If this was a mistake, please reach out to us!`;
  } 
  else {
    messageText = 
      `Hi ${customerName}! 👋\n` +
      `Your Order *${orderId}* has been received successfully!\n\n` +
      `🛒 *Items:* ${itemsList}\n` +
      `💳 *Total Amount:* RS ${totalPrice}\n` +
      `📌 *Track Status:* ${orderStatusUrl}\n\n` +
      `Thank you for shopping with us!`;
  }

  const { accessToken, phoneNumberId, userId: targetUserId } = await getActiveMetaCredentials(userId, "whatsapp");

  if (Order) {
    await Order.findOneAndUpdate(
      { orderId: String(orderId) },
      {
        $set: {
          userId: targetUserId ? String(targetUserId) : (userId ? String(userId) : "global_store_user"),
          orderId: String(orderId),
          customerName: customerName,
          customerPhone: cleanPhone,
          totalPrice: totalPrice,
          items: itemsList,
          status: currentOrderStatus.toLowerCase(),
          trackingNumber: trackingNumber,
          trackingUrl: finalTrackingUrl,
          source: "shopify"
        }
      },
      { upsert: true, returnDocument: 'after' }
    );
  }

  if (messageText) {
    const metaPayload = {
      type: "text",
      text: { body: messageText }
    };

    const metaResponse = await sendUniversalWhatsAppMessage(targetUserId, phoneNumberId, accessToken, cleanPhone, metaPayload, messageText);

    if (metaResponse) {
      const rawWamid = metaResponse.messages?.[0]?.id;
      const wamid = rawWamid ? rawWamid.trim() : `shopify-${Date.now()}`;

      await new ChatMessage({
        userId: targetUserId,
        messageId: wamid,
        customerPhone: cleanPhone,
        customerName: customerName,
        sender: "me",
        platform: "whatsapp",
        isBotMessage: true,
        text: messageText,
        status: "sent"
      }).save();
    }
  }

  return "SHOPIFY_WEBHOOK_PROCESSED";
}

async function processWooCommerceNotification(wooData, userId = null) {
  const orderStatus = (wooData.status || "").toLowerCase();
  const rawPhone = extractWooPhone(wooData);

  if (!rawPhone) return "NO_PHONE_NUMBER";

  const cleanPhone = formatToInternationalPhone(rawPhone);
  const customerName = wooData.billing?.first_name || wooData.shipping?.first_name || "Customer";
  const orderId = wooData.number || `#${wooData.id}`;
  const totalPrice = wooData.total || "0.00";

  const itemsList = (wooData.line_items && wooData.line_items.length > 0)
    ? wooData.line_items.map(item => `${item.name} (x${item.quantity})`).join(", ")
    : "Items details unavailable";

  const metaTrackingObj = wooData.meta_data?.find(m => m.key && m.key.toLowerCase().includes('tracking'));
  const metaCourierObj = wooData.meta_data?.find(m => m.key && m.key.toLowerCase().includes('courier'));

  const rawTrackingNumber = metaTrackingObj ? String(metaTrackingObj.value).trim() : null;
  const rawCourierName = metaCourierObj ? String(metaCourierObj.value).trim() : null;

  const fallbackTrackingUrl = `${PUBLIC_BASE_URL}/my-account/view-order/${wooData.id}`;
  const finalTrackingUrl = rawTrackingNumber 
    ? resolveCourierTrackingUrl(rawCourierName, rawTrackingNumber, fallbackTrackingUrl)
    : fallbackTrackingUrl;

  let messageText = "";

  if (orderStatus === "pending" || orderStatus === "pending-payment") {
    messageText = 
      `Hi ${customerName}! 👋\n` +
      `Your Order *${orderId}* is currently *PENDING PAYMENT*.\n\n` +
      `🛒 *Items:* ${itemsList}\n` +
      `💳 *Total Amount:* RS ${totalPrice}\n\n` +
      `Please complete your payment to process the order.`;
  }
  else if (orderStatus === "on-hold") {
    messageText = 
      `Hi ${customerName}! ⏸️\n` +
      `Your Order *${orderId}* has been placed **ON HOLD**.\n\n` +
      `💵 *Total Amount:* RS ${totalPrice}\n` +
      `📌 *Reason:* Payment verification / Bank Transfer confirmation needed.\n\n` +
      `We will process your order as soon as payment is confirmed!`;
  }
  else if (orderStatus === "processing") {
    messageText = 
      `Hi ${customerName}! 👋\n` +
      `Thank you for your order *${orderId}*!\n\n` +
      `🛒 *Items:* ${itemsList}\n` +
      `💳 *Total Amount:* RS ${totalPrice}\n\n` +
      `We are processing your order now!`;
  } 
  else if (orderStatus === "completed" || orderStatus === "dispatched" || orderStatus === "shipped") {
    messageText = 
      `Great news ${customerName}! 🚚\n` +
      `Your Order *${orderId}* has been dispatched!\n\n` +
      `📦 *Tracking ID:* ${rawTrackingNumber || "N/A"}\n` +
      `📌 *Track Parcel:* ${finalTrackingUrl}\n\n` +
      `Keep an eye out for your package!`;
  }
  else if (orderStatus === "delivered") {
    messageText = 
      `Hi ${customerName}! 🎉\n` +
      `Your Order *${orderId}* has been successfully delivered!\n\n` +
      `We hope you loved your purchase. Please share your feedback with us!`;
  }
  else if (orderStatus === "cancelled" || orderStatus === "failed" || orderStatus === "refunded") {
    messageText = 
      `Hi ${customerName}, your order *${orderId}* has been marked as ${orderStatus}.\n` +
      `If you have any questions, please feel free to reach out to us.`;
  }

  const { accessToken, phoneNumberId, userId: targetUserId } = await getActiveMetaCredentials(userId, "whatsapp");

  if (Order) {
    await Order.findOneAndUpdate(
      { orderId: String(orderId) },
      {
        $set: {
          userId: targetUserId ? String(targetUserId) : (userId ? String(userId) : "global_store_user"),
          orderId: String(orderId),
          customerName: customerName,
          customerPhone: cleanPhone,
          totalPrice: totalPrice,
          items: itemsList,
          status: orderStatus,
          trackingNumber: rawTrackingNumber,
          trackingUrl: finalTrackingUrl,
          source: "woocommerce"
        }
      },
      { upsert: true, returnDocument: 'after' }
    );
  }

  if (messageText) {
    const metaPayload = {
      type: "text",
      text: { body: messageText }
    };

    const metaResponse = await sendUniversalWhatsAppMessage(targetUserId, phoneNumberId, accessToken, cleanPhone, metaPayload, messageText);

    if (metaResponse) {
      const rawWamid = metaResponse.messages?.[0]?.id;
      const wamid = rawWamid ? rawWamid.trim() : `woo-${Date.now()}`;

      await new ChatMessage({
        userId: targetUserId,
        messageId: wamid,
        customerPhone: cleanPhone,
        customerName: customerName,
        sender: "me",
        platform: "whatsapp",
        isBotMessage: true,
        text: messageText,
        status: "sent"
      }).save();
    }
  }

  return "WOOCOMMERCE_WEBHOOK_PROCESSED";
}

// =========================================================================
// 🛡 DUPLICATE WEBHOOK GUARD  (Meta retries the same event when we answer slowly / with 5xx)
// =========================================================================
const recentInboundIds = new Map();
async function isDuplicateInbound(rawId) {
  if (!rawId) return false;
  const key = String(rawId).trim();
  const now = Date.now();
  for (const [k, t] of recentInboundIds) {
    if (now - t > 10 * 60 * 1000) recentInboundIds.delete(k);
  }
  if (recentInboundIds.has(key)) return true;
  recentInboundIds.set(key, now);
  return false;
}

// =========================================================================
// 🖼 VISUAL FLOW NODE CONTENT RESOLVERS (media / text can live under different field names)
// =========================================================================
const FLOW_MEDIA_EXT = /\.(jpe?g|png|gif|webp|bmp|mp4|3gp|mov|mkv|avi|mp3|ogg|opus|wav|m4a|aac|pdf|docx?|xlsx?|pptx?|txt|csv)$/i;

function pickFlowNodeText(nodeData, allowLabel = false) {
  const d = nodeData || {};
  const candidates = [d.message, d.text, d.caption, d.body, d.content, d.description, d.title, allowLabel ? d.label : null];
  const found = candidates.find((v) => typeof v === "string" && v.trim());
  return found ? found.trim() : "";
}

// walks the whole node.data (any field name, nested objects / arrays) looking for a media link.
// returns { url } | { invalid } | null.  Button objects are scanned last (their urls are usually CTA links).
function deepFindMediaUrl(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const v = value.trim();
    if (!v) return null;
    if (/^(blob:|data:)/i.test(v)) return { invalid: v.substring(0, 30) };
    if (/^https?:\/\//i.test(v) || v.startsWith("/") || /^uploads\//i.test(v)) {
      if (FLOW_MEDIA_EXT.test(v.split("?")[0]) || /\/uploads\//i.test(v)) return { url: v };
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const r = deepFindMediaUrl(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const ordered = [...keys.filter((k) => !/^buttons?$/i.test(k)), ...keys.filter((k) => /^buttons?$/i.test(k))];
    for (const k of ordered) {
      if (/^(position|style|markerEnd|_id|id)$/i.test(k)) continue;
      const r = deepFindMediaUrl(value[k], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// returns { url, kind: "image"|"video"|"audio"|"document", filename } or null
function pickFlowNodeMedia(node) {
  const d = node?.data || {};
  const strongKeys = ["mediaUrl", "media_url", "media", "mediaLink", "imageUrl", "image_url", "image", "imageLink",
    "videoUrl", "video_url", "video", "documentUrl", "document_url", "document", "fileUrl", "file_url", "file",
    "audioUrl", "audio_url", "audio", "attachment", "attachmentUrl", "headerMedia", "headerImage", "photo", "picture"];
  const weakKeys = ["url", "link", "src", "header"];

  const readUrl = (v) => {
    if (Array.isArray(v)) return readUrl(v[0]);
    if (typeof v === "string") return v.trim();
    if (v && typeof v === "object") return String(v.url || v.link || v.src || v.mediaUrl || v.path || "").trim();
    return "";
  };
  const looksLikeFile = (u) => /^https?:\/\//i.test(u) || u.startsWith("/") || /^uploads\//i.test(u);

  let url = "";
  let key = "";
  for (const k of strongKeys) {
    const u = readUrl(d[k]);
    if (u && looksLikeFile(u)) { url = u; key = k; break; }
  }
  if (!url) {
    for (const k of weakKeys) {
      const u = readUrl(d[k]);
      if (u && looksLikeFile(u) && (FLOW_MEDIA_EXT.test(u.split("?")[0]) || /\/uploads\//i.test(u))) { url = u; key = k; break; }
    }
  }
  if (!url) {
    const deep = deepFindMediaUrl(d);
    if (deep?.invalid) {
      console.warn(`⚠️ [FLOW MEDIA] Node ${node?.id} has an unusable media link (${deep.invalid}...). blob:/data: links cannot be sent - re-upload the media in the flow editor.`);
      return null;
    }
    if (deep?.url) { url = deep.url; key = "deep"; }
  }
  if (!url) return null;

  const ext = path.extname(url.split("?")[0]).toLowerCase();
  let kind = null;
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) kind = "image";
  else if ([".mp4", ".3gp", ".mov", ".mkv", ".avi"].includes(ext)) kind = "video";
  else if ([".mp3", ".ogg", ".opus", ".wav", ".m4a", ".aac"].includes(ext)) kind = "audio";
  else if ([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv"].includes(ext)) kind = "document";

  if (!kind) {
    const hint = `${d.mediaType || ""} ${d.fileType || ""} ${typeof d.type === "string" ? d.type : ""} ${key}`.toLowerCase();
    if (/video/.test(hint)) kind = "video";
    else if (/audio|voice/.test(hint)) kind = "audio";
    else if (/doc|pdf|file/.test(hint)) kind = "document";
    else kind = "image";
  }

  const rawObj = typeof d[key] === "object" && d[key] ? d[key] : {};
  return { url, kind, filename: d.fileName || d.filename || rawObj.filename || null };
}

// =========================================================================
// 🔘 VISUAL FLOW BUTTON ROUTING  (answer ONLY for the button that was clicked)
// Outgoing flow buttons carry the id  "<nodeId>::<buttonId>"  so a click can be traced
// to the exact node + button that was sent (no collisions between btn_0 of different nodes).
// =========================================================================
function normalizeFlowButton(btn, idx) {
  if (typeof btn === "string") return { id: `btn_${idx}`, text: btn };
  const b = btn || {};
  return { id: String(b.id || b.payload || `btn_${idx}`), text: String(b.text || b.title || b.label || "") };
}

function toStoredButtons(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 3).map((b, i) => {
    const nb = normalizeFlowButton(b, i);
    return { id: nb.id, title: nb.text || "Option" };
  });
}

function resolveFlowButtonClick(flow, rawPayloadId, cleanKeyword, isButtonClick) {
  const raw = String(rawPayloadId || "").trim();
  let taggedNodeId = null;
  let rawBtnId = raw;
  const sep = raw.indexOf("::");
  if (sep > 0) {
    taggedNodeId = raw.slice(0, sep);
    rawBtnId = raw.slice(sep + 2);
  }
  const wantId = rawBtnId.toLowerCase();
  const wantTitle = String(cleanKeyword || "").trim().toLowerCase();

  const candidateNodes = (flow.nodes || []).filter((n) => {
    const hasBtns = n.type === "buttonsNode" || (Array.isArray(n.data?.buttons) && n.data.buttons.length > 0);
    return hasBtns && (!taggedNodeId || String(n.id) === taggedNodeId);
  });

  let best = null;
  for (const n of candidateNodes) {
    const list = n.data?.buttons || [];
    list.forEach((btn, idx) => {
      const nb = normalizeFlowButton(btn, idx);
      const idLow = nb.id.toLowerCase();
      const idMatch = Boolean(isButtonClick && wantId && idLow === wantId);
      const genericId = /^btn_\d+$/.test(idLow);
      const titleMatch = Boolean(wantTitle && nb.text.trim().toLowerCase() === wantTitle);

      let score = 0;
      if (idMatch && (!genericId || titleMatch || taggedNodeId)) score += 2;
      if (titleMatch) score += 1;
      if (score === 0) return;
      if (taggedNodeId) score += 10;

      if (!best || score > best.score) best = { node: n, idx, id: nb.id, text: nb.text, score };
    });
  }

  if (!best) return { matched: false, targetNode: null };

  const edges = (flow.edges || []).filter((e) => e.source === best.node.id);
  const handleOf = (e) => String(e.sourceHandle || e.handle || e.data?.sourceHandle || "").toLowerCase();
  const idLow = best.id.toLowerCase();
  const idxRegex = new RegExp(`(?:btn|button|output)[-_]?(?:output[-_]?)?${best.idx}$`);

  let edge = edges.find((e) => {
    const h = handleOf(e);
    return h && (h === idLow || h === `btn_output_${idLow}` || idxRegex.test(h));
  });

  // generic (handle-less) edge only if this node has NO per-button edges at all
  if (!edge && !edges.some((e) => handleOf(e))) edge = edges[0];

  const targetNode = edge ? (flow.nodes || []).find((n) => n.id === edge.target) : null;
  console.log(`🔘 [FLOW BUTTON] node=${best.node.id} button="${best.text}" (#${best.idx}) -> target=${targetNode ? targetNode.id : "NONE (no reply sent)"}`);
  return { matched: true, targetNode: targetNode || null };
}

router.get("/", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe") {
      const WhatsAppConfig = mongoose.models.WhatsAppConfig || mongoose.model("WhatsAppConfig");
      const MetaConfig = mongoose.models.MetaConfig || WhatsAppConfig;
      
      const matchedUserConfig = await MetaConfig.findOne({ webhookVerifyToken: token });

      if (matchedUserConfig) {
        return res.status(200).send(challenge);
      } 
      else if (token === WEBHOOK_VERIFY_TOKEN_FALLBACK) {
        return res.status(200).send(challenge);
      } 
      else {
        return res.sendStatus(403);
      }
    }
  }
  return res.sendStatus(400);
});

router.post("/", async (req, res) => {
  try {
    const body = req.body;

    // ⚡ Acknowledge immediately: Meta retries (and re-sends the same button click) if we reply slowly or with 5xx.
    if (["whatsapp_business_account", "page", "instagram"].includes(body?.object)) {
      res.status(200).send("EVENT_RECEIVED");
      const _done = () => res;               // later res.send()/status() calls inside the handler become no-ops
      res.status = _done; res.send = _done; res.sendStatus = _done; res.json = _done;
    }

    if (body.object === "whatsapp_business_account") {
      if (
        body.entry &&
        body.entry[0].changes &&
        body.entry[0].changes[0].value
      ) {
        const changeValue = body.entry[0].changes[0].value;

        if (changeValue.calls && Array.isArray(changeValue.calls)) {
          const metaPhoneNumberId = changeValue.metadata?.phone_number_id;
          const WhatsAppConfigModel = mongoose.models.WhatsAppConfig || mongoose.model("WhatsAppConfig"); 
          const configRecord = await WhatsAppConfigModel.findOne({ phoneNumberId: metaPhoneNumberId });
          const { accessToken, userId } = await getActiveMetaCredentials(configRecord?.userId, "whatsapp");
          const targetUserId = userId || configRecord?.userId || "global_store_user";

          for (const callObj of changeValue.calls) {
            const callId = callObj.id;
            const callStatus = callObj.status;
            const callerPhone = callObj.from || callObj.to;
            const direction = callObj.direction || "inbound";
            const recordingMediaId = callObj.recording_id || callObj.media_id || null;

            let savedRecordingUrl = null;
            if (recordingMediaId && accessToken && (callStatus === "completed" || callStatus === "ended")) {
              try {
                savedRecordingUrl = await downloadAndSaveMetaMedia(recordingMediaId, accessToken, "audio/mp3");
              } catch (recErr) {
                console.error("❌ Failed to download call recording:", recErr.message);
              }
            }

            await CallLog.findOneAndUpdate(
              { callId: String(callId) },
              {
                $set: {
                  userId: targetUserId,
                  callId: String(callId),
                  customerPhone: formatToInternationalPhone(callerPhone),
                  direction: direction,
                  status: callStatus,
                  duration: callObj.duration || 0,
                  ...(savedRecordingUrl && { recordingUrl: savedRecordingUrl })
                }
              },
              { upsert: true, returnDocument: 'after' }
            );

            const io = req.app.get("io");
            if (io) {
              io.emit("whatsapp_incoming_call", {
                callId,
                callStatus,
                customerPhone: callerPhone,
                direction,
                recordingUrl: savedRecordingUrl
              });
            }

            if (callStatus === "offered" || callStatus === "ringing") {
              await new ChatMessage({
                userId: targetUserId,
                messageId: `call-${callId}`,
                customerPhone: formatToInternationalPhone(callerPhone),
                customerName: "WhatsApp Voice Caller",
                platform: "whatsapp",
                sender: "them",
                type: "text",
                text: "📞 Incoming WhatsApp Voice Call...",
                status: "unread"
              }).save();
            }
          }
          return res.status(200).send("CALL_EVENT_PROCESSED");
        }

        if (changeValue.statuses && Array.isArray(changeValue.statuses)) {
          for (const statusObj of changeValue.statuses) {
            const rawWamid = statusObj.id;
            const wamid = rawWamid ? rawWamid.trim() : null;
            const newStatus = statusObj.status ? statusObj.status.toLowerCase() : "sent"; 

            if (wamid) {
              const apiErrors = Array.isArray(statusObj.errors) ? statusObj.errors : [];
              const firstErr = apiErrors[0];

              const statusRank = { sent: 1, delivered: 2, read: 3 };
              const existingMsg = await ChatMessage.findOne({ messageId: wamid }).select("status").lean();
              const currentStatus = existingMsg?.status;
              let skipUpdate = false;
              if (currentStatus) {
                if (newStatus === "failed" && ["delivered", "read"].includes(currentStatus)) skipUpdate = true;
                else if (statusRank[newStatus] && statusRank[currentStatus] && statusRank[newStatus] < statusRank[currentStatus]) skipUpdate = true;
              }

              if (!skipUpdate) {
                const setFields = { status: newStatus };
                if (firstErr) {
                  setFields.failureCode = firstErr.code;
                  setFields.failureReason = [firstErr.title, firstErr.message, firstErr.error_data?.details].filter(Boolean).join(" | ");
                }
                await ChatMessage.findOneAndUpdate(
                  { messageId: wamid },
                  { $set: setFields },
                  { upsert: true, returnDocument: 'after', strict: false }
                );
              }
            }
          }
        }

        if (changeValue.messages && changeValue.messages[0]) {
          const messageData = changeValue.messages[0];

          if (await isDuplicateInbound(messageData.id)) {
            console.log(`♻️ [DUPLICATE WEBHOOK IGNORED] ${messageData.id}`);
            return res.status(200).send("DUPLICATE_EVENT_IGNORED");
          }
          const contactData = changeValue.contacts ? changeValue.contacts[0] : null;

          const customerPhone = messageData.from; 
          const customerName = (contactData && contactData.profile && contactData.profile.name) 
            ? contactData.profile.name 
            : "Unknown Customer";
          const messageType = messageData.type; 

          let extractedText = "";
          let buttonPayloadId = "";
          let mediaUrl = null;

          let referralData = null;
          if (messageData.referral) {
            const ref = messageData.referral;
            referralData = {
              sourceType: ref.source_type || "ad",
              sourceId: ref.source_id || null,
              sourceUrl: ref.source_url || null,
              headline: ref.headline || null,
              body: ref.body || null,
              mediaType: ref.media_type || null,
              imageUrl: ref.image_url || null,
              videoUrl: ref.video_url || null,
              thumbnailUrl: ref.thumbnail_url || null,
              ctwaClid: ref.ctwa_clid || null
            };
          }

          const metaPhoneNumberId = changeValue.metadata.phone_number_id;
          const WhatsAppConfig = mongoose.models.WhatsAppConfig || mongoose.model("WhatsAppConfig"); 
          const configRecord = await WhatsAppConfig.findOne({ phoneNumberId: metaPhoneNumberId });
          
          const { accessToken, userId } = await getActiveMetaCredentials(configRecord?.userId, "whatsapp");

          if (messageType === "text") {
            extractedText = messageData.text.body;
          } else if (messageType === "interactive" && messageData.interactive) {
            const interactiveType = messageData.interactive.type;
            if (interactiveType === "button_reply" && messageData.interactive.button_reply) {
              extractedText = messageData.interactive.button_reply.title || "";
              buttonPayloadId = messageData.interactive.button_reply.id || "";
            } else if (interactiveType === "list_reply" && messageData.interactive.list_reply) {
              extractedText = messageData.interactive.list_reply.title || "";
              buttonPayloadId = messageData.interactive.list_reply.id || "";
            }
          } else if (["image", "video", "document", "audio", "voice"].includes(messageType)) {
            const mediaObject = messageData[messageType];
            const mediaId = mediaObject?.id;
            const caption = mediaObject?.caption || "";
            
            extractedText = caption || (messageType === "voice" ? "🎙️ Voice Note" : `📎 Sent a ${messageType} attachment`);

            if (mediaId && accessToken) {
              mediaUrl = await downloadAndSaveMetaMedia(mediaId, accessToken, mediaObject?.mime_type || "");
            }
          }

          if (!configRecord && !userId) {
            console.log(`⚠️ [BOT SKIPPED] No WhatsApp config / user found for phone_number_id=${metaPhoneNumberId} - nothing can trigger.`);
          }
          if (configRecord || userId) {
            const targetUserId = userId || configRecord.userId;

            let dbContact = await Contact.findOne({ userId: targetUserId, phone: customerPhone });
            let currentUnread = 1;

            const finalContactName = (contactData && contactData.profile && contactData.profile.name)
              ? contactData.profile.name
              : (dbContact?.name && dbContact.name !== "Unknown Customer" ? dbContact.name : "Unknown Customer");

            if (!dbContact) {
              dbContact = await Contact.create({
                userId: targetUserId,
                adminId: configRecord?.adminId || null,
                name: finalContactName,
                phone: customerPhone,
                phoneNumber: customerPhone,
                recipientId: customerPhone,
                platform: "whatsapp",
                group: "All",
                status: "ACTIVE",
                unreadCount: 1,
                unread_count: 1
              });
            } else {
              const updateOps = { $inc: { unreadCount: 1, unread_count: 1 } };
              if (contactData && contactData.profile && contactData.profile.name) {
                updateOps.$set = { name: contactData.profile.name };
              }
              dbContact = await Contact.findOneAndUpdate(
                { _id: dbContact._id },
                updateOps,
                { returnDocument: 'after' }
              );
              currentUnread = dbContact.unreadCount || dbContact.unread_count || 1;
            }

            const cleanKeyword = extractedText ? extractedText.trim().toLowerCase() : "";
            const cleanButtonId = buttonPayloadId ? buttonPayloadId.trim().toLowerCase() : "";

            if (cleanKeyword === "stop" || cleanKeyword === "unsubscribe") {
              dbContact.status = "UNSUBSCRIBED";
              await dbContact.save();
            }

            let finalStoredText = extractedText || "[Media Attachment]";
            if (referralData && referralData.headline) {
              finalStoredText = `📢 [Ad Click: ${referralData.headline}]\n${finalStoredText}`;
            }

            if (dbContact.status === "UNSUBSCRIBED" || dbContact.status === "BLOCKED") {
              const incomingChatLog = new ChatMessage({
                userId: targetUserId,
                messageId: messageData.id ? messageData.id.trim() : `inbound-${Date.now()}`,
                customerPhone,
                customerName: dbContact?.name || finalContactName,
                platform: "whatsapp",
                sender: "them", 
                type: messageType || "text",
                text: finalStoredText,
                mediaUrl: mediaUrl, 
                referralData: referralData,
                status: "unread"
              });
              const savedMsg = await incomingChatLog.save();
              emitNewMessageNotification(req, savedMsg, currentUnread);
              return res.status(200).send("EVENT_RECEIVED_AND_BOT_BLOCKED");
            }

            let userSession = await UserSession.findOne({ phone: customerPhone });
            if (!userSession) {
              userSession = await UserSession.create({ phone: customerPhone, currentStep: "ANY" });
            }

            const lastAgentMsg = await ChatMessage.findOne({
              userId: targetUserId,
              customerPhone,
              sender: "me",
              $or: [
                { isBotMessage: false },
                { isBotMessage: { $exists: false } }
              ]
            }).sort({ createdAt: -1, timestamp: -1 });

            let isCoolingDown = false;
            if (lastAgentMsg) {
              const msgDate = lastAgentMsg.createdAt || lastAgentMsg.timestamp;
              const lastAgentTime = new Date(msgDate).getTime();
              const currentTime = Date.now();
              const minutesDifference = (currentTime - lastAgentTime) / (1000 * 60);

              const COOLDOWN_MIN = Number(process.env.BOT_AGENT_COOLDOWN_MINUTES ?? 10);
              if (COOLDOWN_MIN > 0 && minutesDifference < COOLDOWN_MIN) {
                isCoolingDown = true;
                console.log(`⏸️ [BOT PAUSED] An agent/panel message was sent ${minutesDifference.toFixed(1)} min ago to ${customerPhone} (cool-down ${COOLDOWN_MIN} min) - bot will not reply. Set BOT_AGENT_COOLDOWN_MINUTES=0 to disable.`);
              }
            }

            const existingLatestMsg = await ChatMessage.findOne({ userId: targetUserId, customerPhone }).sort({ createdAt: -1, timestamp: -1 });
            const currentAssignedContext = existingLatestMsg ? existingLatestMsg.assignedTo : null;

            const incomingChatLog = new ChatMessage({
              userId: targetUserId,
              messageId: messageData.id ? messageData.id.trim() : `inbound-${Date.now()}`,
              customerPhone,
              customerName: dbContact?.name || finalContactName,
              platform: "whatsapp",
              sender: "them", 
              type: messageType || "text",
              text: finalStoredText,
              mediaUrl: mediaUrl, 
              referralData: referralData,
              assignedTo: currentAssignedContext,
              ...(buttonPayloadId ? { buttonReply: { id: String(buttonPayloadId).split("::").pop(), title: extractedText } } : {}),
              status: "unread"
            });

            const savedIncomingLog = await incomingChatLog.save();
            emitNewMessageNotification(req, savedIncomingLog, currentUnread);

            if (isCoolingDown) {
              return res.status(200).send("EVENT_RECEIVED");
            }

            const RESET_KEYWORDS = ["menu", "hi", "hello", "start", "reset"];
            if (RESET_KEYWORDS.includes(cleanKeyword)) {
              userSession.currentStep = "ANY";
              await userSession.save();
            }

            if (cleanKeyword || cleanButtonId) {
              const settings = await AiBotSettings.findOne({ userId: targetUserId });
              const defaultHandoverKeywords = ["human", "agent", "representative", "support", "talk to human", "person", "admin"];
              
              let configuredHandoverKeywords = [...defaultHandoverKeywords];
              if (settings?.advanced?.handoverKeyword) {
                const customKw = settings.advanced.handoverKeyword.split(",").map(k => k.trim().toLowerCase());
                configuredHandoverKeywords = [...configuredHandoverKeywords, ...customKw];
              }

              const isHandoverTriggered = configuredHandoverKeywords.some(kw => kw && cleanKeyword.includes(kw));

              if (isHandoverTriggered || currentAssignedContext === "human" || dbContact.status === "ASSIGNED") {
                console.log(`🙋 [BOT HANDED TO HUMAN] ${customerPhone} | keyword="${cleanKeyword}" | keywordHit=${isHandoverTriggered} | assignedTo=${currentAssignedContext} | contactStatus=${dbContact.status}`);
                await Contact.findOneAndUpdate(
                  { _id: dbContact._id },
                  { $set: { assignedTo: "human", status: "PENDING_AGENT" } }
                );

                await ChatMessage.findOneAndUpdate(
                  { messageId: savedIncomingLog.messageId },
                  { $set: { assignedTo: "human" } }
                );

                return res.status(200).send("EVENT_RECEIVED_HANDED_OVER_TO_HUMAN");
              }

              let flowTriggered = false;
              let buttonClickHandled = false;
              const isButtonClick = Boolean(buttonPayloadId);

              const activeFlows = await BotFlow.find({ userId: targetUserId, isActive: true });
              console.log(`🤖 [BOT] input="${cleanKeyword}" buttonId="${buttonPayloadId}" session=${userSession.currentStep} activeFlows=${activeFlows.length}`);

              for (const flow of activeFlows) {
                if (!flow.nodes || flow.nodes.length === 0) continue;
                if (buttonClickHandled) break;

                let matchedNode = null;
                let targetNode = null;

                const sessionLevel = (userSession.currentStep || "ANY").toUpperCase();

                matchedNode = isButtonClick ? null : flow.nodes.find((n) => {
                  const nodeLevel = (n.data?.level || "ANY").toUpperCase();
                  if (nodeLevel !== "ANY" && nodeLevel !== sessionLevel) return false;

                  const triggerText = (
                    n.data?.keyword || 
                    n.data?.trigger || 
                    n.data?.label || 
                    n.data?.text || 
                    ""
                  ).trim().toLowerCase();

                  if (!triggerText) return false;

                  const keywordsArray = triggerText.split(",").map(k => k.trim());
                  return keywordsArray.some(kw => kw && cleanKeyword === kw);
                });

                if (matchedNode) {
                  const outgoingEdge = flow.edges?.find((e) => e.source === matchedNode.id);
                  targetNode = outgoingEdge ? flow.nodes.find((n) => n.id === outgoingEdge.target) : matchedNode;
                } else {
                  const btnRes = resolveFlowButtonClick(flow, buttonPayloadId, cleanKeyword, isButtonClick);
                  if (btnRes.matched) {
                    buttonClickHandled = true;
                    targetNode = btnRes.targetNode;
                  }
                }

                if (targetNode) {
                  const nodeData = targetNode.data || {};
                  const nodeMedia = pickFlowNodeMedia(targetNode);
                  const nodeText = pickFlowNodeText(nodeData);
                  console.log(`🎯 [FLOW NODE] id=${targetNode.id} type=${targetNode.type} media=${nodeMedia ? `${nodeMedia.kind}:${nodeMedia.url}` : "none"} text="${nodeText.substring(0, 40)}" dataKeys=[${Object.keys(nodeData).join(",")}]`);
                  try { console.log(`🧾 [FLOW NODE DATA] ${JSON.stringify(nodeData).substring(0, 900)}`); } catch (e) {}

                  let flowPayload = {};
                  let fallbackPayload = null;   // same reply WITHOUT media, used if Meta rejects the media
                  let savedType = "text";

                  const hasButtons = Array.isArray(nodeData.buttons) && nodeData.buttons.length > 0;

                  // resolve media reference (upload to Meta first, link as fallback)
                  let mediaRef = null;
                  let cleanMediaUrl = "";
                  if (nodeMedia) {
                    cleanMediaUrl = normalizePublicMediaLink(nodeMedia.url);
                    let mediaId = null;
                    try { mediaId = await uploadMediaToMeta(metaPhoneNumberId, accessToken, cleanMediaUrl); } catch (upErr) { console.warn("⚠️ Flow media upload warning:", upErr.message); }
                    mediaRef = mediaId ? { id: mediaId } : { link: cleanMediaUrl };
                  }

                  if (hasButtons) {
                    const seenTitles = new Set();
                    const formattedButtons = nodeData.buttons.filter((btn) => {
                      const t = String(typeof btn === "string" ? btn : (btn?.text || btn?.title || "")).trim().toLowerCase();
                      const bt = String((btn && typeof btn === "object" && btn.type) || "quick_reply").toLowerCase();
                      if (["url", "cta_url", "phone", "phone_number"].includes(bt) || !t) return true;
                      if (seenTitles.has(t)) return false;
                      seenTitles.add(t);
                      return true;
                    }).slice(0, 3).map((btn, index) => {
                      const bType = String((btn && typeof btn === "object" && btn.type) || "quick_reply").toLowerCase();
                      const bText = (typeof btn === "string" ? btn : (btn.text || btn.title || "Option")).substring(0, 20);
                      const bId = (typeof btn === "object" && btn.id) ? btn.id : `btn_${index}`;

                      if (bType === "url" || bType === "cta_url") {
                        return { type: "cta_url", cta_url: { display_text: bText, url: (typeof btn === "object" && (btn.url || btn.payload)) || "https://wa.me" } };
                      } else if (bType === "phone" || bType === "phone_number") {
                        return { type: "phone_number", phone_number: (typeof btn === "object" && (btn.phone || btn.payload)) || "", title: bText };
                      }
                      return { type: "reply", reply: { id: `${targetNode.id}::${bId}`, title: bText } };
                    });

                    const buildInteractive = (headerObj) => ({
                      type: "interactive",
                      interactive: {
                        type: "button",
                        ...(headerObj && { header: headerObj }),
                        body: { text: nodeText || "Please choose an option:" },
                        ...(nodeData.footerText && { footer: { text: nodeData.footerText } }),
                        action: { buttons: formattedButtons }
                      }
                    });

                    let headerObj = null;
                    if (nodeMedia && mediaRef && nodeMedia.kind !== "audio") {
                      headerObj = {
                        type: nodeMedia.kind,
                        [nodeMedia.kind]: nodeMedia.kind === "document"
                          ? { ...mediaRef, filename: nodeMedia.filename || path.basename(cleanMediaUrl.split("?")[0]) || "file" }
                          : mediaRef
                      };
                    }
                    flowPayload = buildInteractive(headerObj);
                    if (headerObj) fallbackPayload = buildInteractive(null);
                    savedType = "interactive";
                  } else if (nodeMedia && mediaRef) {
                    // media node WITHOUT buttons => plain media message (+ caption)
                    const mediaBody = nodeMedia.kind === "document"
                      ? { ...mediaRef, ...(nodeText && { caption: nodeText }), filename: nodeMedia.filename || path.basename(cleanMediaUrl.split("?")[0]) || "file" }
                      : nodeMedia.kind === "audio"
                        ? { ...mediaRef }
                        : { ...mediaRef, ...(nodeText && { caption: nodeText }) };
                    flowPayload = { type: nodeMedia.kind, [nodeMedia.kind]: mediaBody };
                    fallbackPayload = { type: "text", text: { body: nodeText || cleanMediaUrl } };
                    savedType = nodeMedia.kind;
                  } else {
                    flowPayload = { type: "text", text: { body: nodeText || pickFlowNodeText(nodeData, true) || "Hello!" } };
                  }

                  if (flowPayload && Object.keys(flowPayload).length > 0) {
                    const plainFallbackText = nodeText || nodeData.message || nodeData.text;
                    let metaResponse = await sendUniversalWhatsAppMessage(targetUserId, metaPhoneNumberId, accessToken, customerPhone, flowPayload, plainFallbackText);

                    if (!metaResponse && fallbackPayload) {
                      console.warn("⚠️ [FLOW NODE] Media rejected by Meta - sending the reply without media.");
                      metaResponse = await sendUniversalWhatsAppMessage(targetUserId, metaPhoneNumberId, accessToken, customerPhone, fallbackPayload, plainFallbackText);
                    }

                    // media-only audio has no caption: send the text as a follow-up
                    if (metaResponse && nodeMedia?.kind === "audio" && !hasButtons && nodeText) {
                      await sendUniversalWhatsAppMessage(targetUserId, metaPhoneNumberId, accessToken, customerPhone, { type: "text", text: { body: nodeText } }, nodeText);
                    }

                    if (metaResponse) {
                      flowTriggered = true;
                      const rawWamid = metaResponse.messages?.[0]?.id;
                      const botWamid = rawWamid ? rawWamid.trim() : `flow-${Date.now()}`;

                      const nextLevel = nodeData.nextLevel || nodeData.level || "ANY";
                      userSession.currentStep = nextLevel;
                      await userSession.save();

                      await new ChatMessage({
                        userId: targetUserId,
                        messageId: botWamid,
                        customerPhone,
                        customerName: dbContact?.name || finalContactName,
                        platform: "whatsapp",
                        sender: "me",
                        isBotMessage: true,
                        type: savedType,
                        text: nodeText || "[Visual Flow Triggered]",
                        origin: "auto_reply",
                        buttons: toStoredButtons(nodeData.buttons),
                        mediaUrl: nodeMedia ? nodeMedia.url : null,
                        assignedTo: currentAssignedContext,
                        status: "sent"
                      }).save();

                      break; 
                    }
                  }
                }
              }

              if (!flowTriggered && !buttonClickHandled) {
                const sessionLevel = (userSession.currentStep || "ANY").toUpperCase();
                
                const allUserBotReplies = await BotReply.find({ userId: targetUserId, isActive: true });

                let matchedRule = allUserBotReplies.find(rule => {
                  const ruleLevel = (rule.level || "ANY").toUpperCase();
                  if (ruleLevel !== "ANY" && ruleLevel !== sessionLevel) return false;
                  
                  return checkRuleMatch(rule, cleanKeyword);
                });

                if (!matchedRule) {
                  const globalBotReplies = await BotReply.find({
                    $or: [{ userId: {$exists: false } }, { userId: null }],
                    isActive: true
                  });
                  
                  matchedRule = globalBotReplies.find(rule => {
                    const ruleLevel = (rule.level || "ANY").toUpperCase();
                    if (ruleLevel !== "ANY" && ruleLevel !== sessionLevel) return false;
                    
                    return checkRuleMatch(rule, cleanKeyword);
                  });
                }

                if (matchedRule) {
                  let botPayload = {};
                  let templateObj = null;
                  let templateFallbackPayload = null;

                  const lookupIdentifier = String(matchedRule.templateId || matchedRule.replyText || "").trim();
                  if (matchedRule.botType === "template" && lookupIdentifier) {
                    try {
                      const lookupOr = [
                        { name: lookupIdentifier },
                        { title: lookupIdentifier }
                      ];
                      if (mongoose.Types.ObjectId.isValid(lookupIdentifier)) lookupOr.push({ _id: lookupIdentifier });
                      templateObj = await Template.findOne({ userId: targetUserId, $or: lookupOr }).lean();
                    } catch (tErr) {}
                  }

                  if (matchedRule.botType === "template" && (templateObj || matchedRule.templateId)) {
                    const templateName = templateObj?.name || templateObj?.title || matchedRule.templateId;
                    let langCode = templateObj?.language || "en_US";
                    
                    let components = [];

                    const hdr = await resolveTemplateHeader(targetUserId, templateObj, templateName, matchedRule, metaPhoneNumberId, accessToken);
                    if (!templateObj?.language && hdr.meta?.language) langCode = hdr.meta.language;
                    templateFallbackPayload = buildTemplateFallbackPayload(hdr, templateObj, matchedRule);

                    const headerNeedsMedia = TEMPLATE_MEDIA_FORMATS.includes(hdr.format);

                    if (headerNeedsMedia && (hdr.mediaId || hdr.link)) {
                      const mt = hdr.format.toLowerCase();
                      const ref = hdr.mediaId ? { id: hdr.mediaId } : { link: hdr.link };
                      components.push({
                        type: "header",
                        parameters: [
                          mt === "document"
                            ? { type: "document", document: { ...ref, filename: path.basename((hdr.link || "file").split("?")[0]) || "file" } }
                            : { type: mt, [mt]: ref }
                        ]
                      });
                    }

                    if (headerNeedsMedia && !hdr.mediaId && !hdr.link) {
                      botPayload = templateFallbackPayload;
                    } else {
                      botPayload = {
                        type: "template",
                        template: {
                          name: templateName,
                          language: { code: langCode },
                          ...(components.length > 0 && { components })
                        }
                      };
                    }
                  } 
                  else if (matchedRule.botType === "interactive" || (matchedRule.buttons && matchedRule.buttons.length > 0) || matchedRule.mediaUrl) {
                    const formattedButtons = (matchedRule.buttons || []).slice(0, 3).map((btn, index) => {
                      if (typeof btn === "string") btn = { text: btn };
                      const bType = String(btn.type || "quick_reply").toLowerCase();
                      
                      if (bType === "url" || bType === "cta_url") {
                        return {
                          type: "cta_url",
                          cta_url: {
                            display_text: (btn.text || btn.title || "Visit Link").substring(0, 20),
                            url: btn.url || btn.payload || "https://wa.me"
                          }
                        };
                      } 
                      else if (bType === "phone" || bType === "phone_number") {
                        return {
                          type: "phone_number",
                          phone_number: btn.phone || btn.payload || "",
                          title: (btn.text || btn.title || "Call Us").substring(0, 20)
                        };
                      } 
                      else {
                        return {
                          type: "reply",
                          reply: {
                            id: btn.payload || `btn_${index}`,
                            title: (btn.text || btn.title || "Option").substring(0, 20)
                          }
                        };
                      }
                    });

                    let headerObj = null;
                    if (matchedRule.mediaUrl) {
                      const cleanMediaUrl = normalizePublicMediaLink(matchedRule.mediaUrl);
                      const mediaId = await uploadMediaToMeta(metaPhoneNumberId, accessToken, cleanMediaUrl);
                      const ext = path.extname(cleanMediaUrl.split("?")[0]).toLowerCase();
                      let headerType = "image";
                      if ([".mp4", ".3gp", ".mov", ".mkv"].includes(ext)) headerType = "video";
                      else if ([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt"].includes(ext)) headerType = "document";

                      const mediaRef = mediaId ? { id: mediaId } : { link: cleanMediaUrl };
                      headerObj = {
                        type: headerType,
                        [headerType]: headerType === "document" ? { ...mediaRef, filename: path.basename(cleanMediaUrl.split("?")[0]) || "file" } : mediaRef
                      };
                    }

                    const finalButtons = formattedButtons.length > 0 ? formattedButtons : [
                      { type: "reply", reply: { id: "rule_btn", title: "View Options" } }
                    ];

                    botPayload = {
                      type: "interactive",
                      interactive: {
                        type: "button",
                        ...(headerObj && { header: headerObj }),
                        body: { text: matchedRule.replyText || "Please choose an option:" },
                        ...(matchedRule.footerText && { footer: { text: matchedRule.footerText } }),
                        action: { buttons: finalButtons }
                      }
                    };
                  }
                  else {
                    botPayload = { type: "text", text: { body: matchedRule.replyText || "Hello!" } };
                  }

                  if (botPayload && Object.keys(botPayload).length > 0) {
                    let metaResponse = await sendUniversalWhatsAppMessage(targetUserId, metaPhoneNumberId, accessToken, customerPhone, botPayload, matchedRule.replyText);

                    if (!metaResponse && botPayload.type === "template" && templateFallbackPayload) {
                      botPayload = templateFallbackPayload;
                      metaResponse = await sendUniversalWhatsAppMessage(targetUserId, metaPhoneNumberId, accessToken, customerPhone, botPayload, matchedRule.replyText);
                    }
                    
                    if (metaResponse) {
                      flowTriggered = true;
                      const rawBotWamid = metaResponse.messages?.[0]?.id;
                      const botWamid = rawBotWamid ? rawBotWamid.trim() : `bot-${Date.now()}`;

                      userSession.currentStep = matchedRule.nextLevel || "ANY";
                      await userSession.save();

                      await new ChatMessage({
                        userId: targetUserId,
                        messageId: botWamid,
                        customerPhone,
                        customerName: dbContact?.name || finalContactName,
                        platform: "whatsapp",
                        sender: "me", 
                        isBotMessage: true,
                        type: botPayload.type || "text",
                        text: matchedRule.botType === "template" ? `[Template Triggered: ${matchedRule.templateId}]` : (matchedRule.replyText || `[Sent ${matchedRule.botType} Bot Reply]`),
                        mediaUrl: matchedRule.mediaUrl || null,
                        origin: "auto_reply",
                        buttons: toStoredButtons(matchedRule.buttons),
                        assignedTo: currentAssignedContext,
                        status: "sent"
                      }).save();
                    }
                  }
                }
              }

              if (!flowTriggered && !buttonClickHandled) {
                let replyText = null;

                const isSubscribed = await verifyUserAiSubscription(targetUserId);

                console.log(`ℹ️ [BOT] no visual-flow / rule reply sent for "${cleanKeyword}" - trying AI / manual functions.`);
                let replyOrigin = "auto_reply";
                if (isSubscribed) {
                  replyText = await processAiBotResponse(targetUserId, customerPhone, extractedText);
                  if (replyText) replyOrigin = "ai_reply";
                }

                if (!replyText) {
                  replyText = await handleManualFunctionExecution(targetUserId, customerPhone, cleanKeyword, userSession);
                }

                if (replyText) {
                  const replyPayload = {
                    type: "text",
                    text: { body: replyText }
                  };

                  const metaResponse = await sendUniversalWhatsAppMessage(targetUserId, metaPhoneNumberId, accessToken, customerPhone, replyPayload, replyText);

                  if (metaResponse) {
                    const rawWamid = metaResponse.messages?.[0]?.id;
                    const wamid = rawWamid ? rawWamid.trim() : `bot-reply-${Date.now()}`;

                    await new ChatMessage({
                      userId: targetUserId,
                      messageId: wamid,
                      customerPhone,
                      customerName: dbContact?.name || finalContactName,
                      platform: "whatsapp",
                      sender: "me",
                      isBotMessage: true,
                      type: "text",
                      text: replyText,
                      origin: replyOrigin,
                      assignedTo: currentAssignedContext,
                      status: "sent"
                    }).save();
                  }
                }
              }

            }
          }
        }
      }
      return res.status(200).send("EVENT_RECEIVED");
    } 

    else if (body.object === "page" || body.object === "instagram") {
      const isInstagram = body.object === "instagram";
      const channelPlatform = isInstagram ? "instagram" : "messenger";

      if (body.entry && Array.isArray(body.entry)) {
        for (const entryObj of body.entry) {
          const pageOrIgId = entryObj.id;
          const messagingEvents = entryObj.messaging || [];

          for (const event of messagingEvents) {
            const dedupeId = event.message?.mid || (event.postback ? `pb-${event.sender?.id}-${event.timestamp}-${event.postback.payload || ""}` : null);
            if (dedupeId && await isDuplicateInbound(dedupeId)) {
              console.log(`♻️ [DUPLICATE WEBHOOK IGNORED] ${dedupeId}`);
              continue;
            }
            if ((event.message && !event.message.is_echo) || event.postback) {
              const senderId = event.sender?.id;
              const messageId = event.message?.mid || `${channelPlatform}-${Date.now()}`;
              
              let incomingText = event.message?.text || "";
              let buttonPayloadId = event.postback?.payload || event.message?.quick_reply?.payload || "";

              if (!incomingText && event.postback) {
                incomingText = event.postback.title || event.postback.payload || "";
              }
              
              const MetaConfig = mongoose.models.MetaConfig || mongoose.models.WhatsAppConfig;
              const configRecord = await MetaConfig.findOne({ 
                $or: [
                  { pageId: pageOrIgId },
                  { instagramAccountId: pageOrIgId }
                ] 
              }) || await MetaConfig.findOne();

              const { accessToken, appSecret, userId } = await getActiveMetaCredentials(configRecord?.userId, channelPlatform);

              let mediaUrl = null;

              if (event.message?.attachments && event.message.attachments[0]) {
                const attach = event.message.attachments[0];
                const rawUrl = attach.payload?.url || null;
                const rawId = attach.payload?.id || attach.payload?.media_id || null;

                if (rawUrl) {
                  mediaUrl = rawUrl;
                } else if (rawId && accessToken) {
                  mediaUrl = await downloadAndSaveMetaMedia(rawId, accessToken);
                }
              }

              if (senderId && accessToken) {
                const targetUserId = userId || configRecord?.userId;
                const targetAdminId = configRecord?.adminId || targetUserId;

                const targetGroup = channelPlatform === "instagram" ? "Instagram Leads" : "Messenger Leads";

                const Group = mongoose.models.Group || require("../models/Group");
                if (Group) {
                  await Group.findOneAndUpdate(
                    { name: targetGroup, userId: targetUserId },
                    { name: targetGroup, userId: targetUserId, adminId: targetAdminId },
                    { upsert: true, returnDocument: 'after' }
                  );
                }

                let fetchedName = `${channelPlatform.toUpperCase()} User (${senderId.slice(-4)})`;
                try {
                  const graphRes = await axios.get(`https://graph.facebook.com/v20.0/${senderId}`, {
                    params: {
                      fields: isInstagram ? "name,username" : "first_name,last_name,name",
                      access_token: accessToken
                    }
                  });
                  if (graphRes.data) {
                    fetchedName = graphRes.data.name || 
                      (graphRes.data.first_name ? `${graphRes.data.first_name} ${graphRes.data.last_name || ''}`.trim() : null) || 
                      graphRes.data.username || 
                      fetchedName;
                  }
                } catch (profileErr) {}

                let dbContact = await Contact.findOne({ 
                  userId: targetUserId, 
                  $or: [
                    { phone: senderId },
                    { recipientId: senderId },
                    { facebookId: senderId },
                    { instagramId: senderId }
                  ] 
                });

                let currentUnread = 1;

                if (!dbContact) {
                  dbContact = await Contact.create({
                    userId: targetUserId,
                    adminId: targetAdminId,
                    name: fetchedName,
                    phone: senderId,
                    recipientId: senderId,
                    facebookId: channelPlatform === "messenger" ? senderId : null,
                    instagramId: channelPlatform === "instagram" ? senderId : null,
                    platform: channelPlatform,
                    group: targetGroup,
                    status: "ACTIVE",
                    unreadCount: 1,
                    unread_count: 1
                  });
                } else {
                  let updateFields = { $inc: { unreadCount: 1, unread_count: 1 } };
                  if (dbContact.name.includes("User (") && fetchedName !== dbContact.name) {
                    updateFields.$set = { name: fetchedName };
                  }
                  dbContact = await Contact.findOneAndUpdate({ _id: dbContact._id }, updateFields, { returnDocument: 'after' });
                  currentUnread = dbContact.unreadCount || dbContact.unread_count || 1;
                }

                const savedIgMsg = await new ChatMessage({
                  userId: targetUserId,
                  messageId,
                  customerPhone: senderId,
                  customerName: dbContact?.name || fetchedName,
                  platform: channelPlatform,
                  sender: "them",
                  type: mediaUrl ? "image" : "text",
                  text: incomingText || (mediaUrl ? "[Attachment Received]" : ""),
                  mediaUrl: mediaUrl,
                  status: "unread"
                }).save();

                emitNewMessageNotification(req, savedIgMsg, currentUnread);

                const cleanKeyword = incomingText ? incomingText.trim().toLowerCase() : "";
                const cleanButtonId = buttonPayloadId ? buttonPayloadId.trim().toLowerCase() : "";
                
                let userSession = await UserSession.findOne({ phone: senderId });
                if (!userSession) {
                  userSession = await UserSession.create({ phone: senderId, currentStep: "ANY" });
                }

                const RESET_KEYWORDS = ["menu", "hi", "hello", "start", "reset"];
                if (RESET_KEYWORDS.includes(cleanKeyword)) {
                  userSession.currentStep = "ANY";
                  await userSession.save();
                }

                if (cleanKeyword || cleanButtonId) {
                  let flowTriggered = false;
              let buttonClickHandled = false;
              const isButtonClick = Boolean(buttonPayloadId);

                  const activeFlows = await BotFlow.find({ userId: targetUserId, isActive: true });
              console.log(`🤖 [BOT] input="${cleanKeyword}" buttonId="${buttonPayloadId}" session=${userSession.currentStep} activeFlows=${activeFlows.length}`);
                  for (const flow of activeFlows) {
                    if (!flow.nodes || flow.nodes.length === 0) continue;
                if (buttonClickHandled) break;

                    let matchedNode = null;
                    let targetNode = null;
                    const sessionLevel = (userSession.currentStep || "ANY").toUpperCase();

                    matchedNode = isButtonClick ? null : flow.nodes.find((n) => {
                      const nodeLevel = (n.data?.level || "ANY").toUpperCase();
                      if (nodeLevel !== "ANY" && nodeLevel !== sessionLevel) return false;

                      const triggerText = (n.data?.keyword || n.data?.trigger || n.data?.label || n.data?.text || "").trim().toLowerCase();
                      if (!triggerText) return false;

                      return triggerText.split(",").map(k => k.trim()).some(kw => kw && cleanKeyword === kw);
                    });

                    if (matchedNode) {
                      const outgoingEdge = flow.edges?.find((e) => e.source === matchedNode.id);
                      targetNode = outgoingEdge ? flow.nodes.find((n) => n.id === outgoingEdge.target) : matchedNode;
                    } else {
                      const btnRes = resolveFlowButtonClick(flow, buttonPayloadId, cleanKeyword, isButtonClick);
                      if (btnRes.matched) {
                        buttonClickHandled = true;
                        targetNode = btnRes.targetNode;
                      }
                    }

                    if (targetNode) {
                      const nodeData = targetNode.data || {};
                      const replyText = pickFlowNodeText(nodeData) || pickFlowNodeText(nodeData, true) || "Hello!";
                      const buttonsList = nodeData.buttons || [];
                      const flowNodeMedia = pickFlowNodeMedia(targetNode);
                      const flowMediaUrl = flowNodeMedia ? flowNodeMedia.url : null;
                      console.log(`🎯 [FLOW NODE] id=${targetNode.id} type=${targetNode.type} media=${flowMediaUrl || "none"} dataKeys=[${Object.keys(nodeData).join(",")}]`);
                      try { console.log(`🧾 [FLOW NODE DATA] ${JSON.stringify(nodeData).substring(0, 900)}`); } catch (e) {}

                      const flowButtonsTagged = buttonsList.map((b, i) => {
                        if (b && typeof b === "object" && ["url", "cta_url", "phone", "phone_number"].includes(String(b.type || "").toLowerCase())) return b;
                        const base = typeof b === "string" ? { text: b } : { ...b };
                        const tagged = `${targetNode.id}::${base.id || base.payload || `btn_${i}`}`;
                        return { ...base, id: tagged, payload: tagged };
                      });
                      const dmPayload = buildMetaDirectPayload(channelPlatform, replyText, flowButtonsTagged, flowMediaUrl);
                      const dmResponse = await sendMetaDirectMessage(channelPlatform, pageOrIgId, senderId, accessToken, appSecret, dmPayload);

                      if (dmResponse) {
                        flowTriggered = true;
                        userSession.currentStep = nodeData.nextLevel || nodeData.level || "ANY";
                        await userSession.save();

                        await new ChatMessage({
                          userId: targetUserId,
                          messageId: dmResponse.message_id || `flow-${Date.now()}`,
                          customerPhone: senderId,
                          customerName: dbContact?.name || fetchedName,
                          platform: channelPlatform,
                          sender: "me",
                          isBotMessage: true,
                          type: flowMediaUrl ? "image" : (buttonsList.length > 0 ? "interactive" : "text"),
                          text: replyText,
                          origin: "auto_reply",
                          buttons: toStoredButtons(buttonsList),
                          mediaUrl: flowMediaUrl,
                          status: "sent"
                        }).save();

                        break;
                      }
                    }
                  }

                  if (!flowTriggered && !buttonClickHandled) {
                    const sessionLevel = (userSession.currentStep || "ANY").toUpperCase();
                    const allUserBotReplies = await BotReply.find({ userId: targetUserId, isActive: true });

                    let matchedRule = allUserBotReplies.find(rule => {
                      const ruleLevel = (rule.level || "ANY").toUpperCase();
                      if (ruleLevel !== "ANY" && ruleLevel !== sessionLevel) return false;
                      
                      return checkRuleMatch(rule, cleanKeyword);
                    });

                    if (!matchedRule) {
                      const globalBotReplies = await BotReply.find({
                        $or: [{ userId: {$exists: false } }, { userId: null }],
                        isActive: true
                      });
                      
                      matchedRule = globalBotReplies.find(rule => {
                        const ruleLevel = (rule.level || "ANY").toUpperCase();
                        if (ruleLevel !== "ANY" && ruleLevel !== sessionLevel) return false;
                        
                        return checkRuleMatch(rule, cleanKeyword);
                      });
                    }

                    if (matchedRule) {
                      let templateObj = null;
                      const lookupIdentifier = String(matchedRule.templateId || matchedRule.replyText || "").trim();
                      
                      if (matchedRule.botType === "template" && lookupIdentifier) {
                        try {
                          const lookupOr = [
                            { name: lookupIdentifier },
                            { title: lookupIdentifier }
                          ];
                          if (mongoose.Types.ObjectId.isValid(lookupIdentifier)) lookupOr.push({ _id: lookupIdentifier });
                          templateObj = await Template.findOne({ userId: targetUserId, $or: lookupOr }).lean();
                        } catch (tErr) {}
                      }

                      const replyText = matchedRule.replyText || templateObj?.content || templateObj?.description || "Hello!";
                      const buttonsList = matchedRule.buttons || [];
                      const ruleMediaUrl = matchedRule.mediaUrl || templateObj?.mediaUrl || null;

                      const dmPayload = buildMetaDirectPayload(channelPlatform, replyText, buttonsList, ruleMediaUrl, templateObj);
                      const dmResponse = await sendMetaDirectMessage(channelPlatform, pageOrIgId, senderId, accessToken, appSecret, dmPayload);

                      if (dmResponse) {
                        flowTriggered = true;
                        userSession.currentStep = matchedRule.nextLevel || "ANY";
                        await userSession.save();

                        await new ChatMessage({
                          userId: targetUserId,
                          messageId: dmResponse.message_id || `bot-${Date.now()}`,
                          customerPhone: senderId,
                          customerName: dbContact?.name || fetchedName,
                          platform: channelPlatform,
                          sender: "me",
                          isBotMessage: true,
                          type: templateObj ? "template" : (ruleMediaUrl ? "image" : (buttonsList.length > 0 ? "interactive" : "text")),
                          text: matchedRule.botType === "template" ? `[Template Card Sent: ${matchedRule.templateId}]` : replyText,
                          mediaUrl: ruleMediaUrl,
                          origin: "auto_reply",
                          buttons: toStoredButtons(buttonsList),
                          status: "sent"
                        }).save();
                      }
                    }
                  }

                  if (!flowTriggered && !buttonClickHandled) {
                    let finalReplyText = null;
                    const isSubscribed = await verifyUserAiSubscription(targetUserId);

                    let replyOrigin = "auto_reply";
                    if (isSubscribed) {
                      finalReplyText = await processAiBotResponse(targetUserId, senderId, incomingText);
                      if (finalReplyText) replyOrigin = "ai_reply";
                    }

                    if (!finalReplyText) {
                      finalReplyText = await handleManualFunctionExecution(targetUserId, senderId, cleanKeyword, userSession);
                    }

                    if (finalReplyText) {
                      const dmPayload = buildMetaDirectPayload(channelPlatform, finalReplyText);
                      const dmResponse = await sendMetaDirectMessage(channelPlatform, pageOrIgId, senderId, accessToken, appSecret, dmPayload);

                      if (dmResponse) {
                        await new ChatMessage({
                          userId: targetUserId,
                          messageId: dmResponse.message_id || `reply-${Date.now()}`,
                          customerPhone: senderId,
                          customerName: dbContact?.name || fetchedName,
                          platform: channelPlatform,
                          sender: "me",
                          isBotMessage: true,
                          type: "text",
                          text: finalReplyText,
                          origin: replyOrigin,
                          status: "sent"
                        }).save();
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      return res.status(200).send("EVENT_RECEIVED");
    }

    else {
      return res.sendStatus(404);
    }
  } catch (err) {
    console.error("❌ WEBHOOK CORE CRASH:", err.message);
    // 200 (not 500): a 5xx makes Meta re-deliver the same event again and again
    return res.status(200).send("EVENT_RECEIVED_WITH_ERROR");
  }
});

router.post("/send", upload.single("file"), async (req, res) => {
  try {
    const { to, message, customerName, isCallLog, userId, platform = "whatsapp" } = req.body;
    let finalMediaUrl = null;
    let audioBufferForQr = null;

    if (req.file) {
      finalMediaUrl = `${PUBLIC_BASE_URL}/uploads/${req.file.filename}`;
    }

    let outputText = message;
    if (isCallLog === "true") {
      outputText = `📞 Outbound Call Triggered / Logged`;
    }

    const channelInfo = await getActiveWhatsAppChannel(userId);

    // 🎙️ Check if uploaded file is audio / voice note and convert using FFmpeg
    const isAudioFile = req.file && (
      req.file.mimetype.includes("audio") || 
      req.file.mimetype.includes("octet-stream") || 
      [".webm", ".ogg", ".mp3", ".wav", ".m4a", ".opus", ".aac"].includes(path.extname(req.file.originalname).toLowerCase())
    );

    if (isAudioFile) {
      try {
        console.log("🎙️ Converting outbound audio to WhatsApp OGG Opus format via FFmpeg...");
        let originalPath = req.file.path;
        const ext = path.extname(req.file.originalname).toLowerCase();
        
        const targetFilename = req.file.filename.replace(ext, "") + "-" + Date.now() + ".ogg";
        const targetOggPath = path.join("uploads/", targetFilename);
        
        await new Promise((resolve, reject) => {
          ffmpeg(originalPath)
            .noVideo()
            .audioCodec("libopus")
            .audioChannels(1)       
            .audioFrequency(16000)  
            .audioBitrate("24k")    
            .outputOptions(["-map_metadata -1"])
            .toFormat("ogg")
            .on("end", () => {
              if (fs.existsSync(originalPath) && originalPath !== targetOggPath) {
                try { fs.unlinkSync(originalPath); } catch (e) {}
              }
              req.file.path = targetOggPath;
              req.file.filename = targetFilename;
              req.file.mimetype = "audio/ogg";
              resolve();
            })
            .on("error", (err) => {
              reject(err);
            })
            .save(targetOggPath);
        });

        finalMediaUrl = `${PUBLIC_BASE_URL}/uploads/${req.file.filename}`;
        audioBufferForQr = fs.readFileSync(req.file.path);
      } catch (convErr) {
        console.error("❌ Audio FFmpeg conversion failed:", convErr.message);
        // Never send the un-converted browser file as a voice note
        return res.status(500).json({ success: false, error: "Voice note convert nahi ho saka (ffmpeg / libopus check karein)." });
      }
    }

    if (platform === "whatsapp" && channelInfo.platformType === "QR") {
      // Agar aap QR / Baileys use kar rahe hain
      const { getActiveSocket, startWhatsAppSession } = require("../routes/whatsappBaileysService");
      let sock = getActiveSocket(userId);

      if (!sock && userId) {
        try {
          await startWhatsAppSession(userId);
          await new Promise((r) => setTimeout(r, 2500));
          sock = getActiveSocket(userId);
        } catch (e) {}
      }

      if (sock) {
        let cleanPhone = String(to || "").replace(/\D/g, "");
        if (cleanPhone.startsWith("03") && cleanPhone.length === 11) {
          cleanPhone = "92" + cleanPhone.substring(1);
        }
        let targetJid = `${cleanPhone}@s.whatsapp.net`;
        try {
          const [result] = await sock.onWhatsApp(cleanPhone);
          if (result && result.exists) targetJid = result.jid;
        } catch (e) {}

        let sentResult;
        if (isAudioFile && audioBufferForQr) {
          sentResult = await sock.sendMessage(targetJid, {
            audio: audioBufferForQr,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true
          });
        } else if (finalMediaUrl && !isAudioFile) {
          sentResult = await sock.sendMessage(targetJid, { image: { url: finalMediaUrl }, caption: outputText });
        } else {
          sentResult = await sock.sendMessage(targetJid, { text: outputText });
        }

        const savedMessage = await ChatMessage.findOneAndUpdate(
          { messageId: sentResult?.key?.id || `qr-${Date.now()}` },
          {
            $set: {
              userId: userId,
              customerPhone: to,
              customerName: customerName || "WhatsApp User",
              platform: "whatsapp_qr",
              sender: "me",
              isBotMessage: false,
              text: isAudioFile ? "🎙️ Voice Note" : outputText,
              mediaUrl: finalMediaUrl,
              type: isAudioFile ? "audio" : (finalMediaUrl ? "image" : "text")
            },
            $setOnInsert: { status: "sent" }
          },
          { upsert: true, returnDocument: 'after', strict: false }
        );
        return res.json({ success: true, data: savedMessage });
      }
      return res.status(400).json({ success: false, error: "QR WhatsApp transmission failed." });
    }

    if (platform === "instagram" || platform === "messenger") {
      const { accessToken, appSecret, pageId, instagramAccountId, userId: targetUserId } = await getActiveMetaCredentials(userId, platform);
      const pageOrIgId = platform === "instagram" ? (instagramAccountId || pageId) : pageId;

      if (!accessToken || !pageOrIgId) {
        return res.status(400).json({ success: false, error: `Missing credentials for ${platform}` });
      }

      const directPayload = buildMetaDirectPayload(platform, outputText, [], finalMediaUrl);
      const responseData = await sendMetaDirectMessage(platform, pageOrIgId, to, accessToken, appSecret, directPayload);

      if (responseData) {
        const outboundMsgId = responseData.message_id || `${platform}-${Date.now()}`;
        const savedMessage = await ChatMessage.findOneAndUpdate(
          { messageId: outboundMsgId },
          {
            $set: {
              userId: targetUserId || userId,
              customerPhone: to,
              customerName: customerName || `${platform.toUpperCase()} User`,
              platform: platform,
              sender: "me",
              isBotMessage: false,
              text: outputText,
              mediaUrl: finalMediaUrl,
              type: finalMediaUrl ? "image" : "text"
            },
            $setOnInsert: { status: "sent" }
          },
          { upsert: true, returnDocument: 'after', strict: false }
        );
        return res.json({ success: true, metaData: responseData, data: savedMessage });
      }
      return res.status(400).json({ success: false, error: "Direct Delivery Failed." });
    }

    // Official Meta Cloud API Dispatch
    const { accessToken, phoneNumberId, userId: targetUserId } = await getActiveMetaCredentials(userId, "whatsapp");

    let metaPayload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formatToInternationalPhone(to)
    };

    if (isAudioFile && req.file) {
      try {
        const form = new FormData();
        form.append("messaging_product", "whatsapp");
        form.append("file", fs.createReadStream(req.file.path), {
          filename: req.file.filename,
          contentType: "audio/ogg"
        });
        form.append("type", "audio/ogg");

        const mediaUploadResponse = await axios.post(
          `https://graph.facebook.com/v20.0/${phoneNumberId}/media`,
          form,
          {
            headers: {
              ...form.getHeaders(),
              Authorization: `Bearer ${accessToken}`,
              "Accept-Encoding": "gzip, deflate, br"
            },
            decompress: true
          }
        );

        const metaMediaId = mediaUploadResponse.data.id;
        metaPayload.type = "audio";
        metaPayload.audio = { id: metaMediaId, voice: true };
      } catch (uploadError) {
        console.error("❌ Meta audio upload error, falling back to link:", uploadError.message);
        metaPayload.type = "audio";
        metaPayload.audio = { link: finalMediaUrl, voice: true };
      }
    } else if (finalMediaUrl) {
      const mediaData = buildMediaPayload(finalMediaUrl, outputText || "");
      if (mediaData) {
        metaPayload = { ...metaPayload, ...mediaData };
      }
    } else {
      metaPayload.type = "text";
      metaPayload.text = { preview_url: false, body: outputText };
    }

    const cleanRecipient = formatToInternationalPhone(to);
    const metaResponse = await sendUniversalWhatsAppMessage(targetUserId, phoneNumberId, accessToken, cleanRecipient, metaPayload, outputText);

    if (metaResponse) {
      const rawOutboundId = metaResponse.messages?.[0]?.id || `outbound-${Date.now()}`;
      const outboundMessageId = typeof rawOutboundId === "string" ? rawOutboundId.trim() : `outbound-${Date.now()}`;

      const savedMessage = await ChatMessage.findOneAndUpdate(
        { messageId: outboundMessageId },
        {
          $set: {
            userId: targetUserId || userId,
            customerPhone: cleanRecipient,
            customerName: customerName || "WhatsApp User",
            platform: "whatsapp",
            sender: "me",
            isBotMessage: false,
            text: isAudioFile ? "🎙️ Voice Note" : outputText,
            mediaUrl: finalMediaUrl,
            type: isAudioFile ? "audio" : (metaPayload.type || "text")
          },
          $setOnInsert: { status: "sent" } 
        },
        { upsert: true, returnDocument: 'after', strict: false }
      );

      return res.json({ 
        success: true, 
        metaData: metaResponse, 
        data: savedMessage 
      });
    }

    return res.status(400).json({ success: false, error: "Transmission pipeline failed." });

  } catch (err) {
    console.error("❌ OUTBOUND TRANSMISSION CORE ERROR:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/shopify/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const shopifyData = req.body;
    const topic = req.headers['x-shopify-topic'] || ""; 

    const result = await processShopifyNotification(shopifyData, topic, userId);
    return res.status(200).send(result);
  } catch (err) {
    console.error("❌ SHOPIFY DYNAMIC WEBHOOK CRASH:", err.message);
    return res.status(200).send("HANDLED_WITH_ERROR");
  }
});

router.post("/shopify", async (req, res) => {
  try {
    const shopifyData = req.body;
    const topic = req.headers['x-shopify-topic'] || ""; 

    const result = await processShopifyNotification(shopifyData, topic, null);
    return res.status(200).send(result);
  } catch (err) {
    console.error("❌ SHOPIFY WEBHOOK CRASH:", err.message);
    return res.status(200).send("HANDLED_WITH_ERROR");
  }
});

router.post("/woocommerce/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const wooData = req.body;

    const result = await processWooCommerceNotification(wooData, userId);
    return res.status(200).send(result);
  } catch (err) {
    console.error("❌ WOOCOMMERCE DYNAMIC WEBHOOK CRASH:", err.message);
    return res.status(200).send("HANDLED_WITH_ERROR");
  }
});

router.post("/woocommerce", async (req, res) => {
  try {
    const wooData = req.body;

    const result = await processWooCommerceNotification(wooData, null);
    return res.status(200).send(result);
  } catch (err) {
    console.error("❌ WOOCOMMERCE WEBHOOK CRASH:", err.message);
    return res.status(200).send("HANDLED_WITH_ERROR");
  }
});

router.get("/call-logs/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const logs = await CallLog.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();
    return res.status(200).json({ success: true, data: logs });
  } catch (err) {
    console.error("❌ Error fetching call logs:", err.message);
    return res.status(500).json({ success: false, message: "Server error fetching call logs" });
  }
});

module.exports = router;