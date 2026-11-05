const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const Contact = require("../models/Contact");
const CustomField = require("../models/CustomField");
const History = require("../models/ContactFieldHistory");
const AiBotSettings = mongoose.models.AiBotSettings || require("../models/AiBotSettings");
const CF = require("../utils/customFields");

const MAX_FIELDS_PER_ACCOUNT = 50;

// Express 5 (path-to-regexp v8) no longer allows a regex inside a path like "/:id([0-9a-fA-F]{24})".
// Same behaviour, new way: the route only handles real 24-character Mongo ids; anything else is skipped with
// next("route"), so paths such as PUT "/ai-settings" or POST "/reorder" still reach their own handlers.
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const onlyObjectId = (req, res, next) => (OBJECT_ID_RE.test(String(req.params.id)) ? next() : next("route"));

// same ownership rules as routes/contacts.js
function owner(req) {
  const userId = req.user.id || req.user._id;
  const adminId = req.user.adminId || null;
  const role = req.user.role ? String(req.user.role).toLowerCase() : "admin";
  const ownerId = adminId || userId;
  const scopeConditions = role === "agent" && adminId ? [{ userId }, { userId: adminId }] : [{ userId }, { adminId: userId }];
  return { userId, adminId, role, ownerId, scopeConditions, canManage: role !== "agent" };
}

const deny = (res) => res.status(403).json({ success: false, message: "Only the account owner / admin can change custom fields." });
const fail = (res, err, label) => {
  console.error(`CustomFields ${label} Error:`, err);
  if (err && err.code === 11000) return res.status(409).json({ success: false, message: "A field with this key already exists." });
  if (err && err.name === "ValidationError") return res.status(400).json({ success: false, message: Object.values(err.errors).map((e) => e.message).join(" ") });
  return res.status(500).json({ success: false, message: "Server error" });
};

const recipientFor = (platform) => (c) => {
  const p = String(platform || "").toLowerCase();
  if (p === "instagram") return c.instagramId || c.recipientId;
  if (p === "messenger" || p === "facebook") return c.facebookId || c.recipientId;
  if (p === "whatsapp") return c.phone || c.recipientId;
  return c.phone || c.recipientId || c.instagramId || c.facebookId;
};

// ------------------------------------------------------------- list
router.get("/", auth, async (req, res) => {
  try {
    const { ownerId } = owner(req);
    const fields = await CustomField.find({ userId: ownerId }).sort({ sortOrder: 1, createdAt: 1 }).lean();
    res.json({
      success: true,
      fields,
      types: CF.FIELD_TYPES,
      builtinVariables: CF.BUILTIN_VARIABLES.map((k) => ({ key: k, token: `{{${k}}}` })),
      limit: MAX_FIELDS_PER_ACCOUNT,
    });
  } catch (err) { fail(res, err, "List"); }
});

// everything that can be inserted into a message ({{name}}, {{city}} ...) - for the "Insert variable" button
router.get("/variables", auth, async (req, res) => {
  try {
    const { ownerId } = owner(req);
    const defs = await CF.loadDefsMap(ownerId);
    const builtin = CF.BUILTIN_VARIABLES.map((k) => ({ key: k, label: k.replace(/_/g, " "), token: `{{${k}}}`, type: "builtin" }));
    const custom = Object.values(defs).map((d) => ({ key: d.key, label: d.label, token: `{{${d.key}}}`, tokenWithFallback: `{{${d.key}|${d.defaultValue || "..."}}}`, type: d.type }));
    res.json({ success: true, variables: [...builtin, ...custom] });
  } catch (err) { fail(res, err, "Variables"); }
});

// ------------------------------------------------------------- create
router.post("/", auth, async (req, res) => {
  try {
    const { ownerId, canManage } = owner(req);
    if (!canManage) return deny(res);

    const { label, type, options, defaultValue, description, aiRead, aiWrite } = req.body || {};
    const key = CF.normalizeKey(req.body?.key || label);
    if (!String(label || "").trim()) return res.status(400).json({ success: false, message: "Field label is required." });
    if (!CF.isValidKey(key)) return res.status(400).json({ success: false, message: "Invalid field key." });
    if (CF.isReservedKey(key)) return res.status(400).json({ success: false, message: `"${key}" is a reserved name. Choose another key.` });
    if (type && !CF.FIELD_TYPES.includes(type)) return res.status(400).json({ success: false, message: `Type must be one of: ${CF.FIELD_TYPES.join(", ")}.` });

    const count = await CustomField.countDocuments({ userId: ownerId });
    if (count >= MAX_FIELDS_PER_ACCOUNT) return res.status(400).json({ success: false, message: `You can create at most ${MAX_FIELDS_PER_ACCOUNT} custom fields.` });

    const optionList = Array.isArray(options) ? options : typeof options === "string" ? options.split(",") : [];
    const field = await CustomField.create({
      userId: ownerId, key, label: String(label).trim(), type: type || "text", options: optionList,
      defaultValue: defaultValue || "", description: description || "",
      aiRead: aiRead !== false, aiWrite: aiWrite !== false, sortOrder: count,
    });
    CF.invalidateDefs(ownerId);
    res.json({ success: true, field });
  } catch (err) { fail(res, err, "Create"); }
});

// ------------------------------------------------------------- update
router.put("/:id", onlyObjectId, auth, async (req, res) => {
  try {
    const { ownerId, canManage } = owner(req);
    if (!canManage) return deny(res);
    const field = await CustomField.findOne({ _id: req.params.id, userId: ownerId });
    if (!field) return res.status(404).json({ success: false, message: "Field not found." });

    const b = req.body || {};
    const dataScope = { $or: [{ userId: ownerId }, { adminId: ownerId }] };
    const hasValue = { [`customFields.${field.key}`]: { $exists: true, $nin: [null, ""] } };

    if (b.type && b.type !== field.type) {
      if (!CF.FIELD_TYPES.includes(b.type)) return res.status(400).json({ success: false, message: "Unknown field type." });
      const used = await Contact.countDocuments({ ...dataScope, ...hasValue });
      if (used > 0) return res.status(409).json({ success: false, message: `${used} contact(s) already have a value, so the type cannot be changed. Create a new field instead.` });
      field.type = b.type;
    }

    if (b.options !== undefined && (b.type || field.type) === "select") {
      const next = (Array.isArray(b.options) ? b.options : String(b.options).split(",")).map((o) => String(o).trim()).filter(Boolean);
      const removed = (field.options || []).filter((o) => !next.some((n) => n.toLowerCase() === o.toLowerCase()));
      if (removed.length && b.force !== true) {
        const used = await Contact.countDocuments({ ...dataScope, [`customFields.${field.key}`]: { $in: removed } });
        if (used > 0) return res.status(409).json({ success: false, message: `${used} contact(s) use the option(s) you removed (${removed.join(", ")}). Send force:true to continue.`, removed, used });
      }
      field.options = next;
    }

    ["label", "defaultValue", "description"].forEach((k) => { if (b[k] !== undefined) field[k] = String(b[k]).trim(); });
    ["aiRead", "aiWrite", "isActive"].forEach((k) => { if (b[k] !== undefined) field[k] = Boolean(b[k]); });
    if (b.sortOrder !== undefined && Number.isFinite(Number(b.sortOrder))) field.sortOrder = Number(b.sortOrder);

    await field.save();
    CF.invalidateDefs(ownerId);
    res.json({ success: true, field });
  } catch (err) { fail(res, err, "Update"); }
});

router.post("/reorder", auth, async (req, res) => {
  try {
    const { ownerId, canManage } = owner(req);
    if (!canManage) return deny(res);
    const order = Array.isArray(req.body?.order) ? req.body.order.slice(0, 100) : [];
    if (!order.length) return res.status(400).json({ success: false, message: "order must be an array of field ids." });
    await CustomField.bulkWrite(order.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id, i) => ({
      updateOne: { filter: { _id: id, userId: ownerId }, update: { $set: { sortOrder: i } } },
    })));
    CF.invalidateDefs(ownerId);
    res.json({ success: true });
  } catch (err) { fail(res, err, "Reorder"); }
});

// ------------------------------------------------------------- delete (?purge=true also removes the saved values)
router.delete("/:id", onlyObjectId, auth, async (req, res) => {
  try {
    const { ownerId, canManage } = owner(req);
    if (!canManage) return deny(res);
    const field = await CustomField.findOneAndDelete({ _id: req.params.id, userId: ownerId });
    if (!field) return res.status(404).json({ success: false, message: "Field not found." });

    let purged = 0;
    if (String(req.query.purge) === "true") {
      const r = await Contact.updateMany(
        { $or: [{ userId: ownerId }, { adminId: ownerId }], [`customFields.${field.key}`]: { $exists: true } },
        { $unset: { [`customFields.${field.key}`]: "", [`customFieldMeta.${field.key}`]: "" } }
      );
      purged = r.modifiedCount ?? r.nModified ?? 0;
    }
    CF.invalidateDefs(ownerId);
    res.json({ success: true, message: purged ? `Field deleted and values removed from ${purged} contact(s).` : "Field deleted. Saved values stay on contacts but are no longer used.", purged });
  } catch (err) { fail(res, err, "Delete"); }
});

// ------------------------------------------------------------- preview a message for one contact / sample data
router.post("/preview", auth, async (req, res) => {
  try {
    const { ownerId, scopeConditions } = owner(req);
    const defsMap = await CF.loadDefsMap(ownerId);
    const { text = "", header = "", footer = "", contactId, sample } = req.body || {};

    let contact = null;
    if (contactId && mongoose.Types.ObjectId.isValid(contactId)) contact = await Contact.findOne({ _id: contactId, $or: scopeConditions }).lean();
    if (!contact) contact = sample && typeof sample === "object" ? { name: sample.name, phone: sample.phone, customFields: sample.customFields || {} } : { name: "Ali Raza", phone: "923001234567", customFields: {} };

    const ctx = CF.buildContext(contact, defsMap);
    const { content, missing, unknown } = CF.renderContent({ text, header, footer }, ctx, defsMap, { unknown: "keep" });
    res.json({ success: true, rendered: content, missingValues: missing, unknownVariables: unknown, usingContact: contact._id ? { _id: contact._id, name: contact.name } : "sample" });
  } catch (err) { fail(res, err, "Preview"); }
});

// ------------------------------------------------------------- audience preview ("142 contacts match")
router.post("/segment-preview", auth, async (req, res) => {
  try {
    const { ownerId, scopeConditions } = owner(req);
    const defsMap = await CF.loadDefsMap(ownerId);
    const b = req.body || {};
    const out = await CF.previewAudience({
      scopeConditions,
      group: b.group || b.targetGroup || "All",
      filter: CF.parseJsonLoose(b.filter),
      defsMap,
      recipientOf: recipientFor(b.platform),
      texts: [b.text, b.header, b.footer].filter((t) => typeof t === "string" && t),
      skipStatuses: Array.isArray(b.skipStatuses) ? b.skipStatuses : [],
    });
    if (!out.ok) return res.status(400).json({ success: false, message: "Audience filter is invalid.", errors: out.errors });
    res.json({ success: true, ...out, ok: undefined });
  } catch (err) { fail(res, err, "SegmentPreview"); }
});

// ------------------------------------------------------------- how many contacts have each field filled
router.get("/coverage", auth, async (req, res) => {
  try {
    const { ownerId, scopeConditions } = owner(req);
    const defs = await CustomField.find({ userId: ownerId }).sort({ sortOrder: 1 }).lean();
    const total = await Contact.countDocuments({ $or: scopeConditions });
    const fields = [];
    for (const d of defs) {
      const filled = await Contact.countDocuments({ $or: scopeConditions, [`customFields.${d.key}`]: { $exists: true, $nin: [null, ""] } });
      fields.push({ key: d.key, label: d.label, filled, percent: total ? Math.round((filled / total) * 100) : 0 });
    }
    res.json({ success: true, total, fields });
  } catch (err) { fail(res, err, "Coverage"); }
});

// ------------------------------------------------------------- change history of a contact
router.get("/history", auth, async (req, res) => {
  try {
    const { ownerId, scopeConditions } = owner(req);
    const { contactId } = req.query;
    if (!contactId || !mongoose.Types.ObjectId.isValid(contactId)) return res.status(400).json({ success: false, message: "contactId is required." });
    const contact = await Contact.findOne({ _id: contactId, $or: scopeConditions }).select("_id").lean();
    if (!contact) return res.status(404).json({ success: false, message: "Contact not found or unauthorized." });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const history = await History.find({ userId: ownerId, contactId }).sort({ at: -1 }).limit(limit).lean();
    res.json({ success: true, history });
  } catch (err) { fail(res, err, "History"); }
});

// ------------------------------------------------------------- AI switches (read / write / ask / overwrite)
const AI_DEFAULTS = { readEnabled: true, writeEnabled: true, askForMissing: false, overwriteManual: false };

router.get("/ai-settings", auth, async (req, res) => {
  try {
    const { ownerId } = owner(req);
    const s = await AiBotSettings.findOne({ userId: ownerId }).select("contactData").lean();
    res.json({ success: true, contactData: { ...AI_DEFAULTS, ...(s?.contactData || {}) } });
  } catch (err) { fail(res, err, "AiSettings"); }
});

router.put("/ai-settings", auth, async (req, res) => {
  try {
    const { ownerId, canManage } = owner(req);
    if (!canManage) return deny(res);
    const $set = {};
    Object.keys(AI_DEFAULTS).forEach((k) => { if (req.body && req.body[k] !== undefined) $set[`contactData.${k}`] = Boolean(req.body[k]); });
    if (!Object.keys($set).length) return res.status(400).json({ success: false, message: `Send at least one of: ${Object.keys(AI_DEFAULTS).join(", ")}.` });
    const s = await AiBotSettings.findOneAndUpdate({ userId: ownerId }, { $set }, { new: true, upsert: true, setDefaultsOnInsert: true }).select("contactData").lean();
    res.json({ success: true, contactData: { ...AI_DEFAULTS, ...(s?.contactData || {}) } });
  } catch (err) { fail(res, err, "AiSettingsSave"); }
});

module.exports = router;