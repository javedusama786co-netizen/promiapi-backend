const express = require("express");
const router = express.Router();
const Contact = require("../models/Contact");
const Campaign = require("../models/Campaign");
const ChatMessage = require("../models/ChatMessage");
const MessageLog = require("../models/MessageLog");
const Notification = require("../models/Notification");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const axios = require("axios");
const schedule = require("node-schedule");
const { sendQrWhatsAppMessage, getActiveSocket } = require("../routes/whatsappBaileysService");

// Helper: Micro-delay for avoiding Meta / Baileys Rate Limits
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getAdminQueryFilter = (businessScopeId) => {
  const ids = [String(businessScopeId)];
  if (mongoose.Types.ObjectId.isValid(businessScopeId)) {
    ids.push(new mongoose.Types.ObjectId(businessScopeId));
  }
  return [{ userId: { $in: ids } }, { adminId: { $in: ids } }];
};

const normalizePlatform = (value) => String(value || "whatsapp").toLowerCase().trim();
const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const looksLikePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
};

// 🛡️ RECIPIENT EXTRACTOR ISOLATION
function getContactRecipient(contact, platform) {
  if (!contact) return "";
  const target = normalizePlatform(platform);
  const storedPlatform = normalizePlatform(contact.platform);
  
  const recipientId = String(
    contact.recipientId || 
    contact.receptionId || 
    contact.recipient_id || 
    contact.reception_id || 
    contact.to || 
    contact.phone || 
    contact.phoneNumber || 
    ""
  ).trim();

  if (target === "whatsapp") {
    const phoneRaw = contact.phone || contact.phoneNumber || contact.whatsappNumber || contact.whatsapp || recipientId || "";
    if (looksLikePhone(phoneRaw)) return String(phoneRaw).replace(/\D/g, "");
    return "";
  }

  if (target === "instagram") {
    if (storedPlatform === "whatsapp") return "";
    const igId = String(contact.instagramId || contact.igsid || recipientId || "").trim();
    if (igId && !looksLikePhone(igId)) return igId;
    return "";
  }

  if (target === "messenger" || target === "facebook") {
    if (storedPlatform === "whatsapp") return "";
    const fbId = String(contact.facebookId || contact.psid || recipientId || "").trim();
    if (fbId && !looksLikePhone(fbId)) return fbId;
    return "";
  }

  return "";
}

function detectMediaType(url) {
  const clean = String(url || "").toLowerCase();
  if (clean.endsWith(".pdf") || clean.match(/\.(pdf|doc|docx)($|\?)/i)) return "document";
  if (clean.match(/\.(mp4|3gp|mov|avi)($|\?)/i)) return "video";
  return "image";
}

function summarizeFailures(failureReasons) {
  if (!Array.isArray(failureReasons) || failureReasons.length === 0) return "";
  const counts = {};
  failureReasons.forEach((item) => {
    const key = item.reason || "UNKNOWN";
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.entries(counts)
    .map(([reason, count]) => `${reason} (${count})`)
    .join(" | ");
}

async function persistCampaignResult(campaignId, payload) {
  try {
    await Campaign.findByIdAndUpdate(campaignId, payload);
  } catch (err) {
    await Campaign.findByIdAndUpdate(campaignId, {
      status: payload.status,
      successCount: payload.successCount,
      failureCount: payload.failureCount
    }).catch(() => {});
  }
}

// 🛠️ HELPER: Template ka actual text Mongo DB se fetch/replace karke QR engine ke liye taiyar karna (Fixed for 'content', 'body', 'text')
async function resolveTemplateContent(userId, templateNameOrId, variableInput, contactName) {
  try {
    const Template = mongoose.models.Template || mongoose.model("Template", new mongoose.Schema({}, { strict: false }), "templates");
    
    let query = {
      $or: [
        { name: templateNameOrId },
        { templateName: templateNameOrId },
        { title: templateNameOrId }
      ]
    };
    if (mongoose.Types.ObjectId.isValid(templateNameOrId)) {
      query.$or.push({ _id: templateNameOrId });
    }

    const template = await Template.findOne(query).lean();
    if (!template) {
      console.log(`⚠️ Template not found in DB for query: ${templateNameOrId}`);
      return null;
    }

    // 🟢 Fixed: Checking 'content' first because templates.js saves template body inside 'content' field
    let bodyText = template.content || template.body || template.text || "";
    if (!bodyText && Array.isArray(template.components)) {
      const bodyComp = template.components.find(c => String(c.type).toUpperCase() === "BODY");
      if (bodyComp) bodyText = bodyComp.text || "";
    }

    if (!bodyText) return null;

    // {{1}}, {{2}} variables ko comma-separated values se replace karna
    const vars = String(variableInput || "")
      .split(",")
      .map(v => v.trim())
      .filter(Boolean);

    vars.forEach((val, index) => {
      const placeholder = new RegExp(`\\{\\{\\s*${index + 1}\\s*\\}\\}`, "g");
      bodyText = bodyText.replace(placeholder, val);
    });

    bodyText = bodyText.replace(/\{\{\s*name\s*\}\}/gi, contactName || "Customer");

    return bodyText;
  } catch (err) {
    console.error("⚠️ Template Resolution Error:", err.message);
    return null;
  }
}

// 🛠️ HELPER (QR): Template ke saare hisse (header / body / footer / buttons / media) DB se nikal kar variables replace karta hai
async function resolveTemplateParts(templateNameOrId, variableInput, contactName) {
  try {
    const Template = mongoose.models.Template || mongoose.model("Template", new mongoose.Schema({}, { strict: false }), "templates");

    const query = { $or: [{ name: templateNameOrId }, { templateName: templateNameOrId }, { title: templateNameOrId }] };
    if (mongoose.Types.ObjectId.isValid(templateNameOrId)) query.$or.push({ _id: templateNameOrId });

    const template = await Template.findOne(query).lean();
    if (!template) {
      console.log(`⚠️ Template not found in DB for query: ${templateNameOrId}`);
      return null;
    }

    const isHttp = (v) => typeof v === "string" && /^(https?:\/\/|\/uploads\/)/i.test(v.trim());
    const pickStr = (...vals) => {
      for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
      return "";
    };

    let body = pickStr(template.content, template.body, template.text);
    let header = pickStr(
      typeof template.header === "string" ? template.header : "",
      template.header?.text, template.headerText, template.header_text
    );
    let footer = pickStr(
      typeof template.footer === "string" ? template.footer : "",
      template.footer?.text, template.footerText, template.footer_text
    );
    let media = [template.mediaUrl, template.media_url, template.headerUrl, template.header_url, template.headerMediaUrl, template.header?.mediaUrl]
      .find(isHttp) || "";
    let buttons = Array.isArray(template.buttons) ? template.buttons : [];

    if (Array.isArray(template.components)) {
      template.components.forEach((c) => {
        const type = String(c?.type || "").toUpperCase();
        if (type === "BODY" && !body) body = pickStr(c.text);
        else if (type === "FOOTER" && !footer) footer = pickStr(c.text);
        else if (type === "HEADER") {
          const fmt = String(c.format || "TEXT").toUpperCase();
          if (fmt === "TEXT" && !header) header = pickStr(c.text);
          else if (!media) media = [c.example?.header_handle?.[0], c.mediaUrl, c.url].find(isHttp) || "";
        } else if (type === "BUTTONS" && Array.isArray(c.buttons) && !buttons.length) {
          buttons = c.buttons;
        }
      });
    }

    if (!body && !header && !media) return null;

    const vars = String(variableInput || "").split(",").map((v) => v.trim()).filter(Boolean);
    const fill = (str) => {
      let out = String(str || "");
      vars.forEach((val, index) => {
        out = out.replace(new RegExp(`\\{\\{\\s*${index + 1}\\s*\\}\\}`, "g"), val);
      });
      return out.replace(/\{\{\s*name\s*\}\}/gi, contactName || "Customer");
    };

    return {
      body: fill(body),
      header: fill(header),
      footer: fill(footer),
      mediaUrl: media,
      buttons: buttons.map((b) => (b && typeof b === "object")
        ? { ...b, text: fill(b.text || b.title || b.label || b.buttonText), buttonText: b.buttonText ? fill(b.buttonText) : b.buttonText, url: b.url ? fill(b.url) : b.url }
        : b)
    };
  } catch (err) {
    console.error("⚠️ Template Parts Resolution Error:", err.message);
    return null;
  }
}

// 🛡️ {{name}} ko contact ke naam se replace karta hai (header / footer / buttons ke liye)
const fillContactName = (value, contactName) =>
  String(value || "").replace(/\{\{\s*name\s*\}\}/gi, contactName || "Customer");

const personalizeButtons = (list, contactName) =>
  (Array.isArray(list) ? list : []).map((b) => {
    if (typeof b === "string") return fillContactName(b, contactName);
    if (!b || typeof b !== "object") return b;
    const out = { ...b };
    ["text", "title", "label", "url", "value", "payload"].forEach((k) => {
      if (typeof out[k] === "string") out[k] = fillContactName(out[k], contactName);
    });
    return out;
  });

// 🔘 Buttons kisi bhi shakal me aa sakte hain: array, JSON string (FormData / multipart), ya object ({0:{..},1:{..}})
function parseButtonsInput(...candidates) {
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === "") continue;
    let value = raw;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch (e) { continue; }
    }
    if (value && !Array.isArray(value) && typeof value === "object") {
      value = Array.isArray(value.buttons) ? value.buttons : Object.values(value);
    }
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return [];
}

const isTransientQrError = (msg) => /closed|timed out|timeout|connection|not connected|rate|stream/i.test(String(msg || ""));

async function sendCampaignMessage({
  platform,
  configRecord,
  contact,
  messageText,
  mediaUrl,
  templateName,
  language,
  buttons
}) {
  try {
    const activePlatform = normalizePlatform(platform);
    const finalMessageText = String(messageText || "").trim();
    const cleanToken = String(configRecord.accessToken || configRecord.pageAccessToken || configRecord.instagramAccessToken || "")
      .replace(/^["']|["']$/g, "")
      .trim();
    const recipient = getContactRecipient(contact, activePlatform);
    const templateButtons = Array.isArray(buttons) ? buttons : [];

    if (activePlatform === "whatsapp") {
      if (!recipient) {
        return {
          success: false,
          reason: "MISSING_PHONE_NUMBER",
          details: `No valid WhatsApp phone number found on contact '${contact.name || contact._id}'.`
        };
      }

      if (!configRecord.phoneNumberId || !cleanToken) {
        return {
          success: false,
          reason: "MISSING_META_CONFIG",
          details: "Phone Number ID or Access Token missing in WhatsApp Config."
        };
      }

      let payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient
      };

      if (templateName) {
        payload.type = "template";
        payload.template = {
          name: String(templateName).trim(),
          language: { code: language || "en_US" }
        };

        const components = [];

        if (mediaUrl) {
          const mediaType = detectMediaType(mediaUrl);
          components.push({
            type: "header",
            parameters: [{ type: mediaType, [mediaType]: { link: mediaUrl } }]
          });
        }

        if (finalMessageText && !finalMessageText.startsWith("Template:")) {
          const bodyParams = finalMessageText
            .split(",")
            .map((val) => val.trim())
            .filter(Boolean)
            .map((val) => ({ type: "text", text: val }));

          if (bodyParams.length > 0) {
            components.push({ type: "body", parameters: bodyParams });
          }
        }

        templateButtons.forEach((btn, index) => {
          if (!btn) return;
          components.push({
            type: "button",
            sub_type: btn.type || "quick_reply",
            index: String(index),
            parameters: [{ type: "payload", payload: String(btn.value || contact.name || "Click") }]
          });
        });

        if (components.length > 0) payload.template.components = components;
      } else {
        if (mediaUrl) {
          const mediaType = detectMediaType(mediaUrl);
          payload.type = mediaType;
          payload[mediaType] = { link: mediaUrl, caption: finalMessageText || undefined };
        } else if (finalMessageText) {
          payload.type = "text";
          payload.text = { preview_url: false, body: finalMessageText };
        } else {
          return {
            success: false,
            reason: "EMPTY_MESSAGE",
            details: "WhatsApp message requires body text, media, or template."
          };
        }
      }

      const metaUrl = `https://graph.facebook.com/v20.0/${configRecord.phoneNumberId}/messages`;
      const response = await axios.post(metaUrl, payload, {
        headers: { Authorization: `Bearer ${cleanToken}`, "Content-Type": "application/json" }
      });
      return { success: true, messageId: response.data?.messages?.[0]?.id };
    }

    if (activePlatform === "instagram") {
      if (!recipient) {
        return { success: false, reason: "MISSING_INSTAGRAM_ID", details: `No valid Instagram Recipient ID on contact '${contact.name || contact._id}'.` };
      }
      if (!cleanToken) {
        return { success: false, reason: "MISSING_META_CONFIG", details: "Instagram access token missing." };
      }

      const igEndpoint = `https://graph.facebook.com/v20.0/${configRecord.pageId || configRecord.instagramAccountId || "me"}/messages`;
      const headers = { Authorization: `Bearer ${cleanToken}`, "Content-Type": "application/json" };

      if (mediaUrl) {
        await axios.post(igEndpoint, { recipient: { id: recipient }, message: { attachment: { type: "image", payload: { url: mediaUrl, is_reusable: true } } } }, { headers });
      }

      if (finalMessageText || !mediaUrl) {
        await axios.post(igEndpoint, { recipient: { id: recipient }, message: { text: finalMessageText || "Hello" } }, { headers });
      }

      return { success: true };
    }

    if (activePlatform === "messenger" || activePlatform === "facebook") {
      if (!recipient) {
        return { success: false, reason: "MISSING_MESSENGER_ID", details: `No valid Messenger Recipient ID on contact '${contact.name || contact._id}'.` };
      }
      if (!cleanToken) {
        return { success: false, reason: "MISSING_META_CONFIG", details: "Messenger page access token missing." };
      }

      const msgEndpoint = `https://graph.facebook.com/v20.0/${configRecord.pageId || "me"}/messages`;
      const headers = { Authorization: `Bearer ${cleanToken}`, "Content-Type": "application/json" };
      const messagingType = "UPDATE";

      if (mediaUrl) {
        await axios.post(msgEndpoint, { recipient: { id: recipient }, messaging_type: messagingType, message: { attachment: { type: "image", payload: { url: mediaUrl, is_reusable: true } } } }, { headers });
      }

      if (finalMessageText || !mediaUrl) {
        await axios.post(msgEndpoint, { recipient: { id: recipient }, messaging_type: messagingType, message: { text: finalMessageText || "Hello" } }, { headers });
      }

      return { success: true };
    }

    return { success: false, reason: "UNSUPPORTED_PLATFORM", details: `Platform '${activePlatform}' is not supported.` };
  } catch (err) {
    const metaErr = err.response?.data?.error || err.message;
    console.error("❌ META API REJECTION DETAILED ERROR:", JSON.stringify(metaErr, null, 2));
    return {
      success: false,
      reason: "META_API_REJECTED",
      details: (metaErr && metaErr.message) || (typeof metaErr === "string" ? metaErr : JSON.stringify(metaErr))
    };
  }
}

const handleCampaignExecution = async (req, res) => {
  try {
    const businessScopeId = req.user?.adminId || req.user?.id || req.user?._id || req.body?.subscriptionId || req.body?.tenantId;
    const missingRequirements = [];

    if (!businessScopeId) {
      missingRequirements.push({ requirement: "Subscription ID / User Auth Context", status: "MISSING", details: "req.user is undefined." });
    }

    const name = req.body.name || req.body.campaignName;
    const contactId = req.body.contactId;
    const recipientId = req.body.recipientId || req.body.receptionId || req.body.reception_id || req.body.recipient_id || req.body.to || req.body.phone;
    const targetGroup = req.body.targetGroup || req.body.group;
    const group = req.body.group || req.body.targetGroup;
    const templateName = req.body.templateName || req.body.template;
    const language = req.body.language || "en_US";
    
    const rawMessage = 
      req.body.messageText || 
      req.body.message_text || 
      req.body.message || 
      req.body.text || 
      req.body.body || 
      req.body.caption || 
      "";

    // 🧩 Header (text ya {text, mediaUrl}) aur Footer - QR engine par bhi poore bheje jayenge
    const rawHeader = req.body.header ?? req.body.headerText ?? req.body.header_text ?? "";
    let campaignHeader = "";
    let headerMediaUrl = "";
    if (rawHeader && typeof rawHeader === "object") {
      campaignHeader = String(rawHeader.text || rawHeader.title || "").trim();
      headerMediaUrl = String(rawHeader.mediaUrl || rawHeader.url || rawHeader.link || "").trim();
    } else {
      campaignHeader = String(rawHeader || "").trim();
    }
    const campaignFooter = String(req.body.footer ?? req.body.footerText ?? req.body.footer_text ?? "").trim();

    const mediaUrl = req.body.mediaUrl || req.body.media_url || headerMediaUrl || undefined;
    const scheduledTime = req.body.scheduledTime || req.body.scheduledAt;
    const platform = req.body.platform || "whatsapp";
    const buttons = req.body.buttons;
    const templateButtons = req.body.templateButtons;

    const targetPlatform = normalizePlatform(platform);
    const campaignTitle = name || `${targetPlatform.toUpperCase()}-Broadcast-${Date.now()}`;
    let fallbackMessage = String(rawMessage).trim();
    const campaignButtons = parseButtonsInput(
      buttons, templateButtons,
      req.body.quickReplies, req.body.quick_replies, req.body.buttonList, req.body.button_list, req.body.actions
    );
    console.log(`📣 [Campaign] platform=${targetPlatform} buttons received: ${campaignButtons.length} (raw type: ${typeof buttons}) | header: ${campaignHeader ? "yes" : "no"} | footer: ${campaignFooter ? "yes" : "no"} | media: ${mediaUrl ? "yes" : "no"}`);

    if (targetPlatform === "whatsapp") {
      if (!fallbackMessage && !mediaUrl && !templateName && !campaignHeader) {
        missingRequirements.push({ requirement: "Text / Template / Media Content", status: "MISSING", details: "WhatsApp campaigns require text, header, mediaUrl, or templateName." });
      }
    } else if (!fallbackMessage && !mediaUrl) {
      missingRequirements.push({ requirement: "Text / Media Content", status: "MISSING", details: `${targetPlatform.toUpperCase()} requires text or mediaUrl.` });
    }

    if (missingRequirements.length > 0) {
      return res.status(400).json({ success: false, message: "Campaign Execution Blocked: Required fields missing.", missingRequirements, receivedPayload: req.body });
    }

    const userConditions = getAdminQueryFilter(businessScopeId);
    const WhatsAppConfig = mongoose.models.WhatsAppConfig || mongoose.model("WhatsAppConfig", new mongoose.Schema({}, { strict: false }), "whatsappconfigs");

    const possibleUserIds = [String(businessScopeId)];
    if (mongoose.Types.ObjectId.isValid(businessScopeId)) {
      possibleUserIds.push(new mongoose.Types.ObjectId(businessScopeId));
    }

    // 🔍 1. Check Cloud API Config
    let cloudConfig = await WhatsAppConfig.findOne({
      $and: [
        { $or: [{ userId: { $in: possibleUserIds } }, { adminId: { $in: possibleUserIds } }] },
        { platform: targetPlatform }
      ]
    }).sort({ updatedAt: -1 }).lean();

    if (!cloudConfig && targetPlatform === "whatsapp") {
      cloudConfig = await WhatsAppConfig.findOne({
        $and: [
          { $or: [{ userId: { $in: possibleUserIds } }, { adminId: { $in: possibleUserIds } }] },
          { $or: [{ platform: { $exists: false } }, { platform: null }, { platform: "" }] }
        ]
      }).sort({ updatedAt: -1 }).lean();
    }

    const isCloudApiActive = Boolean(
      cloudConfig && 
      cloudConfig.phoneNumberId && 
      cloudConfig.accessToken && 
      cloudConfig.accessToken !== "ACTIVE_SESSION" &&
      String(cloudConfig.phoneNumberId).trim() !== ""
    );

    // 🔍 2. Check QR Engine Config & Active Socket
    let qrConfig = await WhatsAppConfig.findOne({
      $and: [
        { $or: [{ userId: { $in: possibleUserIds } }, { adminId: { $in: possibleUserIds } }] },
        { platform: "whatsapp_qr" }
      ]
    }).sort({ updatedAt: -1 }).lean();

    let activeSocket = null;
    try {
      activeSocket = getActiveSocket(businessScopeId);
    } catch (e) {}

    const isQrEngineActive = Boolean(
      (qrConfig && (qrConfig.status === "CONNECTED" || qrConfig.status === "SCAN_REQUIRED")) ||
      activeSocket
    );

    // ⚖️ 3. Intelligent Engine Selection
    let isQrEngine = false;
    if (targetPlatform === "whatsapp") {
      if (!isCloudApiActive && (isQrEngineActive || qrConfig)) {
        isQrEngine = true;
      } else if (!isCloudApiActive && !cloudConfig) {
        isQrEngine = true;
      }
    }

    let configRecord = isQrEngine ? (qrConfig || { phoneNumberId: "qr_engine_placeholder", accessToken: "qr_engine_token" }) : cloudConfig;

    if (!configRecord && !isQrEngine) {
      return res.status(400).json({ 
        success: false, 
        message: `Execution Failed: ${targetPlatform.toUpperCase()} API details or QR session not found. Please complete setup first.` 
      });
    }

    if (!configRecord) {
      configRecord = { phoneNumberId: "qr_engine_placeholder", accessToken: "qr_engine_token" };
    }

    const rawToken = configRecord.accessToken || configRecord.pageAccessToken || configRecord.instagramAccessToken || "";
    const cleanToken = String(rawToken).replace(/^["']|["']$/g, "").replace(/[\r\n]+/g, "").trim();

    configRecord.cleanAccessToken = cleanToken;
    configRecord.accessToken = cleanToken;

    let targetContacts = [];
    const targetContactId = contactId || recipientId;

    if (targetContactId) {
      if (mongoose.Types.ObjectId.isValid(targetContactId)) {
        const singleContact = await Contact.findOne({ _id: targetContactId, $or: userConditions });
        if (singleContact) targetContacts = [singleContact];
      } else {
        targetContacts = [{ 
          _id: targetContactId, 
          recipientId: targetContactId, 
          phone: targetContactId, 
          name: req.body.customerName || "Direct Contact" 
        }];
      }
    }

    if (targetContacts.length === 0) {
      const selectedGroup = String(targetGroup || group || "All").trim();
      let groupFilter = {};

      if (selectedGroup !== "All" && selectedGroup !== "all") {
        const safeRegex = new RegExp(`^${escapeRegex(selectedGroup)}$`, "i");
        groupFilter = {
          $or: [
            { group: { $regex: safeRegex } },
            { targetGroup: { $regex: safeRegex } },
            { category: { $regex: safeRegex } },
            { tags: { $in: [selectedGroup] } }
          ]
        };
      }

      const matchedContacts = await Contact.find({ $and: [{ $or: userConditions }, groupFilter] });
      targetContacts = matchedContacts.filter((c) => Boolean(getContactRecipient(c, targetPlatform)));
    }

    if (targetContacts.length === 0) {
      return res.status(400).json({ success: false, message: `No valid contacts found for platform '${targetPlatform.toUpperCase()}'.` });
    }

    // 🔌 QR session connected na ho to campaign shuru hi na karo (warna har contact "failed" hota)
    if (isQrEngine && targetPlatform === "whatsapp" && !scheduledTime && !activeSocket) {
      return res.status(400).json({
        success: false,
        message: "WhatsApp QR session is not connected. Please scan the QR code again and retry the campaign."
      });
    }

    const savedCampaign = await Campaign.create({
      userId: String(businessScopeId),
      name: campaignTitle,
      group: targetGroup || group || "Direct/Single",
      targetGroup: targetGroup || group || "Direct/Single",
      platform: targetPlatform,
      templateName: targetPlatform === "whatsapp" ? (templateName || null) : null,
      language: language || "en_US",
      mediaUrl: mediaUrl || null,
      header: campaignHeader || null,
      footer: campaignFooter || null,
      buttons: campaignButtons,
      message: fallbackMessage || (templateName ? `Template: ${templateName}` : "Media Payload"),
      status: scheduledTime ? "SCHEDULED" : "PROCESSING",
      totalContacts: targetContacts.length,
      successCount: 0,
      failureCount: 0,
      scheduledAt: scheduledTime ? new Date(scheduledTime) : null
    });

    const runCampaignPayload = async () => {
      let successCount = 0;
      let failureCount = 0;
      const failureReasons = [];

      for (const contact of targetContacts) {
        const recipientValue = getContactRecipient(contact, targetPlatform);
        let personalText = fallbackMessage;

        // 🌐 QR ENGINE: header / footer / buttons / media bhi har contact ke liye taiyar karo
        let personalHeader = fillContactName(campaignHeader, contact.name);
        let personalFooter = fillContactName(campaignFooter, contact.name);
        let personalButtons = personalizeButtons(campaignButtons, contact.name);
        let personalMedia = mediaUrl || "";
        let templateMissing = false;

        if (isQrEngine && targetPlatform === "whatsapp" && templateName) {
          const parts = await resolveTemplateParts(templateName, fallbackMessage, contact.name);
          if (parts) {
            personalText = parts.body;
            personalHeader = parts.header || personalHeader;
            personalFooter = parts.footer || personalFooter;
            if (parts.buttons.length && !personalButtons.length) personalButtons = parts.buttons;
            if (!personalMedia && parts.mediaUrl) personalMedia = parts.mediaUrl;
          } else {
            templateMissing = true;
          }
        } else if (personalText && !templateName) {
          personalText = personalText.replace(/\{\{\s*name\s*\}\}/gi, contact.name || "Customer");
        }

        const msgBody = targetPlatform === "whatsapp" && templateName 
          ? (isQrEngine ? personalText : `📢 Template: ${templateName}`) 
          : (personalText || "Media Payload");

        try {
          let dispatchResult = { success: false, reason: "DISPATCH_INIT" };

          if (isQrEngine && targetPlatform === "whatsapp" && templateMissing) {
            // Template DB me nahi mila / khali tha => "Template: xyz" jaisa kachra customer ko mat bhejo
            dispatchResult = {
              success: false,
              reason: "TEMPLATE_NOT_FOUND",
              details: `Template '${templateName}' not found or has no content for the QR engine.`
            };
          } else if (isQrEngine && targetPlatform === "whatsapp") {
            // 🌐 QR ENGINE DISPATCH (text + header + footer + media + buttons)
            try {
              const qrOptions = {
                isCampaign: true,
                mediaUrl: personalMedia || undefined,
                header: personalHeader || undefined,
                footer: personalFooter || undefined,
                buttons: personalButtons
              };
              let qrSendResult = await sendQrWhatsAppMessage(businessScopeId, recipientValue, personalText, qrOptions);

              // Temporary connection / timeout error par ek baar dobara koshish
              if (!qrSendResult?.success && isTransientQrError(qrSendResult?.error)) {
                await sleep(3000);
                qrSendResult = await sendQrWhatsAppMessage(businessScopeId, recipientValue, personalText, qrOptions);
              }

              if (qrSendResult && qrSendResult.success) {
                dispatchResult = { 
                  success: true, 
                  messageId: qrSendResult.messages?.[0]?.id || `qr-camp-${Date.now()}` 
                };
              } else {
                dispatchResult = { 
                  success: false, 
                  reason: "QR_DISPATCH_FAILED", 
                  details: qrSendResult?.error || "Failed to send via WhatsApp QR engine." 
                };
              }
            } catch (qrErr) {
              dispatchResult = { 
                success: false, 
                reason: "QR_DISPATCH_CRASH", 
                details: qrErr.message 
              };
            }
          } else {
            dispatchResult = await sendCampaignMessage({
              platform: targetPlatform,
              configRecord,
              contact,
              messageText: personalText,
              mediaUrl,
              templateName: targetPlatform === "whatsapp" ? templateName : null,
              language,
              buttons: campaignButtons
            });
          }

          if (dispatchResult.success) {
            successCount++;

            // Chat me poora message dikhane ke liye preview (header + body + footer + buttons)
            const chatPreview = (isQrEngine && targetPlatform === "whatsapp")
              ? [
                  personalHeader ? `*${personalHeader}*` : "",
                  personalText,
                  personalFooter ? `_${personalFooter}_` : "",
                  personalButtons.length
                    ? personalButtons.map((b) => `[ ${typeof b === "string" ? b : (b.text || b.title || b.label || "")} ]`).join(" ")
                    : ""
                ].filter(Boolean).join("\n\n")
              : personalText;

            // 1. Save to ChatMessage
            try {
              await ChatMessage.create({
                userId: String(businessScopeId),
                customerPhone: recipientValue,
                customerName: contact.name || "Customer",
                platform: isQrEngine ? "whatsapp_qr" : targetPlatform,
                sender: "me",
                ...(isQrEngine && dispatchResult.messageId ? { messageId: dispatchResult.messageId } : {}),
                text: chatPreview || personalText || "Media Message",
                mediaUrl: personalMedia || mediaUrl || null,
                status: "sent",
                isCampaign: true,
                campaignId: savedCampaign._id
              });
            } catch (chatErr) {
              console.error("Chat Log Error:", chatErr.message);
            }

            // 2. Save to MessageLog
            try {
              await MessageLog.create({
                userId: String(businessScopeId),
                platform: targetPlatform,
                receiverNumber: recipientValue || "Unknown",
                receiverName: contact.name || "Customer",
                messageBody: msgBody,
                campaignName: campaignTitle,
                status: "sent",
                metaMessageId: dispatchResult.messageId || ""
              });
            } catch (mLogErr) {
              console.error("MessageLog Creation Error:", mLogErr.message);
            }

          } else {
            failureCount++;
            failureReasons.push({
              contactName: contact.name || "Unknown",
              contactId: String(contact._id || ""),
              reason: dispatchResult.reason || "UNKNOWN",
              details: dispatchResult.details || ""
            });

            try {
              await MessageLog.create({
                userId: String(businessScopeId),
                platform: targetPlatform,
                receiverNumber: recipientValue || "Unknown",
                receiverName: contact.name || "Customer",
                messageBody: msgBody,
                campaignName: campaignTitle,
                status: "failed"
              });
            } catch (mLogErr) {
              console.error("MessageLog Failure Entry Error:", mLogErr.message);
            }
          }
        } catch (oneErr) {
          failureCount++;
          failureReasons.push({
            contactName: contact.name || "Unknown",
            contactId: String(contact._id || ""),
            reason: "DISPATCH_CRASH",
            details: oneErr.message
          });

          try {
            await MessageLog.create({
              userId: String(businessScopeId),
              platform: targetPlatform,
              receiverNumber: recipientValue || "Unknown",
              receiverName: contact.name || "Customer",
              messageBody: msgBody,
              campaignName: campaignTitle,
              status: "failed"
            });
          } catch (mLogErr) {
            console.error("MessageLog Crash Entry Error:", mLogErr.message);
          }
        }

        // ⏱️ Safe delay (4-7s random for QR to avoid banned numbers, 300ms for Meta Cloud API)
        const activeDelay = (isQrEngine && targetPlatform === "whatsapp") ? 4000 + Math.floor(Math.random() * 3000) : 300;
        await sleep(activeDelay);
      }

      const lastError = summarizeFailures(failureReasons);
      const isCompleteFailure = failureCount === targetContacts.length && targetContacts.length > 0;
      const isPartialFailure = failureCount > 0 && !isCompleteFailure;

      await persistCampaignResult(savedCampaign._id, {
        status: isCompleteFailure ? "FAILED" : "SENT",
        successCount,
        failureCount,
        lastError: lastError || null,
        failureReasons: failureReasons.slice(0, 50)
      });

      try {
        let notifTitle = "";
        let notifMessage = "";
        let notifType = "campaign";

        if (isCompleteFailure) {
          notifTitle = `Campaign Failed: ${campaignTitle}`;
          notifMessage = `Your campaign "${campaignTitle}" on ${targetPlatform.toUpperCase()} failed completely for all ${targetContacts.length} recipients. ${lastError ? `Reason: ${lastError}` : ''}`;
          notifType = "error";
        } else if (isPartialFailure) {
          notifTitle = `Campaign Completed with Warnings: ${campaignTitle}`;
          notifMessage = `Your campaign "${campaignTitle}" finished sending. Delivered: ${successCount}, Failed: ${failureCount}. ${lastError ? `Issues: ${lastError}` : ''}`;
          notifType = "warning";
        } else {
          notifTitle = `Campaign Dispatched Successfully: ${campaignTitle}`;
          notifMessage = `Your campaign "${campaignTitle}" has been successfully delivered to all ${successCount} contact(s) via ${targetPlatform.toUpperCase()} (${isQrEngine ? 'QR Engine' : 'Cloud API'}).`;
          notifType = "success";
        }

        await Notification.create({
          userId: String(businessScopeId),
          title: notifTitle,
          message: notifMessage,
          type: notifType,
          link: "/dashboard/campaigns",
          isRead: false
        });
      } catch (notifErr) {
        console.error("Campaign Notification System Error:", notifErr.message);
      }
    };

    if (scheduledTime) {
      schedule.scheduleJob(savedCampaign._id.toString(), new Date(scheduledTime), () => {
        runCampaignPayload().catch(async (err) => {
          await persistCampaignResult(savedCampaign._id, { status: "FAILED", successCount: 0, failureCount: targetContacts.length, lastError: err.message });
          
          try {
            await Notification.create({
              userId: String(businessScopeId),
              title: `Scheduled Campaign Failed: ${campaignTitle}`,
              message: `Scheduled campaign "${campaignTitle}" could not be executed due to an internal system error: ${err.message}`,
              type: "error",
              link: "/dashboard/campaigns",
              isRead: false
            });
          } catch (e) {}
        });
      });
      return res.json({ success: true, status: "SCHEDULED", dispatchCount: targetContacts.length, campaign: savedCampaign });
    }

    runCampaignPayload().catch(async (err) => {
      await persistCampaignResult(savedCampaign._id, { status: "FAILED", successCount: 0, failureCount: targetContacts.length, lastError: err.message });
      
      try {
        await Notification.create({
          userId: String(businessScopeId),
          title: `Campaign System Failure: ${campaignTitle}`,
          message: `Campaign execution for "${campaignTitle}" encountered an unexpected system error: ${err.message}`,
          type: "error",
          link: "/dashboard/campaigns",
          isRead: false
        });
      } catch (e) {}
    });

    return res.json({ success: true, status: "PROCESSING", dispatchCount: targetContacts.length, campaign: savedCampaign });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Campaign processor encountered a system error.", error: err.message });
  }
};

router.post("/send", auth, handleCampaignExecution);
router.post("/trigger", auth, handleCampaignExecution);
router.post("/broadcast", auth, handleCampaignExecution);
router.post("/", auth, handleCampaignExecution);

router.get("/", auth, async (req, res) => {
  try {
    const businessScopeId = req.user?.adminId || req.user?.id || req.user?._id;
    const userConditions = getAdminQueryFilter(businessScopeId);
    const campaigns = await Campaign.find({ $or: userConditions }).sort({ createdAt: -1 });
    return res.json({ success: true, campaigns });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch campaigns.", error: err.message });
  }
});

router.delete("/:id", auth, async (req, res) => {
  try {
    const businessScopeId = req.user?.adminId || req.user?.id || req.user?._id;
    const userConditions = getAdminQueryFilter(businessScopeId);
    await Campaign.findOneAndDelete({ _id: req.params.id, $or: userConditions });
    return res.json({ success: true, message: "Campaign log removed successfully." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to delete campaign log.", error: err.message });
  }
});

module.exports = router;