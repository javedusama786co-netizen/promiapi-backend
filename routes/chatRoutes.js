const express = require("express");
const router = express.Router();
const axios = require("axios");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const FormData = require("form-data");
const ChatMessage = require("../models/ChatMessage");
const QuickReply = require("../models/QuickReply");
const Contact = require("../models/Contact");
const TeamMember = require("../models/TeamMember");
const AgentActivity = require("../models/AgentActivity");
const authMiddleware = require("../middleware/auth");

// ⚡ Centralized Baileys Service Import
const { getActiveSocket, startWhatsAppSession } = require("../routes/whatsappBaileysService");

// 📞 Call Log Model Reference for Admin Call Monitoring & Recordings
const CallLog = mongoose.models.CallLog || mongoose.model("CallLog", new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  callId: { type: String, required: true, unique: true },
  customerPhone: { type: String, required: true },
  assignedAgentId: { type: String, default: null },
  direction: { type: String, enum: ["inbound", "outbound"], default: "inbound" },
  status: { type: String, default: "initiated" },
  duration: { type: Number, default: 0 },
  recordingUrl: { type: String, default: null }
}, { timestamps: true }));

// Helper function to build multi-tenant query filter
const getAdminQueryFilter = (businessScopeId) => [
  { userId: businessScopeId },
  { adminId: businessScopeId }
];

// Base URL configuration for live public access
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.BACKEND_URL || process.env.SERVER_URL || "https://api.promiapi.com";

// In-memory store for tenant assignment modes
const tenantAssignmentModes = new Map();

// Timezone helpers for Agent Activity tracking
const APP_TZ = process.env.APP_TIMEZONE || "Asia/Karachi";
const zonedParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23"
});
const readZoned = (date = new Date()) => {
  const p = {};
  for (const { type, value } of zonedParts.formatToParts(date)) p[type] = value;
  return p;
};
const getDayKey = (date = new Date()) => {
  const p = readZoned(date);
  return `${p.year}-${p.month}-${p.day}`;
};
const getHour = (date = new Date()) => Number(readZoned(date).hour) % 24;

const recordAgentActivity = async (memberId, adminId, { messages = 0, minutes = 0, chats = 0 }) => {
  try {
    if (!mongoose.isValidObjectId(memberId)) return;
    const now = new Date();
    const day = getDayKey(now);
    const hour = getHour(now);

    const inc = {};
    if (messages) {
      inc.messagesSent = messages;
      inc[`hours.${hour}.messages`] = messages;
    }
    if (minutes) {
      inc.activeMinutes = minutes;
      inc[`hours.${hour}.minutes`] = minutes;
    }
    if (chats) {
      inc.chatsHandled = chats;
      inc[`hours.${hour}.chats`] = chats;
    }

    const update = { $setOnInsert: { adminId } };
    if (Object.keys(inc).length) update.$inc = inc;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await AgentActivity.findOneAndUpdate({ memberId, day }, update, { upsert: true });
        break;
      } catch (err) {
        if (err.code !== 11000 || attempt === 1) throw err;
      }
    }

    const memberUpdate = { $set: { "metrics.lastActiveAt": now } };
    const memberInc = {};
    if (messages) memberInc["metrics.totalMessagesSent"] = messages;
    if (minutes) memberInc["metrics.totalActiveTimeMinutes"] = minutes;
    if (chats) memberInc["metrics.chatsHandled"] = chats;
    if (Object.keys(memberInc).length) memberUpdate.$inc = memberInc;

    await TeamMember.findByIdAndUpdate(memberId, memberUpdate);
  } catch (err) {
    console.error("❌ Failed to record agent activity from chat:", err.message);
  }
};

// Dynamic FFmpeg setup for Windows / Linux
if (process.platform === "win32") {
  try {
    ffmpeg.setFfmpegPath("C:\\ffmpeg\\bin\\ffmpeg.exe");
    ffmpeg.setFfprobePath("C:\\ffmpeg\\bin\\ffprobe.exe");
  } catch (e) {}
}

// Multer Storage Configuration
if (!fs.existsSync("uploads/")) {
  fs.mkdirSync("uploads/", { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// ☁️ Cloudflare R2: Render's disk is wiped on every restart. Files that multer / ffmpeg write into ./uploads
// (the sender still needs them on disk first) are copied to R2 under the SAME "/uploads/<name>" path, so the
// stored URLs keep working after a restart (server serves "/uploads/*" from R2 when the file is not on disk).
let r2 = { R2_ENABLED: false };
try {
  r2 = require("../middleware/upload");
} catch (e) {
  console.warn("⚠️ [R2] ../middleware/upload could not be loaded, using local /uploads only:", e.message);
}
const UPLOAD_MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".3gp": "video/3gpp", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".aac": "audio/aac", ".m4a": "audio/mp4", ".wav": "audio/wav", ".webm": "audio/webm", ".amr": "audio/amr",
  ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};
/** urlOrFile: "/uploads/<file>" (or a full URL to it) or just "<file>"; copies ./uploads/<file> to R2 */
async function mirrorUploadToR2(urlOrFile, contentType) {
  if (!r2.R2_ENABLED || typeof r2.putLocalFile !== "function" || !urlOrFile) return false;
  try {
    let p = String(urlOrFile).split("?")[0];
    try { p = new URL(p).pathname; } catch (e) {}
    const fileName = path.basename(decodeURIComponent(p));
    const local = path.join("uploads", fileName);
    if (!fs.existsSync(local)) return false;
    const ct = contentType || UPLOAD_MIME_BY_EXT[path.extname(fileName).toLowerCase()] || "application/octet-stream";
    await r2.putLocalFile(local, `uploads/${fileName}`, ct);
    console.log(`☁️ [R2] saved uploads/${fileName}`);
    return true;
  } catch (e) {
    console.error("⚠️ [R2] could not copy upload to R2:", e.message);
    return false;
  }
}
async function readUploadFromR2(link) {
  if (!r2.R2_ENABLED || typeof r2.getObjectBuffer !== "function" || typeof r2.keyFromUrl !== "function") return null;
  try {
    const key = r2.keyFromUrl(link);
    if (!key) return null;
    return await r2.getObjectBuffer(key);
  } catch (e) {
    console.warn(`⚠️ [R2] could not read ${link} from R2: ${e.message}`);
    return null;
  }
}

function getMediaType(ext, mimeType) {
  const extension = ext ? ext.toLowerCase() : "";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(extension) || mimeType?.includes("image")) {
    return "image";
  }
  if ([".mp4", ".mov", ".avi", ".mkv", ".3gp"].includes(extension) || mimeType?.includes("video")) {
    return "video";
  }
  if ([".mp3", ".ogg", ".wav", ".aac", ".m4a", ".webm", ".opus"].includes(extension) || mimeType?.includes("audio")) {
    return "audio";
  }
  return "document";
}

// 🎙️ Convert any recorded audio (webm / mp4 / wav / mp3 / ogg) to a REAL WhatsApp voice-note file:
//    OGG container + OPUS codec + MONO.  (Meta: "base audio/ogg not supported, OPUS only, mono only")
function convertToWhatsAppVoice(inputPath) {
  return new Promise((resolve, reject) => {
    const outName = `voice-${Date.now()}-${Math.round(Math.random() * 1e9)}.ogg`;
    const outPath = path.join("uploads/", outName);
    ffmpeg(inputPath)
      // 🔧 DURATION FIX: browser MediaRecorder .webm has no duration header and can carry timestamp
      //    jumps. ffmpeg copied those jumps into the .ogg, so a 3-4s note became a 1-2 min file
      //    (voice at the start, then silence). genpts + asetpts=N/SR/TB rebuilds continuous
      //    timestamps from the real sample count, so the output length == the real audio length.
      .inputOptions(["-fflags +genpts"])
      .noVideo()
      .audioFilters("aresample=16000,asetpts=N/SR/TB")   // 16 kHz, same as WhatsApp's own voice notes
      .audioCodec("libopus")
      .audioChannels(1)
      .audioBitrate("24k")
      // NOTE: do NOT add "-application voip" / "-vbr on": files made with them play on
      // WhatsApp Web but fail on the mobile app ("audio not available").  Verified by A/B test.
      .outputOptions(["-map_metadata -1"])
      .toFormat("ogg")
      .on("end", () => {
        // Verify the output really is opus + mono before we ever send it
        ffmpeg.ffprobe(outPath, (probeErr, info) => {
          if (probeErr) {
            console.warn("⚠️ ffprobe unavailable, skipping verification:", probeErr.message);
            return resolve({ outPath, outName, seconds: 1 });
          }
          const a = (info.streams || []).find((st) => st.codec_type === "audio");
          if (!a || a.codec_name !== "opus" || Number(a.channels) !== 1) {
            return reject(new Error(`Converted file is not mono opus (got ${a?.codec_name}/${a?.channels}ch)`));
          }
          console.log(`🎙️ Voice converted: ${outName} codec=${a.codec_name} ch=${a.channels} dur=${info.format?.duration}s size=${info.format?.size}B`);
          resolve({ outPath, outName, seconds: Math.max(1, Math.round(Number(info.format?.duration) || 1)) });
        });
      })
      .on("error", (err) => reject(err))
      .save(outPath);
  });
}

// 📊 Build a 64-bar waveform (values 0-100) so WhatsApp (QR/Baileys) draws the voice-note graph
function buildVoiceWaveform(filePath, bars = 64) {
  return new Promise((resolve) => {
    const chunks = [];
    const proc = ffmpeg(filePath).noVideo().audioChannels(1).audioFrequency(8000).format("s8");
    const stream = proc.on("error", () => resolve(undefined)).pipe();
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => {
      try {
        const buf = Buffer.concat(chunks);
        if (!buf.length) return resolve(undefined);
        const block = Math.max(1, Math.floor(buf.length / bars));
        const raw = [];
        for (let i = 0; i < bars; i++) {
          let sum = 0, n = 0;
          for (let j = i * block; j < Math.min(buf.length, (i + 1) * block); j++) {
            sum += Math.abs(buf.readInt8(j)); n++;
          }
          raw.push(n ? sum / n : 0);
        }
        const max = Math.max(...raw, 1);
        resolve(new Uint8Array(raw.map((v) => Math.min(100, Math.round((v / max) * 100)))));
      } catch (e) { resolve(undefined); }
    });
  });
}

// ☁️ Upload the .ogg to Meta /media and return media id.
//    - whole file is sent from a Buffer (known Content-Length, no chunked stream)
//    - mime is the full "audio/ogg; codecs=opus" so Meta stores the right type for the WhatsApp client
const VOICE_MIME = "audio/ogg; codecs=opus";
const META_GRAPH = "https://graph.facebook.com/v23.0";

async function uploadVoiceToMeta(phoneNumberId, accessToken, oggPath, mime = VOICE_MIME) {
  const buf = fs.readFileSync(oggPath);
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", buf, { filename: path.basename(oggPath), contentType: mime, knownLength: buf.length });

  const r = await axios.post(`${META_GRAPH}/${phoneNumberId}/media`, form, {
    headers: { ...form.getHeaders(), "Content-Length": form.getLengthSync(), Authorization: `Bearer ${accessToken}` },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
  const mediaId = r.data.id;

  // Diagnostic: ask Meta what it actually stored. file_size must equal our local size.
  try {
    const info = await axios.get(`${META_GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    console.log(`🔎 Meta stored media ${mediaId}: mime=${info.data.mime_type} size=${info.data.file_size} (local size=${buf.length})`);
    if (Number(info.data.file_size) && Number(info.data.file_size) !== buf.length) {
      console.error("❌ SIZE MISMATCH: Meta received a different number of bytes than we sent (corrupt upload).");
    }
  } catch (e) {
    console.warn("⚠️ Could not read back media info:", e.response?.data?.error?.message || e.message);
  }
  return mediaId;
}

function formatMediaUrlForFrontend(mediaUrl) {
  if (!mediaUrl) return null;
  
  if (mediaUrl.startsWith("/uploads/") || mediaUrl.startsWith("uploads/")) {
    const cleanPath = mediaUrl.startsWith("/") ? mediaUrl : `/${mediaUrl}`;
    return `${PUBLIC_BASE_URL.replace(/\/$/, "")}${cleanPath}`;
  }

  if (!mediaUrl.startsWith("http") && /^\d+$/.test(mediaUrl)) {
    return `/api/chats/media-proxy?mediaUrl=${mediaUrl}`;
  }

  if (mediaUrl.includes("fbsbx.com") || mediaUrl.includes("facebook.com") || mediaUrl.includes("instagram.com")) {
    return `/api/chats/media-proxy?mediaUrl=${encodeURIComponent(mediaUrl)}`;
  }

  return mediaUrl;
}

// ROUTE 0: UPDATE & GET ASSIGNMENT MODE (Auto / Manual)
router.post("/assignment-mode", authMiddleware, async (req, res) => {
  try {
    const { mode } = req.body;
    const businessScopeId = req.user.adminId || req.user.id || req.user._id;

    if (!mode || !["auto", "manual"].includes(mode)) {
      return res.status(400).json({ success: false, message: "Valid mode ('auto' or 'manual') is required." });
    }

    tenantAssignmentModes.set(String(businessScopeId), mode);

    return res.json({ success: true, message: `Assignment mode updated to ${mode}.`, mode });
  } catch (err) {
    console.error("❌ Failed to update assignment mode:", err.message);
    return res.status(500).json({ success: false, message: "Server error updating mode." });
  }
});

// ROUTE 1: MULTI-CHANNEL & QR DISPATCH GATEWAY (Updated /send Route)
router.post("/send", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    const to = req.body.to || req.body.recipientId || req.body.recipient_id || req.body.phone || req.body.customerPhone;
    const text = req.body.text || req.body.message || "";
    const { type = "text", templateName, languageCode = "en", platform = "whatsapp" } = req.body;

    const clientMessageId = req.body.clientMessageId || req.body.fileLocalIdentifier || req.body.tempId || null;
    const businessScopeId = req.user.adminId || req.user.id || req.user._id;
    const userConditions = getAdminQueryFilter(businessScopeId);

    if (!to) {
      return res.status(400).json({ 
        success: false, 
        message: "Recipient identifier ('to', 'recipientId', or 'customerPhone') is required." 
      });
    }

    let messageId = null;
    let mediaUrl = null;
    let fullMediaUrl = null;
    let calculatedMessageType = type;
    let activePlatform = platform;
    let activeSource = "official_meta";

    if (req.file) {
      mediaUrl = `/uploads/${req.file.filename}`;
      fullMediaUrl = `${PUBLIC_BASE_URL.replace(/\/$/, "")}${mediaUrl}`;
      calculatedMessageType = getMediaType(path.extname(req.file.filename), req.file.mimetype);
    }

    if (platform === "whatsapp" || platform === "whatsapp_qr") {
      const WhatsAppConfig = mongoose.models.WhatsAppConfig || mongoose.model("WhatsAppConfig");
      
      let activeSock = getActiveSocket(businessScopeId) || getActiveSocket(String(businessScopeId));
      const qrConfigRecord = await WhatsAppConfig.findOne({ 
        $and: [
          { $or: userConditions },
          { platform: "whatsapp_qr" },
          { status: "CONNECTED" }
        ] 
      }).lean();

      if (platform === "whatsapp_qr" || activeSock || qrConfigRecord) {
        activePlatform = "whatsapp_qr";
        activeSource = "whatsapp_qr";

        if (!activeSock && qrConfigRecord) {
          try {
            await startWhatsAppSession(businessScopeId);
            await new Promise((resolve) => setTimeout(resolve, 2500));
            activeSock = getActiveSocket(businessScopeId) || getActiveSocket(String(businessScopeId));
          } catch (recoveryErr) {
            console.error("❌ Failed to auto-restore WhatsApp session:", recoveryErr.message);
          }
        }

        const sock = activeSock;
        if (!sock) {
          return res.status(400).json({ 
            success: false, 
            message: "WhatsApp QR session active nahi hai. Baraye meherbani page refresh karein ya dobara QR scan karein." 
          });
        }

        let recipientJid = "";
        const rawRecipient = String(to || "").trim();

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
                console.log("⚠️ onWhatsApp lookup warning in chatRoutes:", err.message);
            }
        }

        let sentResult;
        if (req.file) {
          const fileExt = path.extname(req.file.originalname).toLowerCase();
          const fileMime = String(req.file.mimetype || "").toLowerCase();

          const isImage = [".jpg", ".jpeg", ".png", ".webp"].includes(fileExt) || fileMime.startsWith("image/");
          const isAudio = !isImage && (
            fileMime.startsWith("audio/") ||
            [".mp3", ".ogg", ".wav", ".m4a", ".webm", ".opus", ".aac", ".amr"].includes(fileExt)
          );
          const isVideo = !isImage && !isAudio && ([".mp4", ".mov", ".avi", ".3gp"].includes(fileExt) || fileMime.startsWith("video/"));

          // Browser mic recording (voice-xxxx.webm / .ogg / .mp4) => real WhatsApp voice note (ptt)
          const isRecordedVoice = isAudio && (/^voice-/i.test(req.file.originalname) || [".webm", ".ogg", ".opus", ".mp4"].includes(fileExt));

          if (isImage) {
            sentResult = await sock.sendMessage(recipientJid, { image: fs.readFileSync(req.file.path), caption: text || "" });
          } else if (isVideo) {
            sentResult = await sock.sendMessage(recipientJid, { video: fs.readFileSync(req.file.path), caption: text || "" });
          } else if (isAudio) {
            calculatedMessageType = "audio";
            let converted;
            try {
              converted = await convertToWhatsAppVoice(req.file.path);
            } catch (ffmpegErr) {
              // NEVER send the raw browser .webm labelled as ogg - that is what makes WhatsApp say
              // "This audio is not available because something is wrong with the audio file"
              console.error("❌ FFmpeg voice conversion failed (QR):", ffmpegErr.message);
              return res.status(500).json({ success: false, message: "Voice note convert nahi ho saka (ffmpeg / libopus check karein)." });
            }
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            mediaUrl = `/uploads/${converted.outName}`;
            fullMediaUrl = `${PUBLIC_BASE_URL.replace(/\/$/, "")}${mediaUrl}`;

            console.log("🎙️ Voice send via QR/Baileys →", recipientJid, "seconds:", converted.seconds);
            const waveform = await buildVoiceWaveform(converted.outPath);
            sentResult = await sock.sendMessage(recipientJid, {
              audio: fs.readFileSync(converted.outPath),
              mimetype: "audio/ogg; codecs=opus",
              ptt: true,
              seconds: converted.seconds,
              ...(waveform ? { waveform } : {})
            });
          } else {
            sentResult = await sock.sendMessage(recipientJid, {
              document: fs.readFileSync(req.file.path),
              mimetype: req.file.mimetype,
              fileName: req.file.originalname,
              caption: text || ""
            });
          }
        } else {
          sentResult = await sock.sendMessage(recipientJid, { text: text });
        }

        messageId = sentResult?.key?.id || `qr-${Date.now()}`;

      } else {
        activePlatform = "whatsapp";
        activeSource = "official_meta";

        const config = await WhatsAppConfig.findOne({ 
          $and: [
            { $or: userConditions },
            { platform: { $in: ["whatsapp", "whatsapp_official"] } }
          ] 
        }).lean();
        const accessToken = config?.accessToken || process.env.WHATSAPP_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN;

        if (!config?.phoneNumberId || !accessToken) {
          return res.status(400).json({ success: false, message: "WhatsApp Cloud API credentials ya QR session missing hain." });
        }

        let payload = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: to
        };

        if (req.file) {
          const fileExt = path.extname(req.file.originalname).toLowerCase();
          
          if (fileExt === ".webm" || fileExt === ".ogg" || fileExt === ".opus" || fileExt === ".mp4" || req.file.mimetype?.includes("audio")) {
            calculatedMessageType = "audio";
            let converted;
            try {
              converted = await convertToWhatsAppVoice(req.file.path);
            } catch (ffmpegErr) {
              // Old code swallowed this error and sent the raw .webm -> WhatsApp "audio file is wrong"
              console.error("❌ FFmpeg voice conversion failed (Cloud API):", ffmpegErr.message);
              return res.status(500).json({ success: false, message: "Voice note convert nahi ho saka (ffmpeg / libopus check karein)." });
            }
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            mediaUrl = `/uploads/${converted.outName}`;
            fullMediaUrl = `${PUBLIC_BASE_URL.replace(/\/$/, "")}${mediaUrl}`;

            payload.type = "audio";
            console.log("🎙️ Voice send via Meta Cloud API →", to);
            try {
              // Upload to Meta and send by media id (no dependency on ngrok / public link / content-type)
              const metaMediaId = await uploadVoiceToMeta(config.phoneNumberId, accessToken, converted.outPath);
              payload.audio = { id: metaMediaId, voice: true };
              console.log("✅ Meta media uploaded, id:", metaMediaId);
            } catch (upErr) {
              console.warn("⚠️ Meta media upload failed, falling back to link:", upErr.response?.data?.error?.message || upErr.message);
              payload.audio = { link: fullMediaUrl, voice: true };
            }
          } else {
            const detectedType = getMediaType(fileExt, req.file.mimetype);
            const waMediaType = ["image", "video", "audio", "document"].includes(detectedType) ? detectedType : "document";
            payload.type = waMediaType;
            
            if (waMediaType === "document") {
              payload[waMediaType] = { link: fullMediaUrl, caption: text || "", filename: req.file.originalname };
            } else {
              payload[waMediaType] = { link: fullMediaUrl, caption: text || "" };
            }
          }
        } else if (type === "template") {
          payload.type = "template";
          payload.template = { name: templateName, language: { code: languageCode } };
        } else {
          payload.type = "text";
          payload.text = { preview_url: false, body: text };
        }

        console.log("📤 Meta payload:", JSON.stringify(payload));
        const metaResponse = await axios.post(
          `${META_GRAPH}/${config.phoneNumberId}/messages`,
          payload,
          { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
        );

        console.log("📨 Meta response:", JSON.stringify(metaResponse.data));
        messageId = metaResponse.data.messages?.[0]?.id;

        if (process.env.WA_VOICE_DEBUG === "1" && calculatedMessageType === "audio" && mediaUrl) {
          runVoiceVariants({ config, accessToken, to: String(to).replace(/\D/g, ""), oggPath: path.join("uploads/", path.basename(mediaUrl)) })
            .then((r) => console.log("🧪 voice variants result:", JSON.stringify(r)))
            .catch((e) => console.error("🧪 voice variants failed:", e.response?.data || e.message));
        }
      }

    } else if (platform === "instagram") {
      activeSource = "official_meta";
      const MetaConfig = mongoose.models.MetaConfig || mongoose.model("MetaConfig");
      const config = await MetaConfig.findOne({ $or: userConditions }).lean();
      const pageAccessToken = config?.instagramAccessToken || config?.pageAccessToken || process.env.FB_PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;

      if (!pageAccessToken) {
        return res.status(400).json({ success: false, message: "Instagram API credentials missing." });
      }

      let payload = { recipient: { id: to } };

      if (req.file) {
        const detectedType = getMediaType(path.extname(req.file.filename), req.file.mimetype);
        payload.message = {
          attachment: {
            type: detectedType === "video" ? "video" : "image",
            payload: { url: fullMediaUrl, is_reusable: true }
          }
        };
      } else {
        payload.message = { text: text };
      }

      const metaResponse = await axios.post(
        `https://graph.facebook.com/v20.0/me/messages`,
        payload,
        { headers: { Authorization: `Bearer ${pageAccessToken}`, "Content-Type": "application/json" } }
      );

      messageId = metaResponse.data.message_id;

    } else if (platform === "messenger") {
      activeSource = "official_meta";
      const MetaConfig = mongoose.models.MetaConfig || mongoose.model("MetaConfig");
      const config = await MetaConfig.findOne({ $or: userConditions }).lean();
      const pageAccessToken = config?.pageAccessToken || process.env.FB_PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;

      if (!pageAccessToken) {
        return res.status(400).json({ success: false, message: "Messenger API credentials missing." });
      }

      let payload = { recipient: { id: to }, messaging_type: "RESPONSE" };

      if (req.file) {
        const detectedType = getMediaType(path.extname(req.file.filename), req.file.mimetype);
        payload.message = {
          attachment: {
            type: ["image", "video", "audio"].includes(detectedType) ? detectedType : "file",
            payload: { url: fullMediaUrl, is_reusable: true }
          }
        };
      } else {
        payload.message = { text: text };
      }

      const metaResponse = await axios.post(
        `https://graph.facebook.com/v20.0/me/messages`,
        payload,
        { headers: { Authorization: `Bearer ${pageAccessToken}`, "Content-Type": "application/json" } }
      );

      messageId = metaResponse.data.message_id;
    }

    let assignedAgentId = null;
    const currentMode = tenantAssignmentModes.get(String(businessScopeId)) || "manual";
    
    if (currentMode === "auto") {
      const activeAgents = await TeamMember.find({
        $and: [
          { $or: [{ adminId: businessScopeId }, { userId: businessScopeId }] },
          { status: "Active" }
        ]
      }).lean();

      if (activeAgents.length > 0) {
        const randomAgent = activeAgents[Math.floor(Math.random() * activeAgents.length)];
        assignedAgentId = randomAgent._id;
      }
    }

    if (req.user.role === "Agent" || req.user.role === "Manager") {
      if (mongoose.isValidObjectId(req.user.id)) {
        assignedAgentId = new mongoose.Types.ObjectId(req.user.id);
      }
    }

    const activeMemberId = req.user.id || req.user._id;
    const userRole = String(req.user.role || req.user.type || "").toLowerCase();
    const isAdminUser = ["admin", "owner", "superadmin", "manager", "administrator"].includes(userRole) || req.user.isAdmin;

    let senderAgentNameVal = null;

    if (isAdminUser) {
      senderAgentNameVal = "Team Admin";
    } else {
      const existingChat = await ChatMessage.findOne({
        $and: [
          { $or: getAdminQueryFilter(businessScopeId) },
          { customerPhone: to }
        ]
      }).sort({ timestamp: -1 }).lean();

      const currentAssignedTo = existingChat?.assignedTo ? String(existingChat.assignedTo) : null;
      const activeMemberIdStr = String(activeMemberId || "");
      const isAssignedToThisAgent = currentAssignedTo && currentAssignedTo === activeMemberIdStr;

      if (isAssignedToThisAgent) {
        senderAgentNameVal = null;
      } else {
        let agentName = "Agent";
        if (mongoose.isValidObjectId(activeMemberId)) {
          const isTeamMemberUser = await TeamMember.findById(activeMemberId).lean();
          if (isTeamMemberUser) {
            agentName = `${isTeamMemberUser.firstName || ""} ${isTeamMemberUser.lastName || ""}`.trim() || isTeamMemberUser.email || "Agent";
          }
        }
        senderAgentNameVal = `Team: ${agentName}`;
      }
    }

    if (mongoose.isValidObjectId(activeMemberId)) {
      await recordAgentActivity(activeMemberId, businessScopeId, { messages: 1, minutes: 1, chats: 1 });
    }

    const outboundLog = new ChatMessage({
      userId: businessScopeId,
      messageId: messageId || `outbound-${activePlatform}-${Date.now()}`,
      clientMessageId: clientMessageId,
      customerPhone: to,
      customerName: req.body.customerName || "Customer",
      sender: "me",
      senderAgentId: activeMemberId,
      senderAgentName: senderAgentNameVal,
      platform: activePlatform,
      type: calculatedMessageType,
      text: text || (req.file ? `📎 ${req.file.originalname}` : ""),
      mediaUrl: mediaUrl,
      status: "sent",
      assignedTo: assignedAgentId,
      source: activeSource,
      connectionType: activeSource,
      origin: req.body.origin || "api",
      chatSource: activeSource,
      archived: false,
      timestamp: new Date()
    });

    // keep the uploaded file / converted voice note in R2 (local ./uploads is wiped on every restart)
    if (mediaUrl) await mirrorUploadToR2(mediaUrl, req.file && !/voice|audio/i.test(calculatedMessageType) ? req.file.mimetype : undefined);

    await outboundLog.save();

    const formattedMessage = outboundLog.toObject();
    formattedMessage.mediaUrl = formatMediaUrlForFrontend(formattedMessage.mediaUrl);
    formattedMessage.fileLocalIdentifier = req.body.fileLocalIdentifier || null;
    formattedMessage.tempId = req.body.tempId || null;

    return res.json({ 
      success: true, 
      message: `Message dispatched via ${activePlatform.toUpperCase()}.`, 
      platform: activePlatform,
      messageId,
      clientMessageId,
      tempId: req.body.tempId || null,
      fileLocalIdentifier: req.body.fileLocalIdentifier || null,
      mediaUrl: formattedMessage.mediaUrl,
      type: calculatedMessageType,
      data: formattedMessage
    });

  } catch (err) {
    console.error("❌ Multi-channel outbound transmission failed:", err.response?.data || err.message);
    return res.status(500).json({ 
      success: false, 
      message: "Cloud transmission failed.", 
      error: err.response?.data || err.message 
    });
  }
});

// 🧪 Sends the same recording in 7 different ways (each preceded by a "TEST n" text) to find what mobile WhatsApp accepts
async function runVoiceVariants({ config, accessToken, to, oggPath }) {
  const log = [];
    const publicLink = `${PUBLIC_BASE_URL.replace(/\/$/, "")}/uploads/${path.basename(oggPath)}`;
    const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
    const url = `${META_GRAPH}/${config.phoneNumberId}/messages`;
    const base = { messaging_product: "whatsapp", recipient_type: "individual", to };

    const send = async (label, body) => {
      try {
        await axios.post(url, { ...base, type: "text", text: { body: `TEST ${label}` } }, { headers });
        const r = await axios.post(url, { ...base, ...body }, { headers });
        log.push({ label, ok: true, id: r.data.messages?.[0]?.id });
      } catch (e) {
        log.push({ label, ok: false, error: e.response?.data?.error || e.message });
      }
      await new Promise((r) => setTimeout(r, 1500));
    };
    // Variant 6: constant-bitrate opus, "audio" application mode (different packet layout from voip/VBR)
    const outCbr = path.join("uploads/", `voicecbr-${Date.now()}.ogg`);
    await new Promise((resolve, reject) => {
      ffmpeg(oggPath).noVideo().audioCodec("libopus").audioChannels(1).audioFrequency(48000).audioBitrate("32k")
        .outputOptions(["-vbr off", "-application audio", "-frame_duration 20", "-map_metadata -1"]).toFormat("ogg")
        .on("end", resolve).on("error", reject).save(outCbr);
    });
  

  return log;
}

// ROUTE: VOICE DIAGNOSTIC - sends the SAME recording in several ways, each one preceded by a text label,
// so you can see on the phone which variant plays.   POST /api/chats/voice-test   { "to": "923xxxxxxxxx" }
// (optional "file": "voice-123.ogg" from uploads/ ; default = newest voice-*.ogg)
router.post("/voice-test", authMiddleware, async (req, res) => {
  let log = [];
  try {
    const to = String(req.body.to || "").replace(/\D/g, "");
    if (!to) return res.status(400).json({ success: false, message: "'to' required" });

    const businessScopeId = req.user.adminId || req.user.id || req.user._id;
    const userConditions = getAdminQueryFilter(businessScopeId);
    const WhatsAppConfig = mongoose.models.WhatsAppConfig || mongoose.model("WhatsAppConfig");
    const config = await WhatsAppConfig.findOne({
      $and: [{ $or: userConditions }, { platform: { $in: ["whatsapp", "whatsapp_official"] } }]
    }).lean();
    const accessToken = config?.accessToken || process.env.WHATSAPP_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN;
    if (!config?.phoneNumberId || !accessToken) return res.status(400).json({ success: false, message: "Cloud API credentials missing" });

    let fileName = req.body.file;
    if (!fileName) {
      const files = fs.readdirSync("uploads/").filter((f) => /^voice-.*\.ogg$/i.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join("uploads/", f)).mtimeMs })).sort((a, b) => b.t - a.t);
      if (!files.length) return res.status(404).json({ success: false, message: "No voice-*.ogg in uploads/" });
      fileName = files[0].f;
    }
    const oggPath = path.join("uploads/", path.basename(fileName));
    log = await runVoiceVariants({ config, accessToken, to, oggPath });
    return res.json({ success: true, file: fileName, results: log });
  } catch (err) {
    console.error("❌ voice-test failed:", err.response?.data || err.message);
    return res.status(500).json({ success: false, error: err.response?.data || err.message, results: log });
  }
});

// ROUTE 2: Assign Agent Workflow Route
router.post("/assign", authMiddleware, async (req, res) => {
  try {
    const { customerPhone, agentId, platform } = req.body;
    const businessScopeId = req.user.adminId || req.user.id || req.user._id;
    const userConditions = getAdminQueryFilter(businessScopeId);

    if (!customerPhone || agentId === undefined) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    let assignedValue = null;
    if (agentId && agentId !== "none" && agentId !== "" && mongoose.Types.ObjectId.isValid(agentId)) {
      assignedValue = new mongoose.Types.ObjectId(agentId);
    }

    const queryFilter = { 
      $and: [
        { $or: userConditions },
        { customerPhone: customerPhone }
      ] 
    };
    if (platform) queryFilter.platform = platform;

    await ChatMessage.updateMany(queryFilter, { $set: { assignedTo: assignedValue } });

    return res.json({ success: true, message: "Agent assigned successfully." });
  } catch (err) {
    console.error("❌ Operations assignment flow failure:", err.message);
    return res.status(500).json({ success: false, message: "Failed to assign agent." });
  }
});

// ROUTE 3: Media & File Downloader Proxy Stream
router.get("/media-proxy", authMiddleware, async (req, res) => {
  try {
    let mediaUrl = req.query.mediaUrl || req.query.url;
    if (!mediaUrl) {
      return res.status(400).json({ error: "Media / File URL parameter is required." });
    }

    const businessScopeId = req.user.adminId || req.user.id || req.user._id;
    const userConditions = getAdminQueryFilter(businessScopeId);
    let metaToken = null;

    try {
      const MetaConfig = mongoose.models.MetaConfig;
      const WhatsAppConfig = mongoose.models.WhatsAppConfig;

      if (WhatsAppConfig) {
        const waConfig = await WhatsAppConfig.findOne({ $or: userConditions }).lean();
        if (waConfig) metaToken = waConfig.accessToken;
      }

      if (!metaToken && MetaConfig) {
        const config = await MetaConfig.findOne({ $or: userConditions }).lean();
        if (config) metaToken = config.accessToken || config.pageAccessToken || config.instagramAccessToken;
      }
    } catch (dbErr) {}

    if (!metaToken) {
      metaToken = process.env.WHATSAPP_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;
    }

    const cleanToken = metaToken ? metaToken.replace(/^["']|["']$/g, "").trim() : "";

    if (!mediaUrl.startsWith("http") && /^\d+$/.test(mediaUrl)) {
      if (!cleanToken) {
        return res.status(400).json({ error: "WhatsApp media ID provided, but access token is missing." });
      }

      const mediaMetaRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaUrl}?fields=url,mime_type`, {
        headers: { Authorization: `Bearer ${cleanToken}` }
      });

      if (mediaMetaRes.data && mediaMetaRes.data.url) {
        mediaUrl = mediaMetaRes.data.url; 
      } else {
        return res.status(404).json({ error: "Failed to resolve WhatsApp media URL from ID." });
      }
    }

    const isMetaUrl = mediaUrl.includes("fbsbx.com") || mediaUrl.includes("facebook.com") || mediaUrl.includes("instagram.com");
    const headers = {
      "Accept-Encoding": "gzip, deflate",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    };

    if (isMetaUrl && cleanToken) {
      headers["Authorization"] = `Bearer ${cleanToken}`;
    }

    const response = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      headers: headers,
      decompress: true
    });

    let contentType = response.headers["content-type"];

    if (!contentType || contentType === "application/octet-stream") {
      const cleanLower = mediaUrl.split("?")[0].toLowerCase();
      if (cleanLower.match(/\.(jpg|jpeg|png|webp|gif)$/)) contentType = "image/jpeg";
      else if (cleanLower.match(/\.(mp4|3gp|mov)$/)) contentType = "video/mp4";
      else if (cleanLower.match(/\.(ogg|opus|mp3|wav|m4a)$/)) contentType = "audio/ogg";
      else contentType = "image/jpeg"; 
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", "inline");

    return res.send(Buffer.from(response.data));

  } catch (err) {
    console.error("❌ Media Proxy Error:", err.response?.data?.error?.message || err.message);
    return res.status(500).json({ error: "Failed to download media stream from Meta." });
  }
});

// ROUTE 4: Lifecycle Status Manager
router.post("/status", authMiddleware, async (req, res) => {
  try {
    const { customerPhone, status, platform } = req.body;
    const businessScopeId = req.user.adminId || req.user.id || req.user._id;
    const userConditions = getAdminQueryFilter(businessScopeId);

    if (!customerPhone || !status) {
      return res.status(400).json({ success: false, message: "customerPhone and status are required." });
    }

    const queryFilter = { 
      $and: [
        { $or: userConditions },
        { customerPhone: customerPhone }
      ] 
    };
    if (platform) queryFilter.platform = platform;

    await ChatMessage.updateMany(queryFilter, { $set: { chatStatus: status } });

    return res.json({ success: true, message: "Chat lifecycle status updated." });
  } catch (err) {
    console.error("❌ Status update route crash:", err.message);
    return res.status(500).json({ success: false, message: "Failed to update chat status." });
  }
});

// ROUTE 5: Explicit Mark-Read Gateway
router.post("/mark-read", authMiddleware, async (req, res) => {
  try {
    const { customerPhone, platform } = req.body;
    const businessScopeId = req.user.adminId || req.user.id || req.user._id;
    const userConditions = getAdminQueryFilter(businessScopeId);

    if (!customerPhone) {
      return res.status(400).json({ success: false, message: "customerPhone parameter is required." });
    }

    const queryFilter = { 
      $and: [
        { $or: userConditions },
        { customerPhone: customerPhone },
        { sender: "them" },
        { status: { $ne: "read" } }
      ] 
    };

    if (platform) {
      queryFilter.platform = platform === "whatsapp" ? { $in: ["whatsapp", "whatsapp_qr", null] } : platform;
    }

    const result = await ChatMessage.updateMany(queryFilter, {
      $set: { status: "read", readAt: new Date() }
    });

    return res.json({
      success: true,
      message: "Unread metrics updated.",
      modifiedCount: result.modifiedCount ?? result.nModified ?? 0
    });
  } catch (err) {
    console.error("❌ Mark-read route crash:", err.message);
    return res.status(500).json({ success: false, message: "Failed to mark chat read." });
  }
});

// ROUTE 5b: Voice note "listened" gateway - marks a voice message as played so the NEW indicator disappears
router.post("/mark-played", authMiddleware, async (req, res) => {
  try {
    const { messageId, messageIds } = req.body;
    const ids = (Array.isArray(messageIds) ? messageIds : [messageId]).filter((x) => x && mongoose.isValidObjectId(x));
    if (!ids.length) {
      return res.status(400).json({ success: false, message: "messageId is required." });
    }

    const businessScopeId = req.user.adminId || req.user.id || req.user._id;
    const result = await ChatMessage.updateMany(
      { $and: [{ $or: getAdminQueryFilter(businessScopeId) }, { _id: { $in: ids } }, { sender: "them" }] },
      { $set: { voicePlayed: true, voicePlayedAt: new Date() } },
      { strict: false } // works even if the ChatMessage schema has no voicePlayed field yet
    );

    return res.json({ success: true, modifiedCount: result.modifiedCount ?? result.nModified ?? 0 });
  } catch (err) {
    console.error("❌ Mark-played route crash:", err.message);
    return res.status(500).json({ success: false, message: "Failed to mark voice note as played." });
  }
});

// ROUTE 6: Get All Active Chat Threads (List View) with Archive & DP Support
router.get("/", authMiddleware, async (req, res) => {
  try {
    const businessScopeId = req.user.adminId || req.user.id || req.user._id;
    const businessObjectId = new mongoose.Types.ObjectId(businessScopeId);

    const currentMode = tenantAssignmentModes.get(String(businessScopeId)) || "manual";
    if (currentMode === "auto") {
      const activeAgents = await TeamMember.find({
        $and: [
          { $or: [{ adminId: businessScopeId }, { userId: businessScopeId }] },
          { status: "Active" }
        ]
      }).lean();

      if (activeAgents.length > 0) {
        const assignedPhones = await ChatMessage.distinct("customerPhone", {
          $and: [
            { $or: [{ userId: businessObjectId }, { adminId: businessObjectId }] },
            { assignedTo: { $ne: null, $exists: true, $ne: "none" } }
          ]
        });

        const allPhones = await ChatMessage.distinct("customerPhone", {
          $or: [{ userId: businessObjectId }, { adminId: businessObjectId }]
        });

        const unassignedPhones = allPhones.filter(phone => !assignedPhones.includes(phone));

        for (const phone of unassignedPhones) {
          const randomAgent = activeAgents[Math.floor(Math.random() * activeAgents.length)];
          await ChatMessage.updateMany(
            { 
              $and: [
                { $or: [{ userId: businessObjectId }, { adminId: businessObjectId }] },
                { customerPhone: phone }
              ] 
            },
            { $set: { assignedTo: randomAgent._id } }
          );
        }
      }
    }

    const chatAggregates = await ChatMessage.aggregate([
      {
        $match: {
          $and: [
            { $or: [{ userId: businessObjectId }, { adminId: businessObjectId }] },
            { $or: [{ archived: false }, { archived: { $exists: false } }] }
          ]
        }
      },
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: "$customerPhone",
          lastMessageId: { $first: "$_id" },
          lastMsg: { $first: "$text" },
          lastType: { $first: "$type" },
          lastSender: { $first: "$sender" },
          lastMessageTimestamp: { $first: "$timestamp" },
          lastMessageStatus: { $first: "$status" },
          customerName: { $first: "$customerName" },
          channel: { $first: "$platform" },
          status: { $first: "$chatStatus" },
          assignedTo: { $max: "$assignedTo" },
          source: { $first: "$source" },
          connectionType: { $first: "$connectionType" },
          origin: { $first: "$origin" },
          chatSource: { $first: "$chatSource" },
          unreadCount: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ["$sender", "them"] }, { $ne: ["$status", "read"] }] },
                1,
                0
              ]
            }
          }
        }
      },
      { $sort: { lastMessageTimestamp: -1 } }
    ]);

    const phonesList = chatAggregates.map(c => c._id);
    // Contacts can belong to the admin or to an agent/admin pair, so match both (same scope as the chats above)
    const contactsData = await Contact.find({
      $and: [
        { $or: [{ userId: businessObjectId }, { adminId: businessObjectId }] },
        { phone: { $in: phonesList } }
      ]
    }).select("phone profilePicUrl avatar").lean();

    // Locally stored DPs ("/uploads/...") need the full server address, otherwise the browser looks for them
    // on the website's own domain. Remote links are returned as they are (they must NOT go through the
    // authenticated media-proxy, an <img> tag cannot send the login token).
    const dpForFrontend = (url) => {
      if (!url) return null;
      const s = String(url);
      if (s.startsWith("/uploads/") || s.startsWith("uploads/")) {
        return `${PUBLIC_BASE_URL.replace(/\/$/, "")}${s.startsWith("/") ? s : `/${s}`}`;
      }
      return s;
    };

    const contactMap = {};
    contactsData.forEach(cnt => {
      const dp = dpForFrontend(cnt.profilePicUrl || cnt.avatar);
      // several contact records can share a phone: never let an empty one overwrite a real DP
      if (dp && !contactMap[cnt.phone]) contactMap[cnt.phone] = dp;
    });

    const chats = chatAggregates.map(chat => ({
      _id: chat._id,
      customerPhone: chat._id,
      phone: chat._id,
      lastMessageId: chat.lastMessageId,
      name: chat.customerName,
      customerName: chat.customerName,
      lastMsg: chat.lastMsg,
      lastType: chat.lastType,
      lastSender: chat.lastSender,
      lastMessageTimestamp: chat.lastMessageTimestamp,
      lastMessageStatus: chat.lastMessageStatus,
      channel: chat.channel,
      platform: chat.channel,
      status: chat.status,
      assignedTo: chat.assignedTo,
      source: chat.source,
      connectionType: chat.connectionType,
      origin: chat.origin,
      chatSource: chat.chatSource,
      unreadCount: chat.unreadCount,
      profilePicUrl: contactMap[chat._id] || null,
      avatar: contactMap[chat._id] || null
    }));

    return res.json({ success: true, chats, assignmentMode: currentMode });
  } catch (err) {
    console.error("❌ Fetch active chats failed:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load chats." });
  }
});

// ROUTE: Get Team Members for Chat Assignment
router.get("/team", authMiddleware, async (req, res) => {
  try {
    const businessScopeId = req.user.adminId || req.user.id || req.user._id;
    const team = await TeamMember.find({
      $or: [{ adminId: businessScopeId }, { userId: businessScopeId }]
    }).lean();

    return res.json({ success: true, team });
  } catch (err) {
    console.error("❌ Fetch team members failed:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load team members." });
  }
});

// ROUTE 7: Get Conversation History for Specific Identifier
router.get("/history/:chatIdentifier", authMiddleware, async (req, res) => {
  try {
    const { chatIdentifier } = req.params;
    const businessScopeId = req.user.adminId || req.user.id || req.user._id;

    const rawMessages = await ChatMessage.find({
      $and: [
        { $or: getAdminQueryFilter(businessScopeId) },
        { customerPhone: chatIdentifier },
        { $or: [{ archived: false }, { archived: { $exists: false } }] }
      ]
    }).sort({ timestamp: 1 }).lean();

    const messages = rawMessages.map(msg => ({
      ...msg,
      fileLocalIdentifier: msg.fileLocalIdentifier || msg.clientMessageId || null,
      tempId: msg.tempId || msg.clientMessageId || null,
      mediaUrl: formatMediaUrlForFrontend(msg.mediaUrl)
    }));

    return res.json({ success: true, messages });
  } catch (err) {
    console.error("❌ Fetch conversation history failed:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load history." });
  }
});

// =========================================================================
// 📞 NEW ROUTE 10: TARGETED INCOMING CALL ROUTING & AUTO FORWARDING SYSTEM
// =========================================================================
router.post("/whatsapp-call/incoming", async (req, res) => {
  try {
    const { fromPhone, callId, businessScopeId } = req.body;

    if (!fromPhone || !callId) {
      return res.status(400).json({ success: false, message: "fromPhone and callId are required." });
    }

    const scopeId = businessScopeId || "default_tenant";

    // 1. Database se check karein ke yeh customer kis agent ko assigned hai
    const existingChat = await ChatMessage.findOne({
      $and: [
        { $or: [{ userId: scopeId }, { adminId: scopeId }] },
        { customerPhone: fromPhone }
      ]
    }).sort({ timestamp: -1 }).lean();

    const assignedAgentId = existingChat?.assignedTo ? String(existingChat.assignedTo) : null;

    // Call Log Entry create karein
    const newCall = new CallLog({
      userId: scopeId,
      callId: callId,
      customerPhone: fromPhone,
      assignedAgentId: assignedAgentId,
      direction: "inbound",
      status: "ringing"
    });
    await newCall.save();

    const reqIo = req.app.get("io");
    const callPayload = {
      callId,
      customerPhone: fromPhone,
      customerName: existingChat?.customerName || "WhatsApp Customer",
      assignedAgentId,
      timestamp: new Date()
    };

    // 2. Targeted Routing: Sirf assigned agent ko signal bhejein
    if (reqIo) {
      if (assignedAgentId && assignedAgentId !== "none") {
        reqIo.to(`agent_${assignedAgentId}`).emit("incoming_whatsapp_call", callPayload);
        console.log(`📞 [CALL ROUTED] Strictly sent to Agent: agent_${assignedAgentId}`);
      } else {
        reqIo.to(`admin_${scopeId}`).emit("incoming_whatsapp_call", callPayload);
        console.log(`📡 [CALL ROUTED] Unassigned Call sent to Admin`);
      }

      // 3. System 2: 15 Seconds Timeout Auto-Forwarding Logic
      setTimeout(async () => {
        const checkCallStatus = await CallLog.findOne({ callId }).lean();
        if (checkCallStatus && checkCallStatus.status === "ringing") {
          console.log(`⏰ [CALL TIMEOUT] Agent ${assignedAgentId} missed call ${callId}. Forwarding to Admin...`);
          
          await CallLog.updateOne({ callId }, { $set: { status: "forwarded_to_admin" } });

          // Forward event emit karein
          reqIo.to(`admin_${scopeId}`).emit("incoming_whatsapp_call_forwarded", {
            ...callPayload,
            reason: "Assigned agent missed the call"
          });
        }
      }, 15000); // 15 Seconds
    }

    return res.status(200).json({
      success: true,
      message: "Call signaling and routing triggered.",
      assignedAgentId
    });

  } catch (err) {
    console.error("❌ Incoming call routing error:", err.message);
    return res.status(500).json({ success: false, message: "Routing failed." });
  }
});

// ROUTE 8: Get Call Logs & Recordings for Specific Customer / Chat
router.get("/calls/:chatIdentifier", authMiddleware, async (req, res) => {
  try {
    const { chatIdentifier } = req.params;
    const businessScopeId = req.user.adminId || req.user.id || req.user._id;

    const callLogs = await CallLog.find({
      $and: [
        { $or: getAdminQueryFilter(businessScopeId) },
        { customerPhone: chatIdentifier }
      ]
    }).sort({ createdAt: -1 }).lean();

    return res.json({ success: true, calls: callLogs });
  } catch (err) {
    console.error("❌ Fetch call logs failed:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load call logs." });
  }
});

// ROUTE 9: Get All Call Logs for Dashboard Admin Monitoring
router.get("/call-logs", authMiddleware, async (req, res) => {
  try {
    const businessScopeId = req.user.adminId || req.user.id || req.user._id;
    const callLogs = await CallLog.find({
      $or: getAdminQueryFilter(businessScopeId)
    }).sort({ createdAt: -1 }).limit(100).lean();

    return res.json({ success: true, data: callLogs });
  } catch (err) {
    console.error("❌ Fetch all call logs failed:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load all call logs." });
  }
});

// =========================================================================
// QUICK REPLIES (saved message templates)
// =========================================================================
const isQuickReplyAdmin = (user) => {
  const role = String(user.role || user.type || "").toLowerCase();
  return ["admin", "owner", "superadmin", "manager", "administrator"].includes(role) || !!user.isAdmin;
};

const serializeQuickReply = (doc, user) => {
  const plain = doc.toObject ? doc.toObject() : doc;
  const me = String(user.id || user._id || "");
  return { ...plain, canManage: isQuickReplyAdmin(user) || String(plain.createdBy || "") === me };
};

const cleanQuickReplyInput = (b = {}) => ({
  title: String(b.title || "").trim(),
  body: String(b.body || "").trim(),
  category: String(b.category || "").trim()
});

const validateQuickReplyInput = ({ title, body, category }) => {
  if (!title) return "Title is required.";
  if (!body) return "Message is required.";
  if (title.length > 80) return "Title can be at most 80 characters.";
  if (category.length > 40) return "Category can be at most 40 characters.";
  if (body.length > 4096) return "Message can be at most 4096 characters.";
  return null;
};

// ROUTE: List quick replies for this business
router.get("/quick-replies", authMiddleware, async (req, res) => {
  try {
    const businessScopeId = String(req.user.adminId || req.user.id || req.user._id);
    const items = await QuickReply.find({ businessId: businessScopeId }).sort({ category: 1, title: 1 });
    return res.json({ success: true, data: items.map((i) => serializeQuickReply(i, req.user)) });
  } catch (err) {
    console.error("❌ Fetch quick replies failed:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load quick replies." });
  }
});

// ROUTE: Create a quick reply
router.post("/quick-replies", authMiddleware, async (req, res) => {
  try {
    const businessScopeId = String(req.user.adminId || req.user.id || req.user._id);
    const input = cleanQuickReplyInput(req.body);
    const problem = validateQuickReplyInput(input);
    if (problem) return res.status(400).json({ success: false, message: problem });

    const created = await QuickReply.create({
      ...input,
      businessId: businessScopeId,
      createdBy: String(req.user.id || req.user._id || "")
    });
    return res.status(201).json({ success: true, data: serializeQuickReply(created, req.user) });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: "A quick reply with this title already exists." });
    }
    console.error("❌ Create quick reply failed:", err.message);
    return res.status(500).json({ success: false, message: "Failed to save quick reply." });
  }
});

// ROUTE: Update a quick reply (creator or admin only)
router.put("/quick-replies/:id", authMiddleware, async (req, res) => {
  try {
    const businessScopeId = String(req.user.adminId || req.user.id || req.user._id);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid quick reply id." });
    }
    const existing = await QuickReply.findOne({ _id: req.params.id, businessId: businessScopeId });
    if (!existing) return res.status(404).json({ success: false, message: "Quick reply not found." });

    const me = String(req.user.id || req.user._id || "");
    if (!isQuickReplyAdmin(req.user) && String(existing.createdBy || "") !== me) {
      return res.status(403).json({ success: false, message: "You can only edit your own quick replies." });
    }

    const input = cleanQuickReplyInput(req.body);
    const problem = validateQuickReplyInput(input);
    if (problem) return res.status(400).json({ success: false, message: problem });

    existing.title = input.title;
    existing.body = input.body;
    existing.category = input.category;
    await existing.save();
    return res.json({ success: true, data: serializeQuickReply(existing, req.user) });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: "A quick reply with this title already exists." });
    }
    console.error("❌ Update quick reply failed:", err.message);
    return res.status(500).json({ success: false, message: "Failed to update quick reply." });
  }
});

// ROUTE: Delete a quick reply (creator or admin only)
router.delete("/quick-replies/:id", authMiddleware, async (req, res) => {
  try {
    const businessScopeId = String(req.user.adminId || req.user.id || req.user._id);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid quick reply id." });
    }
    const existing = await QuickReply.findOne({ _id: req.params.id, businessId: businessScopeId });
    if (!existing) return res.status(404).json({ success: false, message: "Quick reply not found." });

    const me = String(req.user.id || req.user._id || "");
    if (!isQuickReplyAdmin(req.user) && String(existing.createdBy || "") !== me) {
      return res.status(403).json({ success: false, message: "You can only delete your own quick replies." });
    }

    await existing.deleteOne();
    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Delete quick reply failed:", err.message);
    return res.status(500).json({ success: false, message: "Failed to delete quick reply." });
  }
});

module.exports = router;