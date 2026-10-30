const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const BotReply = require("../models/BotReply");
const User = require("../models/User");
const auth = require("../middleware/auth");

const router = express.Router();

// ==========================================
// CONFIG
// ==========================================
const uploadDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const MATCH_TYPES = ["exact", "contains", "startsWith"];
const BOT_TYPES = ["simple", "media", "interactive", "template"];
const MAX_BUTTONS = 3;
const BUTTON_TEXT_MAX = 20;
const FOOTER_MAX = 60;
const KEYWORD_MAX = 100;
const BODY_MAX = { default: 4096, interactive: 1024 };

// Allowed media (WhatsApp Cloud API limits: image 5MB, audio/video 16MB, document 100MB)
const MB = 1024 * 1024;
const MEDIA_RULES = [
  { kind: "image", max: 5 * MB, mimes: ["image/jpeg", "image/png", "image/webp"] },
  { kind: "video", max: 16 * MB, mimes: ["video/mp4", "video/3gpp"] },
  { kind: "audio", max: 16 * MB, mimes: ["audio/mpeg", "audio/ogg", "audio/aac", "audio/mp4", "audio/amr"] },
  {
    kind: "document",
    max: 100 * MB,
    mimes: [
      "application/pdf",
      "text/plain",
      "application/msword",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  },
];
const mediaRuleFor = (mime) => MEDIA_RULES.find((r) => r.mimes.includes(mime));

const getBaseUrl = (req) =>
  (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

// ==========================================
// UPLOAD
// ==========================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname).toLowerCase());
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * MB },
  fileFilter: (req, file, cb) => {
    if (mediaRuleFor(file.mimetype)) return cb(null, true);
    cb(new Error("Unsupported file type. Use JPG, PNG, WEBP, MP4, 3GP, MP3, OGG, AAC, AMR, PDF or Office files."));
  },
});

const handleUpload = (req, res, next) => {
  upload.single("mediaFile")(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: `Upload error: ${err.message}` });

    if (req.file) {
      const rule = mediaRuleFor(req.file.mimetype);
      if (req.file.size > rule.max) {
        discardUpload(req);
        return res.status(400).json({
          success: false,
          message: `A ${rule.kind} file can be up to ${Math.round(rule.max / MB)} MB on WhatsApp.`,
        });
      }
    }
    next();
  });
};

const discardUpload = (req) => {
  if (req.file?.path) fs.unlink(req.file.path, () => {});
};

/** Deletes an uploaded file only when no other rule still points at it. */
const cleanupMedia = async (mediaUrl) => {
  if (!mediaUrl) return;
  try {
    const stillUsed = await BotReply.exists({ mediaUrl });
    if (stillUsed) return;
    const filename = path.basename(new URL(mediaUrl).pathname);
    const filePath = path.join(uploadDir, filename);
    if (filePath.startsWith(uploadDir)) fs.unlink(filePath, () => {});
  } catch (e) {
    /* best effort */
  }
};

// ==========================================
// HELPERS
// ==========================================
const getUserId = (req) => req.user.id || req.user._id;
const toBool = (v) => v === true || v === "true" || v === "1" || v === 1;

// ✅ Multiple keywords support ke liye normalization update
const normalizeKeyword = (k) => 
  String(k || "")
    .split(",")
    .map((kw) => kw.trim().toLowerCase().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(", ");

const normalizeLevel = (l) => {
  const level = String(l || "").trim();
  return !level || level.toLowerCase() === "any" ? "ANY" : level;
};
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getRuleLimitByPlan = (planInput) => {
  if (!planInput) return 5;
  const plan = planInput.toString().toLowerCase();
  if (plan.includes("standard")) return 20;
  if (plan.includes("premium")) return 100;
  if (plan.includes("ultimate")) return Infinity;
  return 5;
};

const getQuota = async (userId) => {
  const [user, used] = await Promise.all([
    User.findById(userId).lean(),
    BotReply.countDocuments({ userId }),
  ]);
  const sub = user?.subscription || {};
  const rawPlan = sub.planId || sub.planName || user?.plan || "price_free";
  return { plan: sub.planName || rawPlan, limit: getRuleLimitByPlan(rawPlan), used };
};

const sanitizeButtons = (input) => {
  if (input === undefined || input === null || input === "") return { buttons: [] };

  let raw = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      return { error: "Buttons must be valid JSON." };
    }
  }
  if (!Array.isArray(raw)) return { error: "Buttons must be a list." };

  const buttons = [];
  for (const [idx, btn] of raw.entries()) {
    const text = String(btn?.text ?? "").trim();
    if (!text) continue;
    if (text.length > BUTTON_TEXT_MAX) {
      return { error: `Button "${text.slice(0, 12)}…" is longer than ${BUTTON_TEXT_MAX} characters.` };
    }

    const rawType = btn.type === "reply" || !btn.type ? "quick_reply" : btn.type;
    if (!["quick_reply", "url", "phone"].includes(rawType)) {
      return { error: `Button "${text}" has an unknown type.` };
    }

    const clean = { id: btn.id || `${Date.now()}_${idx}`, type: rawType, text };

    if (rawType === "quick_reply") {
      clean.payload = String(btn.payload || text).slice(0, 256);
    } else if (rawType === "url") {
      try {
        const parsed = new URL(String(btn.url || "").trim());
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("protocol");
        clean.url = parsed.toString();
      } catch (e) {
        return { error: `Button "${text}" needs a valid http(s) link.` };
      }
    } else {
      const phone = String(btn.phone || "").replace(/[\s()-]/g, "");
      if (!/^\+?\d{7,15}$/.test(phone)) {
        return { error: `Button "${text}" needs a valid phone number with country code.` };
      }
      clean.phone = phone;
    }
    buttons.push(clean);
  }

  if (buttons.length > MAX_BUTTONS) return { error: `You can add up to ${MAX_BUTTONS} buttons.` };

  const hasQuick = buttons.some((b) => b.type === "quick_reply");
  const hasAction = buttons.some((b) => b.type !== "quick_reply");
  if (hasQuick && hasAction) {
    return { error: "Quick-reply buttons can't be mixed with link or call buttons." };
  }

  return { buttons };
};

const validateContent = ({ botType, keyword, matchType, replyText, footerText, templateId, mediaUrl, buttons }) => {
  const errors = [];

  if (!BOT_TYPES.includes(botType)) errors.push("Choose a valid reply type.");
  if (!keyword) errors.push("Keyword is required.");
  else if (keyword.length > KEYWORD_MAX * 3) errors.push(`Keyword can be up to ${KEYWORD_MAX} characters.`);
  if (!MATCH_TYPES.includes(matchType)) errors.push("Choose a valid match type.");

  if (botType === "template") {
    if (!templateId && !replyText) errors.push("Choose a template or provide template text.");
  } else if (BOT_TYPES.includes(botType)) {
    const maxBody = botType === "interactive" ? BODY_MAX.interactive : BODY_MAX.default;
    if (botType !== "media" && !replyText) errors.push("Reply text is required.");
    if (replyText && replyText.length > maxBody) errors.push(`Reply text can be up to ${maxBody} characters.`);
    if (botType === "media" && !mediaUrl) errors.push("Upload a media file.");
    if (botType === "interactive" && buttons.length === 0) errors.push("Add at least one button.");
    if (footerText && footerText.length > FOOTER_MAX) errors.push(`Footer can be up to ${FOOTER_MAX} characters.`);
  }
  return errors;
};

const respondError = (res, err, label) => {
  if (err?.code === 11000) {
    return res.status(409).json({ success: false, message: "A reply for this keyword already exists." });
  }
  if (err?.name === "ValidationError") {
    return res.status(400).json({ success: false, message: Object.values(err.errors)[0]?.message || "Invalid data." });
  }
  console.error(`BotReply ${label} error:`, err);
  return res.status(500).json({ success: false, message: "Internal server error." });
};

// Reject malformed ids early instead of letting Mongoose throw a CastError (500)
router.param("id", (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: "Invalid rule id." });
  }
  next();
});

// ==========================================
// STATIC ROUTES (must stay above "/:id")
// ==========================================

// Plan usage
router.get("/quota", auth, async (req, res) => {
  try {
    const { plan, limit, used } = await getQuota(getUserId(req));
    res.json({ success: true, plan, used, limit: Number.isFinite(limit) ? limit : null });
  } catch (error) {
    respondError(res, error, "quota");
  }
});

// "Test a message": which rule would answer this text?
router.post("/test", auth, async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ success: false, message: "Type a message to test." });
    const rule = await BotReply.findMatch(getUserId(req), text, req.body.level);
    res.json({ success: true, matched: Boolean(rule), rule });
  } catch (error) {
    respondError(res, error, "test");
  }
});

// Bulk enable / disable / delete
router.post("/bulk", auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const { ids, action } = req.body;

    if (!["enable", "disable", "delete"].includes(action)) {
      return res.status(400).json({ success: false, message: "Unknown bulk action." });
    }
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((i) => mongoose.isValidObjectId(i))) {
      return res.status(400).json({ success: false, message: "Select between 1 and 100 replies." });
    }

    const filter = { _id: { $in: ids }, userId };

    if (action === "delete") {
      const docs = await BotReply.find(filter).select("mediaUrl").lean();
      const result = await BotReply.deleteMany(filter);
      await Promise.all(docs.map((d) => cleanupMedia(d.mediaUrl)));
      return res.json({ success: true, affected: result.deletedCount });
    }

    const result = await BotReply.updateMany(filter, { isActive: action === "enable" });
    res.json({ success: true, affected: result.modifiedCount ?? result.nModified ?? 0 });
  } catch (error) {
    respondError(res, error, "bulk");
  }
});

// ==========================================
// 1. LIST (only the signed-in user's rules)
// ==========================================
router.get("/", auth, async (req, res) => {
  try {
    const filter = { userId: getUserId(req) };
    if (BOT_TYPES.includes(req.query.botType)) filter.botType = req.query.botType;
    if (req.query.isActive === "true" || req.query.isActive === "false") filter.isActive = req.query.isActive === "true";
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(String(req.query.search).trim()), "i");
      filter.$or = [{ keyword: rx }, { replyText: rx }];
    }

    const rules = await BotReply.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, count: rules.length, rules });
  } catch (error) {
    respondError(res, error, "list");
  }
});

// ==========================================
// 2. GET ONE
// ==========================================
router.get("/:id", auth, async (req, res) => {
  try {
    const rule = await BotReply.findOne({ _id: req.params.id, userId: getUserId(req) });
    if (!rule) return res.status(404).json({ success: false, message: "Rule not found." });
    res.json({ success: true, data: rule });
  } catch (error) {
    respondError(res, error, "get");
  }
});

// ==========================================
// 3. CREATE
// ==========================================
router.post("/", auth, handleUpload, async (req, res) => {
  let saved = false;
  try {
    const userId = getUserId(req);
    const body = req.body;

    const quota = await getQuota(userId);
    if (quota.used >= quota.limit) {
      return res.status(403).json({
        success: false,
        quotaExceeded: true,
        message: `Your '${quota.plan}' plan allows up to ${quota.limit} keyword replies. Upgrade to add more.`,
      });
    }

    const { buttons, error: buttonError } = sanitizeButtons(body.buttons);
    if (buttonError) return res.status(400).json({ success: false, message: buttonError });

    const botType = body.botType;
    const isTemplate = botType === "template";
    const data = {
      botType,
      keyword: normalizeKeyword(body.keyword),
      matchType: body.matchType || "exact",
      level: normalizeLevel(body.level),
      replyText: String(body.replyText || "").trim(),
      footerText: isTemplate ? "" : String(body.footerText || "").trim(),
      templateId: isTemplate ? String(body.templateId || "").trim() : "",
      mediaUrl: !isTemplate && req.file ? `${getBaseUrl(req)}/uploads/${req.file.filename}` : "",
      buttons: isTemplate ? [] : buttons,
    };

    const errors = validateContent(data);
    if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

    const rule = await BotReply.create({
      ...data,
      userId,
      isActive: body.isActive === undefined ? true : toBool(body.isActive),
    });
    saved = true;

    res.status(201).json({ success: true, message: "Reply created.", data: rule });
  } catch (error) {
    respondError(res, error, "create");
  } finally {
    if (!saved) discardUpload(req);
  }
});

// ==========================================
// 4. UPDATE
// ==========================================
router.put("/:id", auth, handleUpload, async (req, res) => {
  let saved = false;
  try {
    const body = req.body;
    const rule = await BotReply.findOne({ _id: req.params.id, userId: getUserId(req) });
    if (!rule) return res.status(404).json({ success: false, message: "Rule not found." });

    const removeMedia = toBool(body.removeMedia);
    const contentFields = ["botType", "keyword", "matchType", "level", "replyText", "footerText", "templateId", "buttons"];
    const touchesContent = contentFields.some((k) => body[k] !== undefined) || req.file || removeMedia;

    if (touchesContent) {
      const { buttons, error: buttonError } =
        body.buttons !== undefined ? sanitizeButtons(body.buttons) : { buttons: rule.buttons.map((b) => b.toObject()) };
      if (buttonError) return res.status(400).json({ success: false, message: buttonError });

      const botType = body.botType || rule.botType;
      const isTemplate = botType === "template";
      const previousMedia = rule.mediaUrl;

      let mediaUrl = previousMedia || "";
      if (req.file) mediaUrl = `${getBaseUrl(req)}/uploads/${req.file.filename}`;
      else if (removeMedia) mediaUrl = "";
      if (isTemplate) mediaUrl = "";

      const next = {
        botType,
        keyword: body.keyword !== undefined ? normalizeKeyword(body.keyword) : rule.keyword,
        matchType: body.matchType || rule.matchType || "exact",
        level: body.level !== undefined ? normalizeLevel(body.level) : rule.level || "ANY",
        replyText: body.replyText !== undefined ? String(body.replyText).trim() : rule.replyText || "",
        footerText: isTemplate ? "" : body.footerText !== undefined ? String(body.footerText).trim() : rule.footerText || "",
        templateId: isTemplate ? (body.templateId !== undefined ? String(body.templateId).trim() : rule.templateId || "") : "",
        mediaUrl,
        buttons: isTemplate ? [] : buttons,
      };

      const errors = validateContent(next);
      if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });

      rule.set(next);
      if (previousMedia && previousMedia !== mediaUrl) res.locals.oldMedia = previousMedia;
    }

    if (body.isActive !== undefined) rule.isActive = toBool(body.isActive);

    await rule.save();
    saved = true;
    if (res.locals.oldMedia) await cleanupMedia(res.locals.oldMedia);

    res.json({ success: true, message: "Reply updated.", data: rule });
  } catch (error) {
    respondError(res, error, "update");
  } finally {
    if (!saved) discardUpload(req);
  }
});

// ==========================================
// 5. TOGGLE ACTIVE / PAUSED
// ==========================================
router.patch("/:id/toggle", auth, async (req, res) => {
  try {
    const filter = { _id: req.params.id, userId: getUserId(req) };
    let next = req.body.isActive;

    if (next === undefined) {
      const current = await BotReply.findOne(filter).select("isActive").lean();
      if (!current) return res.status(404).json({ success: false, message: "Rule not found." });
      next = !(current.isActive ?? true);
    }

    const rule = await BotReply.findOneAndUpdate(filter, { isActive: toBool(next) }, { new: true });
    if (!rule) return res.status(404).json({ success: false, message: "Rule not found." });

    res.json({ success: true, data: rule });
  } catch (error) {
    respondError(res, error, "toggle");
  }
});

// ==========================================
// 6. DUPLICATE (created as paused)
// ==========================================
router.post("/:id/duplicate", auth, async (req, res) => {
  try {
    const userId = getUserId(req);

    const quota = await getQuota(userId);
    if (quota.used >= quota.limit) {
      return res.status(403).json({
        success: false,
        quotaExceeded: true,
        message: `Your '${quota.plan}' plan allows up to ${quota.limit} keyword replies. Upgrade to add more.`,
      });
    }

    const source = await BotReply.findOne({ _id: req.params.id, userId }).lean();
    if (!source) return res.status(404).json({ success: false, message: "Rule not found." });

    const taken = new Set(
      (await BotReply.find({ userId, keyword: new RegExp("^" + escapeRegex(source.keyword) + "-copy") })
        .select("keyword")
        .lean()).map((r) => r.keyword)
    );
    let keyword = `${source.keyword}-copy`;
    for (let n = 2; taken.has(keyword); n++) keyword = `${source.keyword}-copy-${n}`;

    const { _id, createdAt, updatedAt, hitCount, lastTriggeredAt, __v, ...fields } = source;
    const copy = await BotReply.create({ ...fields, keyword, isActive: false });

    res.status(201).json({ success: true, message: "Reply duplicated.", data: copy });
  } catch (error) {
    respondError(res, error, "duplicate");
  }
});

// ==========================================
// 7. DELETE
// ==========================================
router.delete("/:id", auth, async (req, res) => {
  try {
    const deleted = await BotReply.findOneAndDelete({ _id: req.params.id, userId: getUserId(req) });
    if (!deleted) return res.status(404).json({ success: false, message: "Rule not found." });

    await cleanupMedia(deleted.mediaUrl);
    res.json({ success: true, message: "Reply deleted." });
  } catch (error) {
    respondError(res, error, "delete");
  }
});

module.exports = router;