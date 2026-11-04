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
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://api.promiapi.com";
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

// 🖼️ Profile picture: WhatsApp's own picture link (pps.whatsapp.net) is signed and EXPIRES within hours/days,
// so saving only that link made every DP vanish from the chat list later. We now download the image once,
// keep it in /uploads (dp-<phone>.jpg) and store that permanent path. If the download fails we fall back to
// the live link so nothing is lost.
const fetchUserProfilePicture = async (sock, jid, phoneHint = "") => {
    // Customers are often identified by a LID (xxxx@lid). WhatsApp refuses the picture lookup for LIDs,
    // so we also try the plain phone JID, and the small "preview" size when the full image is not allowed.
    const digits = String(phoneHint || String(jid || "").split("@")[0].split(":")[0]).replace(/\D/g, "");
    const candidates = [];
    if (jid) candidates.push(jid);
    if (digits.length >= 7 && digits.length <= 15) {
        const phoneJid = `${digits}@s.whatsapp.net`;
        if (!candidates.includes(phoneJid)) candidates.push(phoneJid);
    }

    let ppUrl = null;
    const reasons = [];
    for (const candidate of candidates) {
        for (const size of ["image", "preview"]) {
            try {
                const url = await sock.profilePictureUrl(candidate, size, 8000);
                if (url) { ppUrl = url; break; }
            } catch (err) {
                reasons.push(`${candidate}/${size}: ${err?.message || err}`);
            }
        }
        if (ppUrl) break;
    }

    if (!ppUrl) {
        console.log(`🖼️ [DP] ${digits || jid}: no picture available (${reasons[0] || "none returned"})`);
        return null;
    }

    try {
        if (!digits) return ppUrl;
        const resp = await axios.get(ppUrl, { responseType: "arraybuffer", timeout: 10000, maxContentLength: 5 * 1024 * 1024 });
        const buf = Buffer.from(resp.data);
        if (!buf.length) return ppUrl;
        if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const fileName = `dp-${digits}.jpg`;
        fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buf);
        console.log(`🖼️ [DP] ${digits}: saved /uploads/${fileName}`);
        return `/uploads/${fileName}`;
    } catch (dlErr) {
        console.warn(`⚠️ [DP] ${digits}: download failed, keeping remote link:`, dlErr.message);
        return ppUrl;
    }
};

// Retry throttle: customers who hide their photo must not cost one WhatsApp lookup per incoming message
const dpLastTry = new Map();
const DP_RETRY_MS = 60 * 60 * 1000;
function shouldRefreshDp(userId, phone, contact) {
    const current = contact && contact.profilePicUrl;
    const needs = !current || /^https?:/i.test(String(current)); // missing, or old expiring remote link
    if (!needs) return false;
    const key = `${userId}:${phone}`;
    const last = dpLastTry.get(key) || 0;
    if (Date.now() - last < DP_RETRY_MS) return false;
    dpLastTry.set(key, Date.now());
    return true;
}

// 🖼️ Background backfill: after the QR session connects, give a DP to the contacts that already exist but have none
// (or still hold an old expiring link). Paced and capped so WhatsApp is never flooded.
const dpBackfillRunning = new Set();
async function backfillMissingDps(sock, userId) {
    const key = String(userId);
    if (dpBackfillRunning.has(key)) return;
    dpBackfillRunning.add(key);
    try {
        const missing = await Contact.find({
            $and: [
                { $or: [{ userId: userId }, { adminId: userId }] },
                { platform: "whatsapp" },
                { status: { $ne: "INVALID" } },
                { phone: { $nin: [null, ""] } },
                { $or: [{ profilePicUrl: null }, { profilePicUrl: "" }, { profilePicUrl: { $exists: false } }, { profilePicUrl: /^https?:/i }] }
            ]
        }).select("_id phone profilePicUrl").limit(150).lean();

        console.log(`🖼️ [DP] backfill started for ${missing.length} contact(s) without a permanent DP`);
        let saved = 0;
        for (const c of missing) {
            if (!activeSessions[userId]) break; // session closed meanwhile
            const digits = String(c.phone || "").replace(/\D/g, "");
            if (!digits || !shouldRefreshDp(userId, digits, c)) continue;
            const dp = await fetchUserProfilePicture(sock, `${digits}@s.whatsapp.net`, digits);
            if (dp) {
                await Contact.updateOne({ _id: c._id }, { $set: { profilePicUrl: dp } });
                saved++;
            }
            await new Promise((r) => setTimeout(r, 2000));
        }
        console.log(`🖼️ [DP] backfill finished: ${saved} DP(s) saved`);
    } finally {
        dpBackfillRunning.delete(key);
    }
}

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
// 🔒 AI SUBSCRIPTION / TOGGLE CHECK  (same rules as the Official Cloud API webhook)
// =========================================================================
async function verifyUserAiSubscription(userId) {
  if (!userId) return false;
  try {
    const settings = await AiBotSettings.findOne({ userId }).lean();
    if (settings) {
      // ✅ No separate AI subscription in this system: the user just saves an API key and turns the AI toggle ON.
      // (The old QR check ignored the toggle, which is why the AI never replied on QR.)
      if (settings.openai?.enabled === true || settings.groq?.enabled === true) {
        return true;
      }
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
    console.error("⚠️ [QR] Subscription Verification Error:", err?.message);
  }
  console.log(`⛔ [QR AI SKIP] AI toggle is OFF (or no AiBotSettings saved) for user=${userId} - turn the AI toggle ON in the dashboard and save the API key.`);
  return false;
}

// ⏰ Operating hours (dashboard "Timing" setting) - AI replies only inside this window
function isWithinOperatingHours(timing) {
  if (!timing || !timing.enabled) return true;
  if (!timing.startTime || !timing.endTime) return true;
  try {
    const tz = timing.timezone || "UTC";
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
    const hour = parts.find((p) => p.type === "hour").value;
    const minute = parts.find((p) => p.type === "minute").value;
    const now = `${hour === "24" ? "00" : hour}:${minute}`;
    return now >= timing.startTime && now <= timing.endTime;
  } catch (e) {
    console.error("⚠️ [QR] Timezone Evaluation Error:", e.message);
    return true;
  }
}

// ⏱ HUMAN-LIKE REPLY DELAY (dashboard "Simulated Typing Delay", seconds). Counts from the moment the customer's
// message arrived, so it is a MINIMUM wait: if the AI already took 3s and the delay is 2s, we send immediately.
async function waitReplyDelay(settings, startedAt) {
  const sec = Number(settings?.advanced?.responseDelay) || 0;
  if (sec <= 0) return;
  const remaining = sec * 1000 - (Date.now() - (startedAt || Date.now()));
  if (remaining > 0) {
    console.log(`⏱ [QR REPLY DELAY] waiting ${(remaining / 1000).toFixed(1)}s (setting=${sec}s)`);
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

function formatToInternationalPhone(phoneStr) {
  if (!phoneStr) return null;
  let cleaned = String(phoneStr).replace(/\D/g, "");
  if (cleaned.startsWith("9203") && cleaned.length === 12) {
    cleaned = "92" + cleaned.substring(3);
  } else if (cleaned.startsWith("03") && cleaned.length === 11) {
    cleaned = "92" + cleaned.substring(1);
  }
  return cleaned;
}

// =========================================================================
// 🔌 EXTERNAL CBS & TOOL EXECUTION ENGINE (same as webhook)
// =========================================================================
async function fetchExternalCBSData(functionName, args, customerPhone, settings) {
  try {
    console.log(`🌐 [QR TOOL EXECUTION] Function: ${functionName} | Customer: ${customerPhone}`);

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
        { functionName, customerPhone, parameters: args },
        { headers: { Authorization: `Bearer ${apiSecretKey}`, "Content-Type": "application/json" }, timeout: 10000 }
      );
      return response.data;
    }

    // No external banking system configured: never invent balances / transactions for a real customer.
    return { status: "unavailable", message: "This service is not available right now." };
  } catch (err) {
    console.error("❌ [QR] External Server Tool Execution Error:", err.response?.data || err.message);
    return { error: "Failed to connect to external system server." };
  }
}

async function handleManualFunctionExecution(targetUserId, customerPhone, cleanKeyword, userSession) {
  try {
    const settings = await AiBotSettings.findOne({ userId: targetUserId });

    let functionName = null;
    const text = String(cleanKeyword || "").toLowerCase();

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
      if (data && data.status !== "unavailable") {
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
    console.error("❌ [QR] Manual Function Execution Error:", err.message);
  }
  return null;
}

// =========================================================================
// 🤖 GROQ AI ENGINE FOR QR (same engine, prompt rules and tools as the Cloud API webhook; replaces OpenAI)
// =========================================================================
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// Override anytime with GROQ_MODEL in .env
const GROQ_DEFAULT_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GROQ_RETIRED_MODELS = {
  "llama3-70b-8192": "openai/gpt-oss-120b",
  "llama3-8b-8192": "openai/gpt-oss-20b",
  "llama-3.1-70b-versatile": "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile": "openai/gpt-oss-120b",
  "llama-3.1-8b-instant": "openai/gpt-oss-20b",
  "mixtral-8x7b-32768": "openai/gpt-oss-120b"
};

function resolveGroqModel(settings) {
  const requested = String(settings?.groq?.model || settings?.openai?.model || settings?.aiModel || "").trim();
  if (!requested) return GROQ_DEFAULT_MODEL;
  if (GROQ_RETIRED_MODELS[requested]) {
    console.warn(`⚠️ [QR GROQ] Model "${requested}" is retired on Groq -> using "${GROQ_RETIRED_MODELS[requested]}"`);
    return GROQ_RETIRED_MODELS[requested];
  }
  // Old OpenAI model names saved in the panel (gpt-4o-mini etc.) do not exist on Groq
  if (/^(gpt-|chatgpt|o1|o3|o4)/i.test(requested)) {
    console.warn(`⚠️ [QR GROQ] "${requested}" is an OpenAI model name, not valid on Groq -> using "${GROQ_DEFAULT_MODEL}"`);
    return GROQ_DEFAULT_MODEL;
  }
  return requested;
}

function resolveGroqApiKey(settings) {
  const candidates = [
    settings?.groq?.apiKey,
    settings?.openai?.apiKey,
    settings?.openaiApiKey,
    settings?.groqApiKey,
    process.env.GROQ_API_KEY
  ];
  for (const c of candidates) {
    const key = String(c || "").replace(/^["']|["']$/g, "").trim();
    if (key) return key;
  }
  return null;
}

function buildGroqTools(settings) {
  const noParams = { type: "object", properties: {}, required: [] };
  const tools = [
    { type: "function", function: { name: "get_customer_orders_status", description: "Fetch real-time order status, courier tracking, and details from database for this customer.", parameters: noParams } }
  ];
  // Banking tools only when a real external CBS API is configured
  const hasExternalApi = Boolean(settings?.externalApi?.baseUrl || process.env.EXTERNAL_CBS_API_URL);
  if (hasExternalApi) {
    tools.push(
      { type: "function", function: { name: "get_bank_account_balance", description: "Fetch customer bank account balance, account number, and status from CBS.", parameters: noParams } },
      { type: "function", function: { name: "get_transaction_history", description: "Fetch recent transaction history for customer bank account.", parameters: noParams } },
      { type: "function", function: { name: "block_credit_card", description: "Block lost or stolen credit or debit card immediately.", parameters: noParams } },
      { type: "function", function: { name: "request_cheque_book", description: "Order a new cheque book delivery for customer account.", parameters: noParams } },
      { type: "function", function: { name: "apply_for_personal_loan", description: "Check personal loan eligibility and initiate new loan application.", parameters: noParams } },
      { type: "function", function: { name: "get_forex_rates", description: "Get current live foreign exchange rates for currencies.", parameters: noParams } }
    );
  }
  return tools;
}

// WhatsApp rejects very long text bodies. Keep a safe margin.
const WA_MAX_REPLY_CHARS = 3800;
function clampForWhatsApp(text) {
  const s = String(text || "").trim();
  if (s.length <= WA_MAX_REPLY_CHARS) return s;
  const slice = s.slice(0, WA_MAX_REPLY_CHARS);
  const cut = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(". "), slice.lastIndexOf("۔"));
  return (cut > WA_MAX_REPLY_CHARS * 0.6 ? slice.slice(0, cut + 1) : slice).trim();
}

async function runGroqChat(userId, customerPhone, userText, settings, apiKey) {
  const model = resolveGroqModel(settings);
  const temperature = settings.groq?.temperature ?? settings.openai?.temperature ?? 0.7;
  const systemPrompt = settings.groq?.systemPrompt || settings.openai?.systemPrompt || "You are a helpful customer support assistant on WhatsApp. Reply briefly and clearly in the customer's language.";

  const waRules = "\n\nIMPORTANT RULES (WhatsApp channel):\n1. Answer ONLY what the customer asked in their latest message. Do NOT add extra details, other services, features or integrations they did not ask about.\n2. Never write one big paragraph. Use short lines separated by blank lines. For how-to questions use a numbered list (maximum 6 steps, one short line each). For other questions use 2-4 short sentences. Stay under 900 characters.\n3. If the question is broad (for example 'tell me your services' or 'details'), give a ONE-line overview and ask which specific thing they want to know more about.\n4. Do not repeat information that was already given earlier in the chat.\n5. Plain text only: no markdown tables, no # headings. Use *single asterisks* for bold, and '1.' or '-' for lists.\n6. Reply in the same language and script the customer writes in.\n7. Tone: polite, professional and friendly. Use at most one emoji. End with one short line offering further help.";
  const messages = [{ role: "system", content: systemPrompt + waRules }];

  // ChatMessage has NO createdAt field (only `timestamp`): sort by timestamp to get the most RECENT messages.
  const chatHistory = await ChatMessage.find({ userId, customerPhone }).sort({ timestamp: -1, _id: -1 }).limit(12).lean();
  const history = chatHistory.reverse()
    .map((m) => ({ role: m.sender === "me" ? "assistant" : "user", content: typeof m.text === "string" ? m.text.trim() : "" }))
    .filter((m) => m.content); // Groq rejects empty message content

  // The incoming message is usually already saved in DB -> avoid sending it twice
  const lastHist = history[history.length - 1];
  if (lastHist && lastHist.role === "user" && lastHist.content === String(userText || "").trim()) history.pop();
  messages.push(...history);
  messages.push({ role: "user", content: String(userText || "").trim() || "Hello" });

  let tools = buildGroqTools(settings);
  console.log(`🤖 [QR GROQ] Calling model=${model} | user=${userId} | customer=${customerPhone} | history=${history.length} | tools=${tools.length}`);

  for (let round = 0; round < 3; round++) {
    const body = { model, messages, temperature: Math.min(temperature, 0.5), max_tokens: 700 };
    if (/gpt-oss/i.test(model)) body.reasoning_effort = "low"; // less hidden "thinking" tokens, faster replies
    if (tools.length) { body.tools = tools; body.tool_choice = "auto"; }

    let aiRes;
    try {
      aiRes = await axios.post(GROQ_API_URL, body, {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: 30000
      });
    } catch (err) {
      // Some Groq models occasionally fail tool-calling (400) -> retry once without tools
      if (err.response?.status === 400 && tools.length) {
        console.warn("⚠️ [QR GROQ] 400 with tools, retrying without tools:", JSON.stringify(err.response?.data));
        tools = [];
        continue;
      }
      console.error(`❌ [QR GROQ] Request failed | status=${err.response?.status || "no-response"} |`, JSON.stringify(err.response?.data) || err.message);
      return null;
    }

    const msg = aiRes.data?.choices?.[0]?.message;
    if (!msg) { console.error("❌ [QR GROQ] Empty response:", JSON.stringify(aiRes.data)); return null; }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || "{}"); } catch (_) {}
        const result = await fetchExternalCBSData(call.function.name, args, customerPhone, settings);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }

    const content = typeof msg.content === "string"
      ? msg.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
      : "";
    if (content) {
      console.log(`✅ [QR GROQ] Reply generated (${content.length} chars)`);
      return clampForWhatsApp(content);
    }
    console.warn("⚠️ [QR GROQ] Model returned empty content");
    return null;
  }
  return null;
}

async function processAiBotResponse(userId, customerPhone, userText) {
  try {
    const isSubscribed = await verifyUserAiSubscription(userId);
    if (!isSubscribed) return null;

    const settings = await AiBotSettings.findOne({ userId });
    if (!settings) {
      console.log(`⛔ [QR AI SKIP] No AiBotSettings document for user=${userId}`);
      return null;
    }

    if (!isWithinOperatingHours(settings.timing)) {
      console.log(`⛔ [QR AI SKIP] Outside operating hours for user=${userId}`);
      return null;
    }

    // (the "Simulated Typing Delay" is applied right before sending, see waitReplyDelay)

    if (settings.flowise?.enabled && settings.flowise?.apiUrl) {
      try {
        const flowiseRes = await axios.post(
          settings.flowise.apiUrl,
          { question: userText },
          { timeout: 30000 }
        );
        const text = flowiseRes.data?.text || flowiseRes.data?.textResponse || flowiseRes.data;
        if (typeof text === "string" && text.trim()) {
          return text.trim();
        }
      } catch (fErr) {
        console.error("❌ [QR] Flowise Request Failed:", fErr.message);
      }
    }

    const aiEnabled = settings.openai?.enabled === true || settings.groq?.enabled === true;
    const apiKey = resolveGroqApiKey(settings);

    if (!aiEnabled) {
      console.log(`⛔ [QR AI SKIP] AI toggle is OFF in settings (openai.enabled / groq.enabled) for user=${userId}`);
    } else if (!apiKey) {
      console.log(`⛔ [QR AI SKIP] No Groq API key found (checked groq.apiKey, openai.apiKey, openaiApiKey, GROQ_API_KEY env) for user=${userId}`);
    } else {
      const reply = await runGroqChat(userId, customerPhone, userText, settings, apiKey);
      if (reply) return reply;
    }

    if (settings.general?.failedMessage) {
      return settings.general.failedMessage;
    }

    return null;
  } catch (err) {
    console.error("❌ [QR] AI Bot Engine Execution Crash:", err.message);
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
  if (footer) out += `_${footer}_\n\n`;
  buttons.forEach((b, i) => {
    let line = `${NUM_EMOJI[i] || `${i + 1}.`} ${b.text}`;
    if (b.link?.kind === "url") line += `\n     🔗 ${b.link.url}`;
    else if (b.link?.kind === "phone") line += `\n     📞 +${b.link.number}\n     💬 ${b.link.url}`;
    out += line + "\n";
  });
  out += "\n_Reply with the number or option name_";
  return out;
}

async function sendInteractiveButtons(sock, jid, body, footer, buttons, headerMedia = null) {
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
    header: headerMedia
      ? IM.Header.create({ title: "", subtitle: "", hasMediaAttachment: true, ...headerMedia })
      : IM.Header.create({ title: "", subtitle: "", hasMediaAttachment: false }),
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
  // relative values like "uploads/x.jpg" or just "x.jpg" -> make them "/uploads/x.jpg"
  if (!/^https?:\/\//i.test(clean) && !clean.startsWith("/")) {
    clean = /^uploads\//i.test(clean) ? "/" + clean : "/uploads/" + clean;
  }
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
    const base = path.basename(pathname);
    const dirs = [UPLOAD_DIR, path.join(process.cwd(), "uploads")];
    for (const dir of dirs) {
      const localPath = path.join(dir, base);
      try {
        if (fs.existsSync(localPath)) return { buffer: fs.readFileSync(localPath), localPath, ext, fileName, mimetype, clean };
      } catch (e) {}
    }
    console.warn(`⚠️ [QR BOT] media file "${base}" not found in ${dirs.join(" | ")} - will try to download ${clean}`);
  }
  return { url: clean, ext, fileName, mimetype, clean };
}

// Always hand Baileys a real Buffer. If the file is not on this server's disk we download it ourselves,
// so a failure shows up here with a clear reason (404 / timeout / wrong host) instead of silently inside Baileys.
async function loadMediaData(src) {
  if (src.buffer) return src.buffer;
  if (!/^https?:\/\//i.test(src.url || "")) {
    throw new Error(`Media path is not a valid URL and the file is not on disk: "${src.url}"`);
  }
  try {
    const r = await axios.get(src.url, { responseType: "arraybuffer", timeout: 20000, maxContentLength: 100 * 1024 * 1024 });
    return Buffer.from(r.data);
  } catch (e) {
    const status = e.response?.status ? `HTTP ${e.response.status}` : e.code || e.message;
    throw new Error(`Media download failed (${status}) from ${src.url}`);
  }
}

// 🔥 HELPER: CONVERT AUDIO / WEBM / OGG TO PTT (OPUS/OGG) USING FFMPEG FOR TRUE WHATSAPP VOICE NOTE
async function convertAudioToPttBuffer(inputPath) {
  const targetOggPath = path.join(UPLOAD_DIR, `ptt-${Date.now()}-${Math.round(Math.random() * 1e4)}.ogg`);
  
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      // Same duration fix as chatRoutes.js: rebuild continuous timestamps so the .ogg is not stretched
      .inputOptions(["-fflags +genpts"])
      .noVideo()
      .audioFilters("aresample=16000,asetpts=N/SR/TB")
      .toFormat("ogg")
      .audioCodec("libopus")
      .audioChannels(1)
      .audioBitrate("24k")
      .outputOptions(["-map_metadata -1"])
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
  const data = kind === "audio" ? null : await loadMediaData(src);
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

    if (!audioBuffer) {
      // Conversion did not happen. Sending the raw file with an ogg/opus mimetype makes WhatsApp show
      // "audio format wrong", so fail loudly instead of sending a broken voice note.
      throw new Error("Voice note could not be converted to OGG/OPUS (check ffmpeg + libopus)");
    }
    content = {
      audio: audioBuffer,
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

// Native-button messages with a media HEADER are accepted by WhatsApp but the picture is often silently dropped
// (text + buttons arrive, the image does not). So by default media + buttons go as ONE media message whose caption
// carries the text + options (the picture is guaranteed). Set BAILEYS_MEDIA_HEADER_BUTTONS=true to try the
// native-button-with-header variant instead.
const MEDIA_HEADER_INTERACTIVE = String(process.env.BAILEYS_MEDIA_HEADER_BUTTONS || "false").toLowerCase() === "true";
// "split"  = media + text as one message, then REAL native buttons (footer sits above the buttons) as a 2nd message
// "single" = everything in one media message, options as a numbered text list
// "auto"   = split when BAILEYS_BUTTONS_MODE=interactive, single otherwise
const MEDIA_BUTTONS_LAYOUT = String(process.env.BAILEYS_MEDIA_BUTTONS_LAYOUT || "auto").toLowerCase();
console.log(`⚙️ [QR BOT] media+buttons layout = ${MEDIA_BUTTONS_LAYOUT} | buttons mode = ${BUTTONS_MODE} | media-header interactive = ${MEDIA_HEADER_INTERACTIVE} | PUBLIC_BASE_URL = ${PUBLIC_BASE_URL} | UPLOAD_DIR = ${UPLOAD_DIR}`);

// 📦 ONE MESSAGE: media on top, text below it, buttons / options at the bottom.
// Before, the media (with the text as caption) and the buttons went as two separate messages.
//  - interactive mode: native-flow message with the image/video/document as its header (single message)
//  - text / legacy mode: a single media message whose caption holds the text + the numbered options + links
// Returns the log entries, or null when it cannot be combined (voice note, caption too long...) so the caller
// can fall back to the old two-step sending.
async function sendMediaWithButtons(sock, jid, { text = "", mediaUrl = "", buttons = [], footer = "", mode = BUTTONS_MODE }) {
  const src = resolveMediaSource(mediaUrl);
  if (!src) return null;
  const kind = mediaKind(src.ext, src.clean);
  if (kind === "audio") return null; // a voice note cannot carry a caption or buttons

  const body = String(text || "").trim() || "Please select an option:";
  const data = await loadMediaData(src);

  if (MEDIA_HEADER_INTERACTIVE && mode === "interactive" && ["image", "video", "document"].includes(kind)) {
    try {
      if (typeof baileys.prepareWAMessageMedia === "function") {
        const mediaInput = kind === "image" ? { image: data }
          : kind === "video" ? { video: data }
          : { document: data, mimetype: src.mimetype, fileName: src.fileName };
        const prepared = await baileys.prepareWAMessageMedia(mediaInput, { upload: sock.waUploadToServer });
        const sentInteractive = await sendInteractiveButtons(sock, jid, body, footer, buttons, prepared);
        markBotSent(sentInteractive?.key?.id);
        return [{ id: sentInteractive?.key?.id, type: "interactive", text: body, mediaUrl }];
      }
    } catch (e) {
      console.error("⚠️ Interactive media+buttons failed, using single media message instead:", e.message);
    }
  }

  const caption = buildButtonsText(body, footer, buttons);
  if (caption.length > 1000) return null; // WhatsApp caption limit -> caller falls back to two messages

  let content;
  if (kind === "image") content = { image: data, caption };
  else if (kind === "video") content = { video: data, caption };
  else content = { document: data, mimetype: src.mimetype, fileName: src.fileName, caption };

  const sent = await sock.sendMessage(jid, content);
  markBotSent(sent?.key?.id);
  console.log(`📦 [QR] ${kind} + text + ${buttons.length} option(s) sent as ONE message`);
  return [{ id: sent?.key?.id, type: kind, text: caption, mediaUrl }];
}

async function sendBotPayload(sock, jid, { text = "", mediaUrl = "", buttons = [], footer = "" }) {
  const logs = [];
  const body = String(text || "").trim();
  let mediaSent = false;

  // media + buttons => single message only when the layout asks for it (text menu); otherwise media first, then real buttons
  const singleMessage = MEDIA_BUTTONS_LAYOUT === "single"
    || (MEDIA_BUTTONS_LAYOUT !== "split" && (BUTTONS_MODE === "text" || MEDIA_HEADER_INTERACTIVE));
  if (mediaUrl && buttons.length > 0 && singleMessage) {
    try {
      const combinedLogs = await sendMediaWithButtons(sock, jid, { text: body, mediaUrl, buttons, footer });
      if (combinedLogs) return combinedLogs;
    } catch (e) {
      console.error("⚠️ Single-message media+buttons failed, falling back to two messages:", mediaUrl, "->", e.message);
    }
  }

  if (mediaUrl) {
    try {
      const mediaLogs = await sendMediaContent(sock, jid, mediaUrl, body);
      if (mediaLogs) { logs.push(...mediaLogs); mediaSent = true; }
    } catch (e) {
      console.error("❌ Bot media send failed:", mediaUrl, "->", e.message);
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

async function logBotMessages(ctx, logs, prefix, origin = null) {
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
        ...(origin ? { origin } : {}),
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
      await waitReplyDelay(ctx.settings, ctx.startedAt);
      const logs = await sendBotPayload(sock, exactRemoteJid, content);
      if (logs.length) {
        sentAny = true;
        lastNode = node;
        await logBotMessages(ctx, logs, "flow-qr", "auto_reply");
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

  console.log(`🤖 [QR BOT] rule ${rule._id} type=${rule.botType} template=${templateObj ? "yes" : "no"} mediaUrl=${mediaUrl || "(EMPTY)"} buttons=${buttons.length}`);
  await waitReplyDelay(ctx.settings, ctx.startedAt);
  const logs = await sendBotPayload(ctx.sock, ctx.exactRemoteJid, { text: finalMessageBody, mediaUrl, buttons, footer });
  if (!logs.length) return false;

  clearPending(ctx.userId, ctx.customerPhone);
  if (buttons.length) {
    setPending(ctx.userId, ctx.customerPhone, { source: "rule", ruleId: String(rule._id), buttons });
  }
  await logBotMessages(ctx, logs, "bot-qr", "auto_reply");
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
    await waitReplyDelay(ctx.settings, ctx.startedAt);
    const sent = await sock.sendMessage(exactRemoteJid, { text });
    markBotSent(sent?.key?.id);
    await logBotMessages(ctx, [{ id: sent?.key?.id, type: "text", text }], "link-qr", "auto_reply");
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
    console.log(`ℹ️ [QR BOT] no visual-flow / rule reply sent for "${cleanKeyword}" - trying AI / manual functions.`);
    let replyOrigin = "auto_reply";
    let finalReplyText = await processAiBotResponse(userId, customerPhone, messageText);
    if (finalReplyText) replyOrigin = "ai_reply";
    if (!finalReplyText) {
      finalReplyText = await handleManualFunctionExecution(userId, customerPhone, cleanKeyword, userSession);
    }
    if (finalReplyText) {
      await waitReplyDelay(ctx.settings, ctx.startedAt);
      const sent = await sock.sendMessage(exactRemoteJid, { text: finalReplyText });
      markBotSent(sent?.key?.id);
      clearPending(userId, customerPhone);
      await logBotMessages(ctx, [{ id: sent?.key?.id, type: "text", text: finalReplyText }], "ai-qr", replyOrigin);
    }
  }
}

// =========================================================================
// 📥 INBOUND MESSAGE HANDLER
// =========================================================================
// 👤 Read name + phone numbers out of a vCard string (contact shared by the customer)
function parseVcardLite(vcard) {
  const text = String(vcard || "");
  const fn = (text.match(/^FN[^:\n]*:(.+)$/im) || [])[1];
  const n = (text.match(/^N[^:\n]*:(.+)$/im) || [])[1];
  const name = (fn || (n ? n.replace(/;+/g, " ") : "") || "").trim();
  const phones = [];
  const re = /^(?:item\d+\.)?TEL[^:\n]*:(.+)$/gim;
  let m;
  while ((m = re.exec(text)) !== null) phones.push(m[1].trim());
  return { name, phones };
}

function extractIncoming(rawMessage) {
  let msgContent = rawMessage;
  try {
    if (typeof normalizeMessageContent === "function") msgContent = normalizeMessageContent(rawMessage) || rawMessage;
    else msgContent = rawMessage.ephemeralMessage?.message || rawMessage.viewOnceMessage?.message || rawMessage;
  } catch (e) {}

  let messageText = "";
  let messageType = "text";
  let buttonPayloadId = "";
  let extra = {}; // extra fields stored with the message (location / contacts / fileName)

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
    if (msgContent.documentMessage.fileName) extra.fileName = msgContent.documentMessage.fileName;
  } else if (msgContent.stickerMessage) {
    messageText = "[Sticker]";
    messageType = "image";
  } else if (msgContent.ptvMessage) {
    messageText = "[Video Attachment]";
    messageType = "video";
  } else if (msgContent.locationMessage || msgContent.liveLocationMessage) {
    // 📍 Location / Live location shared by the customer
    const l = msgContent.locationMessage || msgContent.liveLocationMessage;
    const isLive = Boolean(msgContent.liveLocationMessage);
    const lat = Number(l.degreesLatitude);
    const lng = Number(l.degreesLongitude);
    const name = l.name || l.caption || "";
    const address = l.address || "";
    const mapUrl = `https://www.google.com/maps?q=${lat},${lng}`;
    messageText = [isLive ? "📍 Live location" : "📍 Location", name, address, mapUrl].filter(Boolean).join("\n");
    messageType = "location";
    extra.location = { latitude: lat, longitude: lng, name, address, isLive, url: mapUrl };
  } else if (msgContent.contactMessage || msgContent.contactsArrayMessage) {
    // 👤 Contact card(s) shared by the customer
    const list = msgContent.contactMessage ? [msgContent.contactMessage] : (msgContent.contactsArrayMessage.contacts || []);
    const cards = list.map((c) => {
      const parsed = parseVcardLite(c.vcard);
      return { name: c.displayName || parsed.name || "Contact", phones: parsed.phones, vcard: c.vcard || "" };
    });
    // the raw vCard is kept in the text too, so the website can still draw the card even if the DB schema drops extra fields
    messageText = list.map((c) => c.vcard).filter(Boolean).join("\n") || cards.map((c) => `👤 ${c.name}`).join("\n") || "[Contact]";
    messageType = "contacts";
    extra.contacts = cards;
  } else {
    messageText = "[Interactive Message]";
  }
  return { msgContent, messageText, messageType, buttonPayloadId, extra };
}

// 📥 INCOMING MEDIA (QR / Baileys): download the voice note / image / video / document from WhatsApp,
//    save it in /uploads and return its relative URL. Without this the message was stored as plain
//    text ("[Voice Note]") with no mediaUrl, so the website had nothing to play.
function extFromMime(mime = "", fallbackName = "") {
  const m = String(mime).toLowerCase().split(";")[0].trim();
  const map = {
    "audio/ogg": ".ogg", "audio/opus": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/aac": ".aac",
    "audio/amr": ".amr", "audio/webm": ".webm", "audio/wav": ".wav", "audio/x-wav": ".wav",
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
    "video/mp4": ".mp4", "video/3gpp": ".3gp", "video/quicktime": ".mov", "video/webm": ".webm",
    "application/pdf": ".pdf", "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "text/plain": ".txt"
  };
  if (map[m]) return map[m];
  const fromName = path.extname(String(fallbackName || "")).toLowerCase();
  return fromName || ".bin";
}

async function saveInboundMedia(sock, msg, msgContent, messageType) {
  try {
    const node = msgContent.audioMessage || msgContent.imageMessage || msgContent.videoMessage || msgContent.ptvMessage || msgContent.stickerMessage || msgContent.documentMessage;
    if (!node) return null;

    const buffer = await baileys.downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage }
    );
    if (!buffer || !buffer.length) return null;

    // WhatsApp voice notes are OGG/OPUS. Force .ogg so the browser <audio> tag gets the right type.
    const ext = (messageType === "voice" || messageType === "audio") && /ogg|opus/i.test(node.mimetype || "")
      ? ".ogg"
      : extFromMime(node.mimetype, node.fileName);

    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const fileName = `wa-in-${messageType}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buffer);
    return `/uploads/${fileName}`;
  } catch (err) {
    console.error(`❌ [QR] Incoming ${messageType} download failed:`, err.message);
    return null;
  }
}

// 💾 Save an incoming message. If the schema rejects a newer type ("location" / "contacts"), store it as text:
//    the text already carries the map link / vCard, so the website can still render it.
async function saveChatMessageSafe(doc) {
  try {
    return await new ChatMessage(doc).save();
  } catch (err) {
    if (err && err.name === "ValidationError" && doc.type && doc.type !== "text") {
      console.warn(`⚠️ ChatMessage type "${doc.type}" rejected by schema, saving as text:`, err.message);
      return await new ChatMessage({ ...doc, type: "text" }).save();
    }
    throw err;
  }
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

  const { msgContent, messageText, messageType, buttonPayloadId, extra } = extractIncoming(msg.message);
  if (msgContent.protocolMessage || msgContent.reactionMessage || msgContent.senderKeyDistributionMessage) return;

  if (isFromMe && botSentIds.has(messageId)) return;

  const existingMsg = await ChatMessage.findOne({ userId, messageId });
  if (existingMsg) return;

  // 📥 Download incoming voice / image / video / document so the website can actually play / show it
  let inboundMediaUrl = null;
  if (["voice", "audio", "image", "video", "document"].includes(messageType)) {
    inboundMediaUrl = await saveInboundMedia(sock, msg, msgContent, messageType);
  }

  if (isFromMe) {
    let dbContact = await Contact.findOne({ userId, phone: customerPhone });
    if (!dbContact) {
      const dpUrlOut = await fetchUserProfilePicture(sock, remoteJid, customerPhone);
      dbContact = await Contact.create({
        userId, name: customerPhone, phone: customerPhone, phoneNumber: customerPhone,
        remoteJid: exactRemoteJid, profilePicUrl: dpUrlOut, platform: "whatsapp", group: "All", status: "ACTIVE"
      });
    } else {
      const patch = {};
      if (!dbContact.remoteJid) patch.remoteJid = exactRemoteJid;
      if (shouldRefreshDp(userId, customerPhone, dbContact)) {
        const dpFresh = await fetchUserProfilePicture(sock, remoteJid, customerPhone);
        if (dpFresh) patch.profilePicUrl = dpFresh;
      }
      if (Object.keys(patch).length) await Contact.findOneAndUpdate({ _id: dbContact._id }, { $set: patch });
    }

    await saveChatMessageSafe({
      userId, messageId, customerPhone, customerName: dbContact?.name || customerPhone,
      platform: "whatsapp_qr", sender: "me", type: messageType, text: messageText, status: "sent", isBotMessage: false,
      ...(inboundMediaUrl ? { mediaUrl: inboundMediaUrl } : {}),
      ...extra
    });
    return;
  }

  const profileName = msg.pushName || customerPhone;

  let dbContact = await Contact.findOne({ userId, phone: customerPhone });
  if (!dbContact) {
    const dpUrl = await fetchUserProfilePicture(sock, remoteJid, customerPhone);
    dbContact = await Contact.create({
      userId, name: profileName, phone: customerPhone, phoneNumber: customerPhone,
      remoteJid: exactRemoteJid, profilePicUrl: dpUrl, platform: "whatsapp", group: "All", status: "ACTIVE", unreadCount: 1
    });
  } else {
    const setOnExisting = { remoteJid: dbContact.remoteJid || exactRemoteJid };
    if (shouldRefreshDp(userId, customerPhone, dbContact)) {
      const dpFresh = await fetchUserProfilePicture(sock, remoteJid, customerPhone);
      if (dpFresh) setOnExisting.profilePicUrl = dpFresh;
    }
    await Contact.findOneAndUpdate(
      { _id: dbContact._id },
      { $set: setOnExisting, $inc: { unreadCount: 1, unread_count: 1 } }
    );
  }

  // Who owns this chat right now ("human" = handed over to an agent). Read BEFORE saving the new message.
  const prevLatestMsg = await ChatMessage.findOne({ userId, customerPhone }).sort({ timestamp: -1, _id: -1 }).select("assignedTo").lean();
  const currentAssignedContext = prevLatestMsg ? prevLatestMsg.assignedTo : null;
  const botStartedAt = Date.now(); // the reply-delay setting counts from here

  await saveChatMessageSafe({
    userId, messageId, customerPhone, customerName: dbContact?.name || profileName,
    platform: "whatsapp_qr", sender: "them", type: messageType, text: messageText, status: "unread",
    ...(currentAssignedContext ? { assignedTo: currentAssignedContext } : {}),
    ...(inboundMediaUrl ? { mediaUrl: inboundMediaUrl } : {}),
    ...extra
  });

  const lastAgentMsg = await ChatMessage.findOne({
    userId, customerPhone, sender: "me",
    $or: [{ isBotMessage: false }, { isBotMessage: { $exists: false } }]
  }).sort({ createdAt: -1, timestamp: -1 });

  if (lastAgentMsg) {
    const lastAgentTime = new Date(lastAgentMsg.createdAt || lastAgentMsg.timestamp).getTime();
    const COOLDOWN_MIN = Number(process.env.BOT_AGENT_COOLDOWN_MINUTES ?? 10);
    if (COOLDOWN_MIN > 0 && (Date.now() - lastAgentTime) / 60000 < COOLDOWN_MIN) {
      console.log(`⏸️ [QR BOT PAUSED] An agent/panel message was sent recently to ${customerPhone} (cool-down ${COOLDOWN_MIN} min) - bot will not reply. Set BOT_AGENT_COOLDOWN_MINUTES=0 to disable.`);
      return;
    }
  }

  // A shared location / contact card is not a typed command: never run keyword, handover or bot logic on it
  const isShareOnly = messageType === "location" || messageType === "contacts";
  const cleanKeyword = (!isShareOnly && messageText) ? messageText.trim().toLowerCase() : "";
  const cleanButtonId = buttonPayloadId ? String(buttonPayloadId).trim().toLowerCase() : "";
  if (!cleanKeyword && !cleanButtonId) return;

  // 🚫 Unsubscribe / blocked contacts (same as the Cloud API)
  let contactStatus = dbContact?.status;
  if (cleanKeyword === "stop" || cleanKeyword === "unsubscribe") {
    await Contact.updateOne({ _id: dbContact._id }, { $set: { status: "UNSUBSCRIBED" } });
    contactStatus = "UNSUBSCRIBED";
  }
  if (contactStatus === "UNSUBSCRIBED" || contactStatus === "BLOCKED") {
    console.log(`🚫 [QR BOT SKIPPED] ${customerPhone} is ${contactStatus}`);
    return;
  }

  const botSettings = await AiBotSettings.findOne({ userId }).lean();

  // 🙋 Hand over to a human: agent keyword in the message, or the chat is already with a human
  const defaultHandoverKeywords = ["human", "agent", "representative", "support", "talk to human", "person", "admin"];
  let handoverKeywords = [...defaultHandoverKeywords];
  if (botSettings?.advanced?.handoverKeyword) {
    handoverKeywords = handoverKeywords.concat(String(botSettings.advanced.handoverKeyword).split(",").map((k) => k.trim().toLowerCase()));
  }
  const isHandoverTriggered = handoverKeywords.some((kw) => kw && containsWord(cleanKeyword, kw));

  if (isHandoverTriggered || currentAssignedContext === "human" || contactStatus === "ASSIGNED") {
    console.log(`🙋 [QR BOT HANDED TO HUMAN] ${customerPhone} | keyword="${cleanKeyword}" | keywordHit=${isHandoverTriggered} | assignedTo=${currentAssignedContext} | contactStatus=${contactStatus}`);
    await Contact.updateOne({ _id: dbContact._id }, { $set: { assignedTo: "human", status: "PENDING_AGENT" } });
    await ChatMessage.updateOne({ userId, messageId }, { $set: { assignedTo: "human" } });
    return;
  }

  // "typing..." while the bot works (only when a bot reply is likely)
  let typingShown = false;
  try {
    const activeFlowCount = await BotFlow.countDocuments({ userId, isActive: true });
    const botMayReply = activeFlowCount > 0 || botSettings?.openai?.enabled === true || botSettings?.groq?.enabled === true || botSettings?.flowise?.enabled === true;
    if (botMayReply) {
      await sock.sendPresenceUpdate("composing", exactRemoteJid);
      typingShown = true;
    }
  } catch (e) { /* typing indicator is best-effort */ }

  try {
    await runAutomation(
      { sock, userId, customerPhone, exactRemoteJid, customerName: dbContact?.name || profileName, settings: botSettings, startedAt: botStartedAt },
      messageText,
      buttonPayloadId
    );
  } finally {
    if (typingShown) {
      try { await sock.sendPresenceUpdate("paused", exactRemoteJid); } catch (e) { /* ignore */ }
    }
  }
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

                    // existing contacts without a DP: fill them in the background (does not block the connection)
                    setTimeout(() => {
                        backfillMissingDps(sock, userId).catch((e) => console.warn("⚠️ [DP] backfill error:", e.message));
                    }, 20000);
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

  // media + buttons => a single message (media, text and options together)
  if (mediaUrl && buttons.length > 0) {
    try {
      const combinedLogs = await sendMediaWithButtons(sock, jid, { text: composed, mediaUrl, buttons, footer: foot, mode: CAMPAIGN_BUTTONS_MODE });
      if (combinedLogs) return combinedLogs;
    } catch (e) {
      console.error("⚠️ Single-message campaign media+buttons failed, falling back to two messages:", e.message);
    }
  }

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

module.exports = { startWhatsAppSession, getQrCode, getActiveSocket, removeSession, sendQrWhatsAppMessage, fetchUserProfilePicture };