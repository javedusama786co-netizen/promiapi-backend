const baileys = require("@whiskeysockets/baileys");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
const normalizeMessageContent = baileys.normalizeMessageContent;
const qrcode = require("qrcode");
const pino = require("pino");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const WhatsAppConfig = require("../models/whatsappConfigModel");
const axios = require("axios");
const ffmpeg = require("fluent-ffmpeg"); // 🔥 FFmpeg imported for proper voice note conversion

// 🌐 Safe Models Import for Bot, Flow & AI Integration
function safeModel(name, file) {
  if (mongoose.models[name]) return mongoose.models[name];
  try { return require(file); } catch (e) { return null; }
}
const ChatMessage = mongoose.models.ChatMessage || require("../models/ChatMessage");
const Contact = mongoose.models.Contact || require("../models/Contact");
const BotReply = mongoose.models.BotReply || require("../models/BotReply");
const BotFlow = mongoose.models.BotFlow || require("../models/BotFlow");
const UserSession = mongoose.models.UserSession || require("../models/UserSession");
const AiBotSettings = mongoose.models.AiBotSettings || require("../models/AiBotSettings");
const Template = mongoose.models.Template || require("../models/Template");
const User = safeModel("User", "../models/User");
const Order = safeModel("Order", "../models/Order");

// ⚙️ CONFIG
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://unawake-oversized-moneybags.ngrok-free.dev";
const UPLOAD_DIR = path.join(__dirname, "../uploads");
const BUTTONS_MODE = String(process.env.BAILEYS_BUTTONS_MODE || "text").toLowerCase();
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;

let activeSessions = {};       // userId -> socket instance
let qrCodesCache = {};         // userId -> base64 QR image
let lidToPhoneMap = {};        // LID to Phone mapping store
let phoneToRemoteJidMap = {};  // Clean Phone / ID -> Exact Remote Jid (LID/JID) mapping store

// 🔥 DYNAMIC FFMPEG PATH CONFIGURATION
if (process.platform === "win32") {
  try {
    ffmpeg.setFfmpegPath("C:\\ffmpeg\\bin\\ffmpeg.exe");
  } catch (e) {}
}

function generateVerifyToken() {
  return "v_token_" + require("crypto").randomBytes(16).toString("hex");
}

const fetchUserProfilePicture = async (sock, jid) => {
    try {
        const ppUrl = await sock.profilePictureUrl(jid, "image");
        return ppUrl || null;
    } catch (err) {
        return null;
    }
};

// 🟢 SMART MAPPING HELPER: Separates UI Clean Phone from Backend Technical remoteJid (LID/JID)
async function resolveCleanCustomerPhone(sock, remoteJid, participant = null) {
    if (!remoteJid) return null;

    let targetId = participant || remoteJid;
    let rawId = targetId.split("@")[0];
    let cleanPhone = rawId;

    if (targetId.includes("lid") || rawId.length > 13) {
        if (lidToPhoneMap[rawId]) {
            cleanPhone = lidToPhoneMap[rawId].replace(/\D/g, "");
        } else {
            try {
                const existingContact = await Contact.findOne({ 
                    $or: [{ remoteJid: targetId }, { lid: rawId }, { phone: rawId }, { phoneNumber: rawId }] 
                }).lean();
                if (existingContact && existingContact.phone) {
                    cleanPhone = existingContact.phone.replace(/\D/g, "");
                }
            } catch (err) {}
        }
    } else {
        cleanPhone = rawId.replace(/\D/g, "");
    }

    if (cleanPhone.startsWith("03") && cleanPhone.length === 11) {
        cleanPhone = "92" + cleanPhone.substring(1);
    }

    let displayPhone = cleanPhone.length >= 7 ? cleanPhone : rawId;

    if (displayPhone && targetId) {
        phoneToRemoteJidMap[displayPhone] = targetId;
        phoneToRemoteJidMap[rawId] = targetId;
    }

    return {
        displayPhone: displayPhone,
        remoteJid: targetId
    };
}

// =========================================================================
// 🔒 ROBUST SUBSCRIPTION VERIFICATION ENGINE
// =========================================================================
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

// =========================================================================
// 🔌 EXTERNAL CBS & TOOL EXECUTION ENGINE FOR QR
// =========================================================================
async function fetchExternalCBSData(functionName, args, customerPhone, settings) {
  try {
    if (functionName === "get_customer_orders_status") {
      if (Order) {
        const cleanPhone = String(customerPhone).replace(/\D/g, "");
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
    return { status: "success", message: `Function ${functionName} executed successfully.` };
  } catch (err) {
    return { error: "Failed to connect to system server." };
  }
}

async function handleManualFunctionExecution(targetUserId, customerPhone, cleanKeyword, userSession) {
  try {
    const settings = await AiBotSettings.findOne({ userId: targetUserId });
    let functionName = null;
    const text = cleanKeyword.toLowerCase();

    if (text.includes("balance") || text.includes("account") || text === "1") {
      functionName = "get_bank_account_balance";
    } else if (text.includes("order") || text.includes("tracking") || text.includes("status") || text === "2") {
      functionName = "get_customer_orders_status";
    }

    if (functionName) {
      const data = await fetchExternalCBSData(functionName, {}, customerPhone, settings);
      if (data && data.status === "success" && data.orders) {
        let textReply = `📦 *Your Recent Orders (${data.count}):*\n\n`;
        data.orders.forEach((ord, idx) => {
          textReply += `${idx + 1}. ID: *${ord.orderId}* | Status: *${ord.status}* | RS ${ord.totalPrice}\n`;
        });
        return textReply;
      } else if (data?.message) {
        return `ℹ️ ${data.message}`;
      }
    }
  } catch (err) {}
  return null;
}

// =========================================================================
// 🤖 FULLY PROFESSIONAL AI BOT & FLOWISE ENGINE FOR QR
// =========================================================================
async function processAiBotResponse(userId, customerPhone, userText) {
  try {
    const isSubscribed = await verifyUserAiSubscription(userId);
    if (!isSubscribed) return null;

    const settings = await AiBotSettings.findOne({ userId });
    if (!settings) return null;

    if (settings.flowise?.enabled && settings.flowise?.apiUrl) {
      try {
        const flowiseRes = await axios.post(
          settings.flowise.apiUrl, 
          { question: userText },
          { headers: { "Accept-Encoding": "gzip, deflate, br" }, decompress: true }
        );
        const text = flowiseRes.data?.text || flowiseRes.data?.textResponse || flowiseRes.data;
        if (typeof text === "string" && text.trim()) {
          return text.trim();
        }
      } catch (fErr) {}
    }

    if (settings.openai?.enabled && settings.openai?.apiKey) {
      const messages = [];
      if (settings.openai.systemPrompt) {
        messages.push({ role: "system", content: settings.openai.systemPrompt });
      }

      const chatHistory = await ChatMessage.find({ userId, customerPhone }).sort({ createdAt: -1 }).limit(10);
      chatHistory.reverse().forEach((msg) => {
        messages.push({ role: msg.sender === "me" ? "assistant" : "user", content: msg.text || "" });
      });

      messages.push({ role: "user", content: userText });

      const openAiRes = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        { model: settings.openai.model || "gpt-4o", messages, temperature: settings.openai.temperature ?? 0.7 },
        { headers: { Authorization: `Bearer ${settings.openai.apiKey}`, "Content-Type": "application/json" } }
      );

      const finalReply = openAiRes.data?.choices?.[0]?.message?.content;
      if (finalReply && finalReply.trim()) return finalReply.trim();
    }
    return settings?.general?.failedMessage || null;
  } catch (err) {
    return null;
  }
}

// =========================================================================
// 🧰 BOT HELPERS (buttons, media, pending choices)
// =========================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NUM_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

const botSentIds = new Set();
function markBotSent(id) {
  if (!id) return;
  botSentIds.add(id);
  setTimeout(() => botSentIds.delete(id), 10 * 60 * 1000).unref?.();
}

const pendingChoices = new Map();
const pendingKey = (userId, phone) => `${userId}:${phone}`;
function setPending(userId, phone, ctx) {
  pendingChoices.set(pendingKey(userId, phone), { ...ctx, ts: Date.now() });
}
function getPending(userId, phone) {
  const k = pendingKey(userId, phone);
  const v = pendingChoices.get(k);
  if (!v) return null;
  if (Date.now() - v.ts > PENDING_TTL_MS) { pendingChoices.delete(k); return null; }
  return v;
}
function clearPending(userId, phone) { pendingChoices.delete(pendingKey(userId, phone)); }

const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const PHONE_RE = /^\+?[\d\s\-()]{7,}$/;

function buildButtonLink(type, payload) {
  const p = String(payload || "").trim();
  if (!p) return null;
  if (type === "url" || URL_RE.test(p)) {
    return { kind: "url", url: /^https?:\/\//i.test(p) ? p : `https://${p}` };
  }
  if (type === "call" || type === "phone" || PHONE_RE.test(p)) {
    let d = p.replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    else if (d.startsWith("03") && d.length === 11) d = "92" + d.slice(1);
    if (d.length < 7) return null;
    return { kind: "phone", number: d, url: `https://wa.me/${d}` };
  }
  return null;
}

function normalizeButtons(raw, source = "flow", max = 10) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((btn, idx) => {
      if (typeof btn === "string") {
        const t = btn.trim();
        return t ? { id: `btn_${idx}`, text: t, type: "reply", payload: t, index: idx, link: buildButtonLink("reply", t) } : null;
      }
      if (!btn || typeof btn !== "object") return null;
      const text = String(btn.text || btn.title || btn.label || btn.buttonText || "").trim();
      if (!text) return null;
      const type = btn.buttonType || btn.type || (btn.url ? "url" : (btn.phone || btn.phoneNumber) ? "call" : "reply");
      const id = source === "rule"
        ? String(btn.payload || btn.value || `btn_${idx}`)
        : String(btn.id || `btn_${idx}`);
      const payload = String(btn.payload || btn.value || btn.url || btn.phone || btn.phoneNumber || text);
      return { id, text, type, payload, index: idx, link: buildButtonLink(type, payload) };
    })
    .filter(Boolean)
    .slice(0, max);
}

function buildButtonsText(body, footer, buttons) {
  let out = body ? `${body}\n\n` : "";
  buttons.forEach((b, i) => {
    let line = `${NUM_EMOJI[i] || `${i + 1}.`} ${b.text}`;
    if (b.link?.kind === "url") line += `\n     🔗 ${b.link.url}`;
    else if (b.link?.kind === "phone") line += `\n     📞 +${b.link.number}\n     💬 ${b.link.url}`;
    out += line + "\n";
  });
  out += "\n_Reply with the number or option name_";
  if (footer) out += `\n\n_${footer}_`;
  return out;
}

async function sendInteractiveButtons(sock, jid, body, footer, buttons) {
  const { generateWAMessageFromContent, proto } = baileys;
  if (typeof generateWAMessageFromContent !== "function" || !proto?.Message?.InteractiveMessage) {
    throw new Error("Interactive buttons not supported by this Baileys version");
  }
  const nfButtons = buttons.map((b) => {
    if (b.type === "url") return { name: "cta_url", buttonParamsJson: JSON.stringify({ display_text: b.text, url: b.payload || b.url, merchant_url: b.payload || b.url }) };
    if (b.type === "call" || b.type === "phone") return { name: "cta_call", buttonParamsJson: JSON.stringify({ display_text: b.text, phone_number: b.payload || b.phone }) };
    return { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: b.text.substring(0, 20), id: b.id }) };
  });

  const IM = proto.Message.InteractiveMessage;
  const interactiveMessage = IM.create({
    body: IM.Body.create({ text: body }),
    header: IM.Header.create({ title: "", subtitle: "", hasMediaAttachment: false }),
    nativeFlowMessage: IM.NativeFlowMessage.create({ buttons: nfButtons }),
    ...(footer ? { footer: IM.Footer.create({ text: footer }) } : {})
  });

  const msg = generateWAMessageFromContent(
    jid,
    { viewOnceMessage: { message: { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, interactiveMessage } } },
    { userJid: sock.user?.id }
  );

  const additionalNodes = jid.endsWith("@g.us")
    ? []
    : [{ tag: "biz", attrs: {}, content: [{ tag: "interactive", attrs: { type: "native_flow", v: "1" }, content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }] }] }];

  await sock.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes });
  return msg;
}

async function sendButtonsMessage(sock, jid, body, footer, buttons) {
  const text = body || "Please select an option:";

  if (BUTTONS_MODE === "interactive") {
    try {
      return await sendInteractiveButtons(sock, jid, text, footer, buttons);
    } catch (e) {
      console.error("⚠️ Interactive buttons failed, falling back to text menu:", e.message);
    }
  } else if (BUTTONS_MODE === "legacy") {
    const canUseLegacy = buttons.length > 0 && buttons.length <= 3 && buttons.every((b) => b.type === "reply");
    if (canUseLegacy) {
      try {
        return await sock.sendMessage(jid, {
          text,
          footer: footer || undefined,
          buttons: buttons.map((b) => ({ buttonId: b.id, buttonText: { displayText: b.text.substring(0, 20) }, type: 1 })),
          headerType: 1
        });
      } catch (e) {
        console.error("⚠️ Legacy buttons failed, falling back to text menu:", e.message);
      }
    }
  }

  return await sock.sendMessage(jid, { text: buildButtonsText(text, footer, buttons) });
}

// ---------- MEDIA & VOICE NOTE CONVERSION ----------
const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".3gp": "video/3gpp", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg", ".aac": "audio/aac", ".ogg": "audio/ogg; codecs=opus", ".opus": "audio/ogg; codecs=opus",
  ".wav": "audio/wav", ".m4a": "audio/mp4", ".webm": "audio/webm",
  ".pdf": "application/pdf", ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain", ".csv": "text/csv", ".zip": "application/zip"
};

function mediaKind(ext, url = "") {
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) return "image";
  if ([".mp4", ".3gp", ".mov", ".mkv", ".avi"].includes(ext)) return "video";
  if ([".mp3", ".aac", ".ogg", ".opus", ".wav", ".m4a", ".webm"].includes(ext)) return "audio";
  if (!ext && /image/i.test(url)) return "image";
  if (!ext && /video/i.test(url)) return "video";
  return "document";
}

function resolveMediaSource(mediaUrl) {
  if (!mediaUrl) return null;
  let clean = String(mediaUrl).trim();
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(clean)) {
    clean = clean.replace(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i, PUBLIC_BASE_URL);
  } else if (clean.startsWith("/uploads/")) {
    clean = PUBLIC_BASE_URL + clean;
  }

  let pathname = clean.split("?")[0];
  try { pathname = new URL(clean).pathname; } catch (e) {}
  try { pathname = decodeURIComponent(pathname); } catch (e) {}

  const ext = path.extname(pathname).toLowerCase();
  const fileName = path.basename(pathname) || "Attachment";
  const mimetype = MIME_BY_EXT[ext] || "application/octet-stream";

  if (pathname.includes("/uploads/")) {
    const localPath = path.join(UPLOAD_DIR, path.basename(pathname));
    try {
      if (fs.existsSync(localPath)) return { buffer: fs.readFileSync(localPath), localPath, ext, fileName, mimetype, clean };
    } catch (e) {}
  }
  return { url: clean, ext, fileName, mimetype, clean };
}

// 🔥 HELPER: CONVERT AUDIO / WEBM / OGG TO PTT (OPUS/OGG) USING FFMPEG FOR TRUE WHATSAPP VOICE NOTE
async function convertAudioToPttBuffer(inputPath) {
  const targetOggPath = path.join(UPLOAD_DIR, `ptt-${Date.now()}-${Math.round(Math.random() * 1e4)}.ogg`);
  
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat("ogg")
      .audioCodec("libopus")
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate("24k")
      .on("end", () => resolve(targetOggPath))
      .on("error", (err) => reject(err))
      .save(targetOggPath);
  });

  const buffer = fs.readFileSync(targetOggPath);
  try { fs.unlinkSync(targetOggPath); } catch (e) {}
  return buffer;
}

async function sendMediaContent(sock, jid, mediaUrl, caption = "") {
  const src = resolveMediaSource(mediaUrl);
  if (!src) return null;
  const kind = mediaKind(src.ext, src.clean);
  let data = src.buffer ? src.buffer : { url: src.url };
  let content;

  if (kind === "image") {
    content = { image: data, caption: caption || undefined };
  } else if (kind === "video") {
    content = { video: data, caption: caption || undefined };
  } else if (kind === "audio") {
    // 🔥 PTT (Voice Note) Handling with FFmpeg conversion to ensure it goes as a voice note, not a document or regular audio
    let audioBuffer = src.buffer;
    if (!audioBuffer && src.url && src.url.startsWith(PUBLIC_BASE_URL)) {
      try {
        const localRelPath = src.url.replace(PUBLIC_BASE_URL, "");
        const localAbsPath = path.join(__dirname, "..", localRelPath);
        if (fs.existsSync(localAbsPath)) {
          audioBuffer = await convertAudioToPttBuffer(localAbsPath);
        }
      } catch (err) {
        console.error("⚠️ Local audio conversion error:", err.message);
      }
    } else if (src.localPath && fs.existsSync(src.localPath)) {
      try {
        audioBuffer = await convertAudioToPttBuffer(src.localPath);
      } catch (err) {
        console.error("⚠️ Audio path conversion error:", err.message);
      }
    }

    content = {
      audio: audioBuffer ? audioBuffer : data,
      mimetype: "audio/ogg; codecs=opus",
      ptt: true // 🔥 THIS IS THE KEY FIX: Ensures WhatsApp treats it as a Voice Note!
    };
  } else {
    content = { document: data, mimetype: src.mimetype, fileName: src.fileName, caption: caption || undefined };
  }

  const sent = await sock.sendMessage(jid, content);
  markBotSent(sent?.key?.id);
  const logs = [{ id: sent?.key?.id, type: kind, text: caption || `[${kind}]`, mediaUrl }];
  if (kind === "audio" && caption) {
    const capSent = await sock.sendMessage(jid, { text: caption });
    markBotSent(capSent?.key?.id);
    logs.push({ id: capSent?.key?.id, type: "text", text: caption, mediaUrl: null });
  }
  return logs;
}

async function sendBotPayload(sock, jid, { text = "", mediaUrl = "", buttons = [], footer = "" }) {
  const logs = [];
  const body = String(text || "").trim();
  let mediaSent = false;

  if (mediaUrl) {
    try {
      const mediaLogs = await sendMediaContent(sock, jid, mediaUrl, body);
      if (mediaLogs) { logs.push(...mediaLogs); mediaSent = true; }
    } catch (e) {
      console.error("❌ Bot media send failed:", e.message);
    }
  }

  if (buttons.length > 0) {
    if (mediaSent) await sleep(500);
    const btnBody = mediaSent ? "Please select an option:" : body;
    const sent = await sendButtonsMessage(sock, jid, btnBody, footer, buttons);
    markBotSent(sent?.key?.id);
    logs.push({ id: sent?.key?.id, type: "interactive", text: btnBody || "Please select an option:", mediaUrl: null });
  } else if (!mediaSent && body) {
    const sent = await sock.sendMessage(jid, { text: footer ? `${body}\n\n_${footer}_` : body });
    markBotSent(sent?.key?.id);
    logs.push({ id: sent?.key?.id, type: "text", text: body, mediaUrl: null });
  }
  return logs;
}

async function logBotMessages(ctx, logs, prefix) {
  for (const entry of logs) {
    try {
      await new ChatMessage({
        userId: ctx.userId,
        messageId: entry.id || `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e4)}`,
        customerPhone: ctx.customerPhone,
        customerName: ctx.customerName,
        platform: "whatsapp_qr",
        sender: "me",
        isBotMessage: true,
        type: entry.type || "text",
        text: entry.text || "",
        mediaUrl: entry.mediaUrl || null,
        status: "sent"
      }).save();
    } catch (e) {
      console.error("⚠️ Bot ChatMessage log failed:", e.message);
    }
  }
}

// =========================================================================
// 🌿 VISUAL BOT FLOW ENGINE
// =========================================================================
const TRIGGER_TYPE_RE = /trigger|start|keyword/i;
const isTriggerNode = (n) => TRIGGER_TYPE_RE.test(String(n?.type || ""));
const splitKeywords = (v) => String(v || "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const containsWord = (text, kw) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(kw)}($|[^\\p{L}\\p{N}])`, "u").test(text);

function getOutgoingEdges(flow, nodeId) {
  return (flow.edges || []).filter((e) => e.source === nodeId);
}
function hasIncomingEdge(flow, nodeId) {
  return (flow.edges || []).some((e) => e.target === nodeId);
}
function handleOf(e) {
  return String(e.sourceHandle || e.handle || e.data?.sourceHandle || "").toLowerCase();
}
function pickNextNode(flow, node) {
  const edges = getOutgoingEdges(flow, node.id);
  if (!edges.length) return null;
  const edge = edges.find((e) => !handleOf(e)) || edges[0];
  return flow.nodes.find((n) => n.id === edge.target) || null;
}

function getNodeTriggerKeywords(n, flow) {
  const d = n.data || {};
  let kws = splitKeywords(d.keyword || d.trigger || d.triggerKeyword);
  if (kws.length) return kws;
  if (isTriggerNode(n)) return splitKeywords(d.label || d.text);
  if (!hasIncomingEdge(flow, n.id) && getOutgoingEdges(flow, n.id).length > 0) return splitKeywords(d.label || d.text);
  return [];
}

function findTriggerMatch(flow, cleanKeyword, sessionLevel) {
  if (!cleanKeyword) return null;
  let partial = null;
  for (const n of flow.nodes) {
    const nodeLevel = String(n.data?.level || "ANY").toUpperCase();
    if (nodeLevel !== "ANY" && nodeLevel !== sessionLevel) continue;
    const kws = getNodeTriggerKeywords(n, flow);
    if (!kws.length) continue;
    if (kws.some((kw) => cleanKeyword === kw)) return n;
    if (!partial && kws.some((kw) => containsWord(cleanKeyword, kw))) partial = n;
  }
  return partial;
}

function findButtonEdge(flow, node, btn) {
  const edges = getOutgoingEdges(flow, node.id);
  const id = btn.id.toLowerCase();
  const i = btn.index;
  return (
    edges.find((e) => {
      const h = handleOf(e);
      return h && (h === `btn_output_${i}` || h === `btn_${i}` || h === id || h.includes(`btn-${i}`) ||
        h.includes(id) || h.endsWith(`-${i}`) || h.endsWith(`_${i}`));
    }) ||
    edges.find((e) => !handleOf(e)) ||
    (edges.length === 1 ? edges[0] : null)
  );
}

function findButtonClick(flow, cleanKeyword, cleanButtonId, onlyNodeId = null) {
  for (const n of flow.nodes) {
    if (onlyNodeId && n.id !== onlyNodeId) continue;
    const btns = normalizeButtons(n.data?.buttons || n.data?.options, "flow");
    if (!btns.length) continue;
    const hit = btns.find((b) =>
      (cleanButtonId && b.id.toLowerCase() === cleanButtonId) ||
      (cleanKeyword && b.text.toLowerCase() === cleanKeyword)
    );
    if (hit) {
      const edge = findButtonEdge(flow, n, hit);
      const target = edge ? flow.nodes.find((t) => t.id === edge.target) : null;
      return { node: n, button: hit, target };
    }
  }
  return null;
}

function extractNodeContent(node) {
  const d = node.data || {};
  const mediaUrl = d.mediaUrl || d.media || d.fileUrl || d.imageUrl || d.videoUrl || d.documentUrl || "";
  const buttons = normalizeButtons(d.buttons || d.options, "flow");
  let text = d.message || d.text || d.caption || d.body || "";
  if (!text && buttons.length) text = d.title || d.label || "";
  if (!text && !mediaUrl && !isTriggerNode(node)) text = d.label || "";
  return {
    text: String(text || "").trim(),
    mediaUrl: typeof mediaUrl === "string" ? mediaUrl.trim() : "",
    buttons,
    footer: d.footer || d.footerText || ""
  };
}

async function runFlowChain(ctx, flow, startNode) {
  const { sock, exactRemoteJid, userId, customerPhone } = ctx;
  clearPending(userId, customerPhone);
  const visited = new Set();
  let node = startNode;
  let lastNode = null;
  let sentAny = false;

  while (node && !visited.has(node.id) && visited.size < 10) {
    visited.add(node.id);
    const content = extractNodeContent(node);

    if (content.text || content.mediaUrl || content.buttons.length) {
      const logs = await sendBotPayload(sock, exactRemoteJid, content);
      if (logs.length) {
        sentAny = true;
        lastNode = node;
        await logBotMessages(ctx, logs, "flow-qr");
      }
      if (content.buttons.length) {
        setPending(userId, customerPhone, { source: "flow", flowId: String(flow._id), nodeId: node.id, buttons: content.buttons });
        break;
      }
    }

    const next = pickNextNode(flow, node);
    if (next) await sleep(600);
    node = next;
  }
  return { sentAny, lastNode };
}

// =========================================================================
// 🤖 BOT REPLY (KEYWORD RULE) ENGINE - MULTI-KEYWORD & TEMPLATE SUPPORTED
// =========================================================================
async function findMatchingRule(userId, candidates, sessionLevel, opts = {}) {
  const { exactOnly = false, excludeId = null } = opts;
  const rules = await BotReply.find({
    $or: [{ userId }, { userId: { $exists: false } }, { userId: null }],
    isActive: { $ne: false }
  });

  const ruleMatches = (rule, cand) => {
    const rawKw = String(rule.keyword || "").trim().toLowerCase();
    if (!rawKw) return false;
    const keywords = rawKw.split(",").map((k) => k.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean);

    return keywords.some((keyword) => {
      switch (rule.matchType || "exact") {
        case "contains":
          return cand.includes(keyword);
        case "startsWith":
          return cand.startsWith(keyword);
        case "exact":
        default:
          return cand === keyword;
      }
    });
  };

  const isExactHit = (rule) => {
    const rawKw = String(rule.keyword || "").trim().toLowerCase();
    const keywords = rawKw.split(",").map((k) => k.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean);
    return keywords.some((kw) => candidates.some((cand) => cand === kw));
  };

  const matches = rules.filter((rule) => {
    if (excludeId && String(rule._id) === String(excludeId)) return false;
    const rawKw = String(rule.keyword || "").trim().toLowerCase();
    if (!rawKw) return false;
    const ruleLevel = String(rule.level || "ANY").toUpperCase();
    if (ruleLevel !== "ANY" && ruleLevel !== sessionLevel) return false;

    if (exactOnly || rule.matchType === "exact") {
      return candidates.some((cand) => ruleMatches(rule, cand));
    }
    return candidates.some((cand) => ruleMatches(rule, cand));
  });

  const score = (r) =>
    (isExactHit(r) ? 1000 : 0) +
    String(r.keyword || "").trim().length +
    (r.userId && String(r.userId) === String(userId) ? 0.5 : 0);
  matches.sort((a, b) => score(b) - score(a));
  return matches[0] || null;
}

async function sendRuleReply(ctx, rule) {
  const isTemplate = rule.botType === "template";
  let text = "";
  let mediaUrl = "";
  let buttons = [];
  let headerText = "";
  let footer = rule.footerText || "";

  let templateObj = null;
  const lookupIdentifier = String(rule.templateId || rule.replyText || "").trim();

  if (isTemplate || lookupIdentifier) {
    try {
      templateObj = await Template.findOne({
        userId: ctx.userId,
        $or: [
          { name: lookupIdentifier },
          { title: lookupIdentifier },
          { name: new RegExp("^" + escapeRegex(lookupIdentifier) + "$", "i") },
          { title: new RegExp("^" + escapeRegex(lookupIdentifier) + "$", "i") }
        ]
      }).lean();

      if (!templateObj && lookupIdentifier) {
        templateObj = await Template.findOne({
          $or: [
            { name: lookupIdentifier },
            { title: lookupIdentifier }
          ]
        }).lean();
      }
    } catch (err) {
      console.error("⚠️ Template database lookup error:", err.message);
    }
  }

  if (templateObj) {
    text = templateObj.content || templateObj.title || "";
    footer = templateObj.footerText || footer;
    mediaUrl = templateObj.mediaUrl || "";
    headerText = templateObj.headerText || (templateObj.headerType === "text" ? templateObj.title : "") || "";

    if (Array.isArray(templateObj.buttons)) {
      buttons = normalizeButtons(templateObj.buttons.map(b => ({
        text: b.buttonText,
        type: b.buttonType,
        payload: b.value
      })), "rule");
    }
  } else {
    text = String(rule.replyText || rule.templateId || "").trim();
    buttons = isTemplate ? [] : normalizeButtons(rule.buttons, "rule");
    mediaUrl = isTemplate ? "" : String(rule.mediaUrl || "").trim();
  }

  let finalMessageBody = text;
  if (headerText && headerText.trim() !== "") {
    finalMessageBody = `*${headerText.trim()}*\n\n${text}`;
  }

  if (!finalMessageBody && !mediaUrl && !buttons.length) {
    return false;
  }

  const logs = await sendBotPayload(ctx.sock, ctx.exactRemoteJid, { text: finalMessageBody, mediaUrl, buttons, footer });
  if (!logs.length) return false;

  clearPending(ctx.userId, ctx.customerPhone);
  if (buttons.length) {
    setPending(ctx.userId, ctx.customerPhone, { source: "rule", ruleId: String(rule._id), buttons });
  }
  await logBotMessages(ctx, logs, "bot-qr");
  return true;
}

// =========================================================================
// 🌿 UNIFIED AUTOMATION PIPELINE (Flow -> Bot Reply -> AI/Manual)
// =========================================================================
async function runAutomation(ctx, messageText, buttonPayloadId) {
  const { sock, userId, customerPhone, exactRemoteJid } = ctx;

  let cleanKeyword = messageText ? messageText.trim().toLowerCase() : "";
  let cleanButtonId = buttonPayloadId ? buttonPayloadId.trim().toLowerCase() : "";

  const sessionHasUser = !!UserSession.schema?.path?.("userId");
  const sessionQuery = sessionHasUser ? { userId, phone: customerPhone } : { phone: customerPhone };
  let userSession = await UserSession.findOne(sessionQuery);
  if (!userSession) {
    userSession = await UserSession.create({ ...sessionQuery, currentStep: "ANY" });
  }

  adoptCampaignPending(userId, customerPhone, exactRemoteJid);

  const RESET_KEYWORDS = ["menu", "hi", "hello", "start", "reset"];
  if (RESET_KEYWORDS.includes(cleanKeyword)) {
    userSession.currentStep = "ANY";
    await userSession.save();
    clearPending(userId, customerPhone);
  }

  const pending = getPending(userId, customerPhone);
  let choiceBtn = null;
  if (pending) {
    if (!cleanButtonId && /^\d{1,2}$/.test(cleanKeyword)) {
      choiceBtn = pending.buttons[Number(cleanKeyword) - 1] || null;
    } else {
      choiceBtn = pending.buttons.find((b) =>
        (cleanButtonId && b.id.toLowerCase() === cleanButtonId) || (cleanKeyword && b.text.toLowerCase() === cleanKeyword)
      ) || null;
    }
    if (choiceBtn) {
      cleanButtonId = choiceBtn.id.toLowerCase();
      cleanKeyword = choiceBtn.text.toLowerCase();
    }
  }
  const isChoice = !!choiceBtn;
  const choiceCandidates = isChoice
    ? [...new Set([choiceBtn.id, choiceBtn.payload, choiceBtn.text].map((v) => String(v || "").trim().toLowerCase()).filter(Boolean))]
    : [];
  const parentRuleId = isChoice && pending.source === "rule" ? pending.ruleId : null;

  let handled = false;
  const sessionLevel = String(userSession.currentStep || "ANY").toUpperCase();

  const sendLinkReply = async (btn) => {
    const l = btn.link;
    const text = l.kind === "url"
      ? `🔗 *${btn.text}*\n${l.url}`
      : `📞 *${btn.text}*\n+${l.number}\n💬 WhatsApp: ${l.url}`;
    const sent = await sock.sendMessage(exactRemoteJid, { text });
    markBotSent(sent?.key?.id);
    await logBotMessages(ctx, [{ id: sent?.key?.id, type: "text", text }], "link-qr");
  };

  const applyRule = async (rule) => {
    const ok = await sendRuleReply(ctx, rule);
    if (ok) {
      userSession.currentStep = String(rule.nextLevel || "ANY").toUpperCase();
      await userSession.save();
    }
    return ok;
  };

  const tryFlows = async () => {
    const activeFlows = await BotFlow.find({ userId, isActive: true });
    for (const flow of activeFlows) {
      if (!flow.nodes || flow.nodes.length === 0) continue;

      let startNode = null;
      let clickConsumed = false;

      if (pending && pending.source === "flow" && pending.flowId === String(flow._id)) {
        const click = findButtonClick(flow, cleanKeyword, cleanButtonId, pending.nodeId);
        if (click) { clickConsumed = true; startNode = click.target; }
      }
      if (clickConsumed && !startNode) continue;

      if (!startNode) {
        const matched = findTriggerMatch(flow, cleanKeyword, sessionLevel);
        if (matched) startNode = pickNextNode(flow, matched) || matched;
      }

      if (!startNode && !pending) {
        const click = findButtonClick(flow, cleanKeyword, cleanButtonId);
        if (click) startNode = click.target;
      }

      if (!startNode) continue;

      const result = await runFlowChain(ctx, flow, startNode);
      if (result.sentAny) {
        const d = result.lastNode?.data || {};
        userSession.currentStep = String(d.nextLevel || d.level || "ANY").toUpperCase();
        await userSession.save();
        return true;
      }
    }
    return false;
  };

  if (isChoice && choiceBtn.link && choiceBtn.type !== "reply") {
    await sendLinkReply(choiceBtn);
    handled = true;
  } else if (isChoice && pending.source === "campaign") {
    const exactRule = await findMatchingRule(userId, choiceCandidates, sessionLevel, { exactOnly: true });
    if (exactRule) handled = await applyRule(exactRule);
    if (!handled) {
      const looseRule = await findMatchingRule(userId, choiceCandidates, sessionLevel);
      if (looseRule) handled = await applyRule(looseRule);
    }
  } else if (!isChoice && cleanButtonId.startsWith("camp_")) {
    const cands = [cleanKeyword, cleanButtonId].filter(Boolean);
    const exactRule = await findMatchingRule(userId, cands, sessionLevel, { exactOnly: true });
    if (exactRule) handled = await applyRule(exactRule);
    if (!handled) {
      const looseRule = await findMatchingRule(userId, cands, sessionLevel);
      if (looseRule) handled = await applyRule(looseRule);
    }
  } else if (isChoice && pending.source === "rule") {
    const exactRule = await findMatchingRule(userId, choiceCandidates, sessionLevel, { exactOnly: true, excludeId: parentRuleId });
    if (exactRule) handled = await applyRule(exactRule);
    if (!handled) handled = await tryFlows();
    if (!handled) {
      const looseRule = await findMatchingRule(userId, choiceCandidates, sessionLevel, { excludeId: parentRuleId });
      if (looseRule) handled = await applyRule(looseRule);
    }
  } else {
    handled = await tryFlows();
    if (!handled) {
      const candidates = [cleanKeyword, cleanButtonId].filter(Boolean);
      const rule = await findMatchingRule(userId, candidates, sessionLevel);
      if (rule) handled = await applyRule(rule);
    }
  }

  if (!handled && isChoice && choiceBtn.link) {
    await sendLinkReply(choiceBtn);
    handled = true;
  }

  if (!handled) {
    let finalReplyText = await processAiBotResponse(userId, customerPhone, messageText);
    if (!finalReplyText) {
      finalReplyText = await handleManualFunctionExecution(userId, customerPhone, cleanKeyword, userSession);
    }
    if (finalReplyText) {
      const sent = await sock.sendMessage(exactRemoteJid, { text: finalReplyText });
      markBotSent(sent?.key?.id);
      clearPending(userId, customerPhone);
      await logBotMessages(ctx, [{ id: sent?.key?.id, type: "text", text: finalReplyText }], "ai-qr");
    }
  }
}

// =========================================================================
// 📥 INBOUND MESSAGE HANDLER
// =========================================================================
function extractIncoming(rawMessage) {
  let msgContent = rawMessage;
  try {
    if (typeof normalizeMessageContent === "function") msgContent = normalizeMessageContent(rawMessage) || rawMessage;
    else msgContent = rawMessage.ephemeralMessage?.message || rawMessage.viewOnceMessage?.message || rawMessage;
  } catch (e) {}

  let messageText = "";
  let messageType = "text";
  let buttonPayloadId = "";

  if (msgContent.conversation) {
    messageText = msgContent.conversation;
  } else if (msgContent.extendedTextMessage?.text) {
    messageText = msgContent.extendedTextMessage.text;
  } else if (msgContent.buttonsResponseMessage) {
    messageText = msgContent.buttonsResponseMessage.selectedDisplayText || msgContent.buttonsResponseMessage.selectedButtonText || "";
    buttonPayloadId = msgContent.buttonsResponseMessage.selectedButtonId || "";
  } else if (msgContent.templateButtonReplyMessage) {
    messageText = msgContent.templateButtonReplyMessage.selectedDisplayText || "";
    buttonPayloadId = msgContent.templateButtonReplyMessage.selectedId || "";
  } else if (msgContent.listResponseMessage) {
    messageText = msgContent.listResponseMessage.title || "";
    buttonPayloadId = msgContent.listResponseMessage.singleSelectReply?.selectedRowId || "";
  } else if (msgContent.interactiveResponseMessage) {
    const ir = msgContent.interactiveResponseMessage;
    messageText = ir.body?.text || "";
    try {
      const p = JSON.parse(ir.nativeFlowResponseMessage?.paramsJson || "{}");
      buttonPayloadId = p.id || p.selectedId || "";
      if (!messageText) messageText = p.display_text || p.title || "";
    } catch (e) {}
  } else if (msgContent.imageMessage) {
    messageText = msgContent.imageMessage.caption || "[Image Attachment]";
    messageType = "image";
  } else if (msgContent.videoMessage) {
    messageText = msgContent.videoMessage.caption || "[Video Attachment]";
    messageType = "video";
  } else if (msgContent.audioMessage) {
    messageText = "[Voice Note]";
    messageType = msgContent.audioMessage.ptt ? "voice" : "audio";
  } else if (msgContent.documentMessage) {
    messageText = msgContent.documentMessage.caption || msgContent.documentMessage.fileName || "[Document]";
    messageType = "document";
  } else {
    messageText = "[Interactive Message]";
  }
  return { msgContent, messageText, messageType, buttonPayloadId };
}

async function handleInboundMessage(sock, userId, msg) {
  if (!msg.message) return;

  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid.includes("@g.us") || remoteJid === "status@broadcast" || remoteJid.includes("broadcast")) return;

  const resolvedInfo = await resolveCleanCustomerPhone(sock, remoteJid, msg.key.participant);
  if (!resolvedInfo) return;

  const customerPhone = resolvedInfo.displayPhone;
  const exactRemoteJid = resolvedInfo.remoteJid;

  const myNumber = sock.user?.id ? sock.user.id.split(":")[0] : "";
  if (myNumber && customerPhone === myNumber) return;

  const messageId = msg.key.id;
  const isFromMe = msg.key.fromMe;

  const { msgContent, messageText, messageType, buttonPayloadId } = extractIncoming(msg.message);
  if (msgContent.protocolMessage || msgContent.reactionMessage || msgContent.senderKeyDistributionMessage) return;

  if (isFromMe && botSentIds.has(messageId)) return;

  const existingMsg = await ChatMessage.findOne({ userId, messageId });
  if (existingMsg) return;

  if (isFromMe) {
    let dbContact = await Contact.findOne({ userId, phone: customerPhone });
    if (!dbContact) {
      dbContact = await Contact.create({
        userId, name: customerPhone, phone: customerPhone, phoneNumber: customerPhone,
        remoteJid: exactRemoteJid, platform: "whatsapp", group: "All", status: "ACTIVE"
      });
    } else if (!dbContact.remoteJid) {
      dbContact.remoteJid = exactRemoteJid;
      await dbContact.save();
    }

    await new ChatMessage({
      userId, messageId, customerPhone, customerName: dbContact?.name || customerPhone,
      platform: "whatsapp_qr", sender: "me", type: messageType, text: messageText, status: "sent", isBotMessage: false
    }).save();
    return;
  }

  const profileName = msg.pushName || customerPhone;

  let dbContact = await Contact.findOne({ userId, phone: customerPhone });
  if (!dbContact) {
    const dpUrl = await fetchUserProfilePicture(sock, remoteJid);
    dbContact = await Contact.create({
      userId, name: profileName, phone: customerPhone, phoneNumber: customerPhone,
      remoteJid: exactRemoteJid, profilePicUrl: dpUrl, platform: "whatsapp", group: "All", status: "ACTIVE", unreadCount: 1
    });
  } else {
    await Contact.findOneAndUpdate(
      { _id: dbContact._id },
      { $set: { remoteJid: dbContact.remoteJid || exactRemoteJid }, $inc: { unreadCount: 1, unread_count: 1 } }
    );
  }

  await new ChatMessage({
    userId, messageId, customerPhone, customerName: dbContact?.name || profileName,
    platform: "whatsapp_qr", sender: "them", type: messageType, text: messageText, status: "unread"
  }).save();

  const lastAgentMsg = await ChatMessage.findOne({
    userId, customerPhone, sender: "me",
    $or: [{ isBotMessage: false }, { isBotMessage: { $exists: false } }]
  }).sort({ createdAt: -1, timestamp: -1 });

  if (lastAgentMsg) {
    const lastAgentTime = new Date(lastAgentMsg.createdAt || lastAgentMsg.timestamp).getTime();
    if ((Date.now() - lastAgentTime) / 60000 < 10) {
      return;
    }
  }

  await runAutomation(
    { sock, userId, customerPhone, exactRemoteJid, customerName: dbContact?.name || profileName },
    messageText,
    buttonPayloadId
  );
}

// =========================================================================
// 🔌 SESSION START
// =========================================================================
const startWhatsAppSession = async (userId) => {
    try {
        const authFolderName = `./auth_info_baileys_${userId}`;
        const { state, saveCreds } = await useMultiFileAuthState(authFolderName);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" })
        });

        activeSessions[userId] = sock;

        sock.ev.on("contacts.upsert", (contacts) => {
            for (const contact of contacts) {
                if (contact.id && contact.lid) {
                    const phone = contact.id.split("@")[0].replace(/\D/g, "");
                    const lid = contact.lid.split("@")[0];
                    if (phone && phone.length >= 7) {
                        lidToPhoneMap[lid] = phone;
                        lidToPhoneMap[contact.lid] = contact.id;
                    }
                }
            }
        });

        sock.ev.on("connection.update", async (update) => {
            try {
                const { connection, qr } = update;
                const isObjectId = mongoose.Types.ObjectId.isValid(userId);
                const userCond = [{ userId: userId }, { userId: String(userId) }];
                if (isObjectId) userCond.push({ userId: new mongoose.Types.ObjectId(userId) });

                if (qr) {
                    const qrBase64 = await qrcode.toDataURL(qr);
                    qrCodesCache[userId] = qrBase64;
                    let existingConfig = await WhatsAppConfig.findOne({ $or: userCond, platform: "whatsapp_qr" }).lean();
                    const verifyToken = existingConfig?.webhookVerifyToken || generateVerifyToken();

                    await WhatsAppConfig.findOneAndUpdate(
                        { $or: userCond, platform: "whatsapp_qr" },
                        { $set: { status: "SCAN_REQUIRED", qrCode: qrBase64, webhookVerifyToken: verifyToken }, $setOnInsert: { userId, platform: "whatsapp_qr" } },
                        { upsert: true }
                    );
                }

                if (connection === "open") {
                    qrCodesCache[userId] = null;
                    const userNumber = sock.user?.id ? sock.user.id.split(":")[0] : "";

                    await WhatsAppConfig.findOneAndUpdate(
                        { $or: userCond, platform: "whatsapp_qr" },
                        { $set: { status: "CONNECTED", qrCode: null, phoneNumber: userNumber, accessToken: "ACTIVE_SESSION" } },
                        { upsert: true }
                    );
                }

                if (connection === "close") {
                    const shouldReconnect = update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                    if (shouldReconnect) {
                        setTimeout(() => startWhatsAppSession(userId), 3000);
                    } else {
                        await WhatsAppConfig.findOneAndUpdate({ $or: userCond, platform: "whatsapp_qr" }, { $set: { status: "DISCONNECTED", qrCode: null } });
                        delete activeSessions[userId];
                    }
                }
            } catch (err) {
                console.error("❌ connection.update error:", err.message);
            }
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") return;
            for (const msg of messages) {
                try {
                    await handleInboundMessage(sock, userId, msg);
                } catch (err) {
                    console.error("❌ [QR] Inbound message processing error:", err);
                }
            }
        });

        return sock;
    } catch (error) {
        console.error("Baileys Session Error:", error);
    }
};

// =========================================================================
// 📣 CAMPAIGN (QR) RICH SENDER
// =========================================================================
const CAMPAIGN_BTN_TYPE_MAP = {
  quick_reply: "reply", reply: "reply", copy_code: "reply",
  url: "url", link: "url", cta_url: "url",
  phone_number: "call", phone: "call", call: "call", cta_call: "call"
};

function phoneKeyVariants(...values) {
  const out = new Set();
  values.forEach((v) => {
    const raw = String(v || "").split("@")[0].split(":")[0].trim();
    if (!raw) return;
    out.add(raw);
    const d = raw.replace(/\D/g, "");
    if (!d) return;
    out.add(d);
    if (d.startsWith("92") && d.length === 12) out.add("0" + d.slice(2));
    if (d.startsWith("0") && d.length === 11) out.add("92" + d.slice(1));
    if (d.startsWith("9203") && d.length === 12) out.add("92" + d.slice(3));
  });
  return [...out];
}

function adoptCampaignPending(userId, customerPhone, remoteJid) {
  const keys = phoneKeyVariants(customerPhone, remoteJid);
  let found = null;
  for (const k of keys) {
    const p = getPending(userId, k);
    if (p && p.source === "campaign") { found = p; break; }
  }
  if (!found) return;
  keys.forEach((k) => { const p = getPending(userId, k); if (p && p.source === "campaign") clearPending(userId, k); });
  setPending(userId, customerPhone, { source: "campaign", buttons: found.buttons });
}

function prepareCampaignButtons(raw) {
  if (!Array.isArray(raw)) return [];
  const mapped = raw.map((btn, idx) => {
    const id = `camp_${idx}`;
    if (typeof btn === "string") return btn.trim() ? { id, text: btn.trim(), type: "reply", payload: btn.trim() } : null;
    if (!btn || typeof btn !== "object") return null;
    const text = String(btn.text || btn.title || btn.label || btn.display_text || btn.displayText || btn.buttonText || btn.name || btn.caption || "").trim();
    if (!text) return null;
    const value = String(
      btn.value ?? btn.payload ?? btn.url ?? btn.link ?? btn.website ?? btn.website_url ?? btn.href ??
      btn.phone ?? btn.phoneNumber ?? btn.phone_number ?? btn.number ?? ""
    ).trim();
    const rawType = String(btn.buttonType || btn.type || btn.sub_type || btn.subType || "").toLowerCase();
    let type = CAMPAIGN_BTN_TYPE_MAP[rawType];
    if (!type) type = (btn.url || btn.link || btn.website || btn.website_url || btn.href) ? "url" : (btn.phone || btn.phoneNumber || btn.phone_number || btn.number) ? "call" : "reply";
    if (type === "url") {
      if (!value) {
        return { id, text, type: "reply", payload: text };
      }
      return { id, text, type, url: value };
    }
    if (type === "call") return { id, text, type, phone: value };
    return { id, text, type: "reply", payload: text };
  }).filter(Boolean);
  return normalizeButtons(mapped, "flow");
}

const CAMPAIGN_BUTTONS_MODE = String(process.env.CAMPAIGN_BUTTONS_MODE || BUTTONS_MODE || "text").toLowerCase();

async function sendCampaignButtons(sock, jid, body, footer, buttons) {
  const text = body || "Please select an option:";
  if (CAMPAIGN_BUTTONS_MODE === "interactive") {
    try {
      const sent = await sendInteractiveButtons(sock, jid, text, footer, buttons);
      return sent;
    } catch (e) {}
  }
  return await sock.sendMessage(jid, { text: buildButtonsText(text, footer, buttons) });
}

async function sendCampaignRichMessage(sock, jid, { header = "", text = "", footer = "", mediaUrl = "", buttons = [] }) {
  const head = String(header || "").trim();
  const body = String(text || "").trim();
  const foot = String(footer || "").trim();
  const composed = [head ? `*${head}*` : "", body].filter(Boolean).join("\n\n");
  const logs = [];

  let mediaSent = false;
  let captionUsed = false;

  if (mediaUrl) {
    const captionFull = (!buttons.length && foot) ? [composed, `_${foot}_`].filter(Boolean).join("\n\n") : composed;
    const fitsCaption = captionFull.length <= 1000;
    const mediaLogs = await sendMediaContent(sock, jid, mediaUrl, fitsCaption ? captionFull : "");
    if (!mediaLogs) throw new Error("Campaign media could not be resolved");
    logs.push(...mediaLogs);
    mediaSent = true;
    captionUsed = fitsCaption && !!captionFull;
  }

  if (buttons.length > 0) {
    if (mediaSent) await sleep(600);
    const btnBody = (mediaSent && captionUsed) ? "Please choose an option 👇" : (composed || "Please select an option:");
    const sent = await sendCampaignButtons(sock, jid, btnBody, foot, buttons);
    markBotSent(sent?.key?.id);
    logs.push({ id: sent?.key?.id, type: "interactive", text: btnBody, mediaUrl: null });
  } else if (!captionUsed && composed) {
    const finalText = foot ? `${composed}\n\n_${foot}_` : composed;
    const sent = await sock.sendMessage(jid, { text: finalText });
    markBotSent(sent?.key?.id);
    logs.push({ id: sent?.key?.id, type: "text", text: finalText, mediaUrl: null });
  } else if (!mediaSent && !composed) {
    throw new Error("Campaign message is empty");
  }
  return logs;
}

const sendQrWhatsAppMessage = async (userId, to, messageText, options = {}) => {
    try {
        let sock = getActiveSocket(userId);
        if (!sock) return { success: false, message: "Socket not found" };

        let cleanTo = String(to || "").replace(/\D/g, "").trim();
        let targetJid = phoneToRemoteJidMap[cleanTo] || phoneToRemoteJidMap[to];

        if (!targetJid) {
            try {
                const foundContact = await Contact.findOne({
                    $or: [{ phone: cleanTo }, { phoneNumber: cleanTo }, { phone: to }, { remoteJid: to }]
                }).lean();
                if (foundContact && foundContact.remoteJid) {
                    targetJid = foundContact.remoteJid;
                }
            } catch (err) {}
        }

        if (!targetJid) {
            let formattedPhone = cleanTo;
            if (formattedPhone.startsWith("9203") && formattedPhone.length === 12) {
                formattedPhone = "92" + formattedPhone.substring(3);
            } else if (formattedPhone.startsWith("03") && formattedPhone.length === 11) {
                formattedPhone = "92" + formattedPhone.substring(1);
            }
            targetJid = `${formattedPhone}@s.whatsapp.net`;
            try {
                const [result] = await sock.onWhatsApp(formattedPhone);
                if (result && result.exists) targetJid = result.jid;
            } catch (err) {}
        }

        const richButtons = prepareCampaignButtons(options?.buttons);
        const isRich = Boolean(options?.isCampaign || options?.header || options?.footer || richButtons.length || options?.isTemplate || options?.templateId || options?.templateBody);
        
        if (isRich) {
            const logs = await sendCampaignRichMessage(sock, targetJid, {
                header: options.header || options.templateTitle || "",
                text: messageText || options.body || options.templateBody || "",
                footer: options.footer || "",
                mediaUrl: options.mediaUrl || options.headerMediaUrl || "",
                buttons: richButtons
            });
            if (richButtons.length) {
                phoneKeyVariants(cleanTo, to, targetJid).forEach((ph) => setPending(userId, ph, { source: "campaign", buttons: richButtons }));
            }
            const ids = logs.map((l) => ({ id: l.id })).filter((m) => m.id);
            return { success: true, engine: "QR_BAILEYS", messages: ids.length ? ids : [{ id: `qr-${Date.now()}` }] };
        }

        let sentResult;
        if (options?.mediaUrl) {
            const logs = await sendMediaContent(sock, targetJid, options.mediaUrl, messageText || "");
            sentResult = { key: { id: logs?.[0]?.id } };
        } else {
            sentResult = await sock.sendMessage(targetJid, { text: messageText });
        }
        return { success: true, engine: "QR_BAILEYS", messages: [{ id: sentResult?.key?.id || `qr-${Date.now()}` }] };
    } catch (err) {
        console.error("❌ QR Send Error:", err.message);
        return { success: false, error: err.message };
    }
};

const getQrCode = (userId) => qrCodesCache[userId] || null;
const getActiveSocket = (userId) => {
    if (!userId) return null;
    return activeSessions[userId] || activeSessions[String(userId)] || null;
};
const removeSession = (userId) => {
    if (activeSessions[userId]) delete activeSessions[userId];
    if (qrCodesCache[userId]) qrCodesCache[userId] = null;
};

module.exports = { startWhatsAppSession, getQrCode, getActiveSocket, removeSession, sendQrWhatsAppMessage };