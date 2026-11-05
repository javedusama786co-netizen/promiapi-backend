const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const axios = require('axios');
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Group = require('../models/Group');
const auth = require('../middleware/auth');
const CF = require('../utils/customFields');          // 🧩 custom fields engine
const CustomField = require('../models/CustomField');

// ⚡ Centralized Baileys Service Import for DP fetching
const { getActiveSocket, fetchUserProfilePicture } = require('../routes/whatsappBaileysService');

let WhatsAppConfig = mongoose.models.WhatsAppConfig || null;

if (!WhatsAppConfig) {
  const possiblePaths = [
    '../models/whatsappConfigModel',
    '../models/whatsappConfig',
    '../models/WhatsAppConfig'
  ];

  for (const path of possiblePaths) {
    try {
      WhatsAppConfig = require(path);
      if (WhatsAppConfig) break;
    } catch (e) {}
  }
}

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

function formatToInternationalPhone(phoneStr) {
  if (!phoneStr) return '';
  let cleaned = String(phoneStr).replace(/\D/g, '');

  if (cleaned.startsWith('9203') && cleaned.length === 12) {
    cleaned = '92' + cleaned.substring(3);
  } else if (cleaned.startsWith('03') && cleaned.length === 11) {
    cleaned = '92' + cleaned.substring(1);
  }
  return cleaned;
}


// 🖼️ Profile pictures are now stored as "/uploads/dp-<phone>-<time>.jpg" (permanent copy in R2). A relative path in an
// <img> tag would be looked up on the WEBSITE's domain and 404, so the API must return the full server address.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://api.promiapi.com";
function dpForFrontend(url) {
  if (!url) return null;
  const s = String(url);
  if (s.startsWith("/uploads/") || s.startsWith("uploads/")) {
    return `${PUBLIC_BASE_URL.replace(/\/$/, "")}${s.startsWith("/") ? s : `/${s}`}`;
  }
  return s;
}
function withAbsoluteDp(doc) {
  const o = doc && typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  if (o.profilePicUrl) o.profilePicUrl = dpForFrontend(o.profilePicUrl);
  return o;
}

// 🟢 Owner / scope resolver — config aur QR socket hamesha admin (adminId || id) ke naam par hote hain
function resolveOwner(user) {
  const userId = user.id || user._id;
  const adminId = user.adminId || null;
  const role = user.role ? String(user.role).toLowerCase() : 'admin';
  const ownerId = adminId || userId;
  const scope = (role === 'agent' && adminId)
    ? { $or: [{ userId: userId }, { userId: adminId }] }
    : { $or: [{ userId: userId }, { adminId: userId }] };
  return { userId, adminId, ownerId, role, scope };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 🟢 Helper Function to Fetch WhatsApp DP via Active Baileys Socket
async function fetchContactDp(phone, userId) {
  try {
    const activeSock = getActiveSocket(userId) || getActiveSocket(String(userId));
    if (!activeSock) return null;
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    const jid = `${cleanPhone}@s.whatsapp.net`;
    // permanent local copy (/uploads/dp-<phone>.jpg) instead of WhatsApp's expiring link
    return (await fetchUserProfilePicture(activeSock, jid)) || null;
  } catch (err) {
    return null;
  }
}

// 🧩 Excel/CSV headers that already mean something (everything else may become a custom field)
const BUILTIN_HEADERS = new Set(['name', 'contactname', 'platform', 'phone', 'number', 'mobile', 'recipientid', 'id', 'instagramid', 'facebookid', 'tags', 'group', 'sourcead']);
const headerKey = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** maps spreadsheet headers to custom field keys. returns { map:{header:key}, ignored:[header], created:[key] } */
async function mapCustomColumns({ headers, defsMap, columnMapInput, autoCreate, ownerId, canCreate }) {
  const map = {}, ignored = [], created = [];
  const byLabel = {};
  Object.values(defsMap).forEach((d) => { byLabel[String(d.label || '').trim().toLowerCase()] = d.key; });
  let total = Object.keys(defsMap).length;

  for (const header of headers) {
    const h = String(header || '').trim();
    if (!h || BUILTIN_HEADERS.has(headerKey(h))) continue;

    // 1) explicit mapping from the screen: { "Shehar": "city", "Notes": "" }  ("" = ignore this column)
    if (Object.prototype.hasOwnProperty.call(columnMapInput, header)) {
      const target = String(columnMapInput[header] || '').trim().toLowerCase();
      if (target && defsMap[target]) map[header] = target; else ignored.push(h);
      continue;
    }
    // 2) same key / same label (also accepts "cf_city" and "custom_city")
    const stripped = h.replace(/^(cf|custom)[\s_.-]+/i, '');
    const candidate = [CF.normalizeKey(h), CF.normalizeKey(stripped)].find((k) => defsMap[k]) || byLabel[h.toLowerCase()] || byLabel[stripped.toLowerCase()];
    if (candidate) { map[header] = candidate; continue; }

    // 3) optional: create a new text field for this column
    if (autoCreate && canCreate && total < 50) {
      const key = CF.normalizeKey(stripped);
      if (CF.isValidKey(key) && !CF.isReservedKey(key)) {
        try {
          const def = await CustomField.findOneAndUpdate(
            { userId: ownerId, key },
            { $setOnInsert: { userId: ownerId, key, label: stripped.slice(0, 60), type: 'text', aiRead: true, aiWrite: true, sortOrder: total } },
            { upsert: true, new: true }
          ).lean();
          defsMap[def.key] = def; map[header] = def.key; created.push(def.key); total++;
          continue;
        } catch (e) { console.error('Auto-create field error:', e.message); }
      }
    }
    ignored.push(h);
  }
  if (created.length) CF.invalidateDefs(ownerId);
  return { map, ignored, created };
}

function resolveContactIds({ platform, phone, recipientId, facebookId, instagramId }) {
  const activePlatform = String(platform || 'whatsapp').toLowerCase();
  const rawPhone = phone ? String(phone).trim() : '';
  const recId = recipientId || facebookId || instagramId || null;

  if (activePlatform === 'whatsapp') {
    const formatted = formatToInternationalPhone(rawPhone || recId || '');
    return {
      platform: 'whatsapp',
      phone: formatted || null,
      recipientId: formatted || recId || null,
      facebookId: null,
      instagramId: null
    };
  }

  if (activePlatform === 'instagram') {
    const ig = instagramId || recId || rawPhone || null;
    return {
      platform: 'instagram',
      phone: null,
      recipientId: ig,
      facebookId: null,
      instagramId: ig
    };
  }

  if (activePlatform === 'messenger' || activePlatform === 'facebook') {
    const fb = facebookId || recId || rawPhone || null;
    return {
      platform: 'messenger',
      phone: null,
      recipientId: fb,
      facebookId: fb,
      instagramId: null
    };
  }

  return {
    platform: activePlatform,
    phone: rawPhone || null,
    recipientId: recId || rawPhone || null,
    facebookId: null,
    instagramId: null
  };
}

// 🟢 WHATSAPP STATUS CHECK
// Returns { status, phone, checked }
//   checked = true  -> number asal mein verify hua (Baileys QR socket se)
//   checked = false -> verify nahi ho saka (Official Cloud API mein pehle se check ka endpoint hi nahi hai,
//                      ya temporary error). Aise number ko kabhi INVALID mark nahi karte.
async function checkWhatsAppStatus(phone, ownerId) {
  const cleanPhone = formatToInternationalPhone(phone);
  if (!cleanPhone) return { status: 'INVALID', phone: cleanPhone, checked: true };

  const activeSock = getActiveSocket(ownerId) || getActiveSocket(String(ownerId));
  if (!activeSock) {
    return { status: 'ACTIVE', phone: cleanPhone, checked: false };
  }

  try {
    const [result] = await activeSock.onWhatsApp(cleanPhone);
    if (result && result.exists) {
      return { status: 'ACTIVE', phone: (result.jid ? result.jid.split('@')[0] : cleanPhone), checked: true };
    }
    return { status: 'INVALID', phone: cleanPhone, checked: true };
  } catch (err) {
    console.warn(`⚠️ Baileys check warning for ${phone}:`, err.message);
    return { status: 'ACTIVE', phone: cleanPhone, checked: false };
  }
}

// =========================================================
// 🛡️ BULK WHATSAPP VERIFICATION — sirf wo contacts jo abhi check nahi hue (waCheckedAt == null)
// =========================================================
router.post('/verify-whatsapp', auth, async (req, res) => {
  try {
    const { ownerId, scope } = resolveOwner(req.user);
    const activeSock = getActiveSocket(ownerId) || getActiveSocket(String(ownerId));

    const baseQuery = { $and: [scope, { platform: 'whatsapp' }] };
    const totalWhatsApp = await Contact.countDocuments(baseQuery);

    if (totalWhatsApp === 0) {
      return res.status(400).json({ success: false, message: "Verification ke liye koi WhatsApp contact maujood nahi hai." });
    }

    const pendingQuery = { $and: [scope, { platform: 'whatsapp' }, { waCheckedAt: null }] };
    const pendingCount = await Contact.countDocuments(pendingQuery);
    const alreadyCheckedCount = totalWhatsApp - pendingCount;

    const emptyStats = { verifiedCount: 0, activeCount: 0, invalidCount: 0, failedCount: 0, alreadyCheckedCount, totalWhatsApp };

    if (pendingCount === 0) {
      return res.json({
        success: true,
        message: "Sab WhatsApp numbers pehle se check ho chuke hain. Koi naya number verify karne ke liye nahi hai.",
        stats: emptyStats
      });
    }

    // Official Meta Cloud API: number pehle se verify karne ka koi endpoint maujood nahi.
    if (!activeSock) {
      return res.json({
        success: true,
        skipped: true,
        message: "Official WhatsApp Cloud API mein numbers ko pehle se verify nahi kiya ja sakta. Message bhejne par agar number WhatsApp par na ho to woh khud INVALID ho jayega.",
        stats: emptyStats
      });
    }

    let verifiedCount = 0;
    let activeCount = 0;
    let invalidCount = 0;
    let failedCount = 0;
    let consecutiveFailures = 0;

    const cursor = Contact.find(pendingQuery).select('_id phone phoneNumber').lean().cursor();

    for await (const contact of cursor) {
      const phone = formatToInternationalPhone(contact.phone || contact.phoneNumber);

      if (!phone) {
        await Contact.updateOne({ _id: contact._id }, { $set: { status: 'INVALID', waCheckedAt: new Date() } });
        invalidCount++;
        verifiedCount++;
        continue;
      }

      try {
        const [result] = await activeSock.onWhatsApp(phone);
        consecutiveFailures = 0;

        if (result && result.exists) {
          const set = { status: 'ACTIVE', waCheckedAt: new Date() };
          if (result.jid) {
            const jidPhone = result.jid.split('@')[0];
            set.phone = jidPhone;
            set.recipientId = jidPhone;
          }
          await Contact.updateOne({ _id: contact._id }, { $set: set });
          activeCount++;
        } else {
          await Contact.updateOne({ _id: contact._id }, { $set: { status: 'INVALID', waCheckedAt: new Date() } });
          invalidCount++;
        }
        verifiedCount++;
      } catch (err) {
        // Temporary error ko INVALID nahi maante — contact unchecked rehta hai, agli dafa dobara check hoga
        console.warn(`⚠️ Baileys onWhatsApp warning for ${phone}:`, err.message);
        failedCount++;
        consecutiveFailures++;
        if (consecutiveFailures >= 5) {
          console.error("❌ Verification roki gayi: lagatar 5 errors (socket disconnect ho sakta hai).");
          break;
        }
      }

      await sleep(120); // WhatsApp ko flood na karein
    }

    const stoppedEarly = consecutiveFailures >= 5;
    return res.json({
      success: true,
      message: stoppedEarly
        ? `Verification beech mein ruk gayi (WhatsApp session mein masla). Checked: ${verifiedCount} | Baaqi unchecked hain, dobara click karein.`
        : `Verification mukammal! Naye checked: ${verifiedCount} | Active: ${activeCount} | Invalid: ${invalidCount}` +
          (failedCount ? ` | Check na ho sake: ${failedCount}` : '') +
          (alreadyCheckedCount ? ` | Pehle se checked (skip): ${alreadyCheckedCount}` : ''),
      stats: { verifiedCount, activeCount, invalidCount, failedCount, alreadyCheckedCount, totalWhatsApp }
    });

  } catch (err) {
    console.error("❌ Bulk WhatsApp Verification Error:", err);
    return res.status(500).json({ success: false, message: "WhatsApp verification process fail ho gaya." });
  }
});

router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const adminId = req.user.adminId;
    const role = req.user.role ? req.user.role.toLowerCase() : 'admin';
    const { tag, group, sourceAd, platform } = req.query;

    let query = {};

    if (role === 'agent' && adminId) {
      query = { $or: [{ userId: userId }, { userId: adminId }] };
    } else {
      query = { $or: [{ userId: userId }, { adminId: userId }] };
    }

    if (tag && tag !== 'All') query.tags = { $in: [tag] };
    if (group && group !== 'All') query.group = group;
    if (sourceAd && sourceAd !== 'All') query.sourceAd = sourceAd;
    if (platform && platform !== 'All') query.platform = platform.toLowerCase();

    // 🧩 custom field filters:  ?filter={"match":"all","conditions":[{"field":"city","op":"eq","value":"Lahore"}]}   or   ?cf[city]=Lahore
    const defsMap = await CF.loadDefsMap(adminId || userId);
    const extra = [];
    const advanced = CF.parseJsonLoose(req.query.filter);
    if (advanced) {
      const built = CF.buildAudienceQuery(advanced, defsMap);
      if (built.errors.length) return res.status(400).json({ success: false, message: 'Invalid filter.', errors: built.errors });
      extra.push(built.query);
    }
    if (req.query.cf && typeof req.query.cf === 'object') {
      const simple = Object.entries(req.query.cf).slice(0, 20).map(([field, value]) => ({ field, op: 'eq', value }));
      const built = CF.buildAudienceQuery({ match: 'all', conditions: simple }, defsMap);
      if (built.errors.length) return res.status(400).json({ success: false, message: 'Invalid filter.', errors: built.errors });
      extra.push(built.query);
    }
    if (extra.length) query = { $and: [query, ...extra] };

    const contacts = await Contact.find(query).sort({ createdAt: -1 });
    res.json({ success: true, contacts: contacts.map(withAbsoluteDp), customFieldDefs: Object.values(defsMap) });
  } catch (err) {
    console.error("Fetch Contacts Error:", err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

router.post('/add', auth, async (req, res) => {
  const { platform, name, phone, recipientId, facebookId, instagramId, group, tags, sourceAd, customFields } = req.body;
  try {
    const { userId, adminId, ownerId, role } = resolveOwner(req.user);

    let parsedTags = [];
    if (Array.isArray(tags)) {
      parsedTags = tags;
    } else if (typeof tags === 'string' && tags.trim().length > 0) {
      parsedTags = tags.split(',').map(t => t.trim()).filter(Boolean);
    }

    const selectedGroup = group ? group.trim() : 'General Leads';
    const ids = resolveContactIds({ platform, phone, recipientId, facebookId, instagramId });

    if (!ids.phone && !ids.recipientId && !ids.instagramId && !ids.facebookId) {
      return res.status(400).json({
        success: false,
        message: ids.platform === 'whatsapp' 
          ? "Phone number is required for WhatsApp contacts." 
          : "Recipient ID is required for social messaging."
      });
    }

    // 🧩 custom fields sent with the new contact
    let cfValues = {};
    const cfInput = CF.parseJsonLoose(customFields);
    if (cfInput) {
      const checked = CF.validateFieldInput(await CF.loadDefsMap(ownerId), cfInput);
      if (checked.errors.length) {
        return res.status(400).json({ success: false, message: 'Some custom fields are invalid.', errors: checked.errors });
      }
      cfValues = checked.values;
    }
    const cfMeta = {};
    const nowStamp = new Date();
    Object.keys(cfValues).forEach((k) => { cfMeta[k] = { source: 'manual', at: nowStamp }; });
    if (name && String(name).trim()) cfMeta.name = { source: 'manual', at: nowStamp };

    const groupOwnerId = (role === 'agent' && adminId) ? adminId : userId;

    if (selectedGroup !== 'All') {
      await Group.findOneAndUpdate(
        { name: selectedGroup, userId: groupOwnerId },
        { name: selectedGroup, userId: groupOwnerId, adminId: adminId },
        { upsert: true, new: true }
      );
    }

    let calculatedStatus = 'ACTIVE';
    let dpUrl = null;
    let waCheckedAt = null;

    if (ids.platform === 'whatsapp' && ids.phone) {
      const waCheck = await checkWhatsAppStatus(ids.phone, ownerId);
      calculatedStatus = waCheck.status;
      ids.phone = waCheck.phone;
      ids.recipientId = waCheck.phone;
      if (waCheck.checked) waCheckedAt = new Date();

      if (calculatedStatus === 'ACTIVE' && waCheck.checked) {
        dpUrl = await fetchContactDp(ids.phone, ownerId);
      }
    }

    const newContact = new Contact({
      userId: userId,
      adminId: adminId,
      platform: ids.platform,
      name: name || "Unknown Customer",
      phone: ids.phone,
      recipientId: ids.recipientId,
      facebookId: ids.facebookId,
      instagramId: ids.instagramId,
      profilePicUrl: dpUrl,
      group: selectedGroup,
      sourceAd: sourceAd || null,
      tags: parsedTags,
      status: calculatedStatus,
      waCheckedAt: waCheckedAt,
      customFields: cfValues,
      customFieldMeta: cfMeta
    });

    const contact = await newContact.save();

    res.json({
      success: true,
      message: calculatedStatus === 'INVALID'
        ? "Contact saved but marked as INVALID (Not on WhatsApp)."
        : "Contact saved successfully!",
      contact: withAbsoluteDp(contact)
    });
  } catch (err) {
    console.error("Single Add Error:", err);
    res.status(500).json({ success: false, message: 'Failed to add contact' });
  }
});

router.post('/bulk-import', auth, upload.single('excelFile'), async (req, res) => {
  try {
    const { userId, adminId, ownerId } = resolveOwner(req.user);
    const defaultGroup = req.body.group || 'General Leads';

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please upload an Excel or CSV file.' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    const excelRows = XLSX.utils.sheet_to_json(worksheet, { raw: false, defval: '' });

    if (excelRows.length === 0) {
      return res.status(400).json({ success: false, message: 'Excel sheet is empty.' });
    }

    // 🧩 spreadsheet columns -> custom fields (matched by key/label, explicit columnMap, or auto-created text fields)
    const defsMap = await CF.loadDefsMap(ownerId);
    const colMap = await mapCustomColumns({
      headers: Object.keys(excelRows[0] || {}),
      defsMap,
      columnMapInput: CF.parseJsonLoose(req.body.columnMap) || {},
      autoCreate: String(req.body.autoCreateFields || '').toLowerCase() === 'true',
      ownerId,
      canCreate: String(req.user.role || 'admin').toLowerCase() !== 'agent'
    });
    const fieldWarnings = [];
    const buildRowCustomFields = (row, rowIndex) => {
      const raw = {};
      Object.entries(colMap.map).forEach(([header, key]) => {
        if (row[header] !== undefined && String(row[header]).trim() !== '') raw[key] = row[header];
      });
      const checked = CF.validateFieldInput(defsMap, raw);
      checked.errors.forEach((e) => fieldWarnings.push({ row: rowIndex + 2, ...e })); // +2: header row + 1-based
      const at = new Date();
      const meta = {};
      Object.keys(checked.values).forEach((k) => { meta[k] = { source: 'import', at }; });
      return { customFields: checked.values, customFieldMeta: meta };
    };

    const processRow = async (row, rowIndex = 0) => {
      const cfPart = buildRowCustomFields(row, rowIndex);
      const rawName = String(row.Name || row.name || row['Contact Name'] || '').trim();
      const rawPlatform = String(row.Platform || row.platform || req.body.platform || 'whatsapp').toLowerCase().trim();
      
      const rawPhone = String(row.Phone || row.phone || row.Number || row.Mobile || '').replace(/\+/g, '').trim();
      const rawRecipientId = String(row.RecipientId || row.recipientId || row['Recipient ID'] || row.ID || row.InstagramId || row.FacebookId || '').trim();
      
      const rawTags = row.Tags || row.tags || '';
      let tagsArray = [];
      if (typeof rawTags === 'string' && rawTags.trim().length > 0) {
        tagsArray = rawTags.split(',').map(t => t.trim()).filter(Boolean);
      }

      if (rawPlatform === 'whatsapp') {
        if (!rawName || !rawPhone) return null;

        const waCheck = await checkWhatsAppStatus(rawPhone, ownerId);
        let dpUrl = null;
        if (waCheck.status === 'ACTIVE' && waCheck.checked) {
          dpUrl = await fetchContactDp(waCheck.phone, ownerId);
        }

        return {
          userId,
          adminId,
          platform: 'whatsapp',
          name: rawName,
          phone: waCheck.phone,
          recipientId: waCheck.phone,
          profilePicUrl: dpUrl,
          group: row.Group || row.group || defaultGroup,
          sourceAd: row.SourceAd || row.sourceAd || null,
          tags: tagsArray,
          ...cfPart,
          status: waCheck.status,
          waCheckedAt: waCheck.checked ? new Date() : null
        };
      }

      if (rawPlatform === 'instagram') {
        if (!rawName || !rawRecipientId) return null;

        return {
          userId,
          adminId,
          platform: 'instagram',
          name: rawName,
          recipientId: rawRecipientId,
          instagramId: rawRecipientId,
          group: row.Group || row.group || defaultGroup,
          sourceAd: row.SourceAd || row.sourceAd || null,
          tags: tagsArray,
          ...cfPart,
          status: 'ACTIVE'
        };
      }

      if (rawPlatform === 'messenger' || rawPlatform === 'facebook') {
        if (!rawName || !rawRecipientId) return null;

        return {
          userId,
          adminId,
          platform: 'messenger',
          name: rawName,
          recipientId: rawRecipientId,
          facebookId: rawRecipientId,
          group: row.Group || row.group || defaultGroup,
          sourceAd: row.SourceAd || row.sourceAd || null,
          tags: tagsArray,
          ...cfPart,
          status: 'ACTIVE'
        };
      }

      return null;
    };

    // Saari rows ek saath nahi — 5-5 ke batch mein (WhatsApp/DB par bojh kam)
    const resolvedContacts = [];
    const BATCH = 5;
    for (let i = 0; i < excelRows.length; i += BATCH) {
      const part = await Promise.all(excelRows.slice(i, i + BATCH).map((row, j) => processRow(row, i + j)));
      resolvedContacts.push(...part);
    }
    const validContacts = resolvedContacts.filter(Boolean);

    if (validContacts.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No valid contacts found. Please ensure Name and Phone (for WhatsApp) or Recipient ID (for Instagram/Messenger) are present.' 
      });
    }

    const insertedContacts = await Contact.insertMany(validContacts);

    res.json({
      success: true,
      count: insertedContacts.length,
      insertedContacts,
      customFields: {
        mappedColumns: colMap.map,
        ignoredColumns: colMap.ignored,
        createdFields: colMap.created,
        warningCount: fieldWarnings.length,
        warnings: fieldWarnings.slice(0, 50)
      }
    });
  } catch (err) {
    console.error('Bulk import error:', err);
    res.status(500).json({ success: false, message: 'Bulk creation failed on server side.' });
  }
});

router.patch('/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    const userId = req.user.id || req.user._id;

    const validStatuses = ['ACTIVE', 'UNSUBSCRIBED', 'BLOCKED', 'INVALID'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status value' });
    }

    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, userId: userId },
      { status: status },
      { new: true }
    );

    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found or unauthorized' });
    }

    res.json({ success: true, contact: withAbsoluteDp(contact) });
  } catch (err) {
    console.error("Update Status Error:", err);
    res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

router.patch('/:id/group', auth, async (req, res) => {
  try {
    const { group } = req.body;
    const userId = req.user.id || req.user._id;

    if (!group) {
      return res.status(400).json({ success: false, message: 'Group name is required' });
    }

    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, userId: userId },
      { group: group.trim() },
      { new: true }
    );

    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found or unauthorized' });
    }

    res.json({ success: true, contact: withAbsoluteDp(contact) });
  } catch (err) {
    console.error("Update Group Error:", err);
    res.status(500).json({ success: false, message: 'Failed to update contact group' });
  }
});

router.patch('/:id/tags', auth, async (req, res) => {
  try {
    const { tags } = req.body;
    const userId = req.user.id || req.user._id;

    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, userId: userId },
      { $addToSet: { tags: {$each: tags } } },
      { new: true }
    );

    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found or unauthorized' });
    }

    res.json({ success: true, contact: withAbsoluteDp(contact) });
  } catch (err) {
    console.error("Update Tags Error:", err);
    res.status(500).json({ success: false, message: 'Failed to update tags' });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const contact = await Contact.findOneAndDelete({ _id: req.params.id, userId: userId });

    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found or unauthorized' });
    }

    res.json({ success: true, message: 'Contact removed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =========================================================================
// 🧩 CUSTOM FIELD VALUES
// =========================================================================

// Set / clear custom field values (and the name) of ONE contact.  Body: { fields: { city: "Lahore", budget: 50000 }, clear: ["interest"] }
router.patch('/:id/custom-fields', auth, async (req, res) => {
  try {
    const { userId, ownerId, scope } = resolveOwner(req.user);
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid contact id.' });

    const contact = await Contact.findOne({ _id: req.params.id, ...scope }).lean();
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found or unauthorized' });

    const updates = { ...(req.body && typeof req.body.fields === 'object' && req.body.fields ? req.body.fields : {}) };
    (Array.isArray(req.body?.clear) ? req.body.clear : []).forEach((k) => { updates[String(k).toLowerCase()] = null; });
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, message: 'Send { fields: {...} } or { clear: [...] }.' });

    const result = await CF.applyContactFieldUpdates(contact, updates, { ownerId, source: 'manual', actor: userId });
    if (result.rejected.length && !result.applied.length && !result.unchanged.length) {
      return res.status(400).json({ success: false, message: 'No custom field was saved.', result });
    }
    const fresh = await Contact.findById(contact._id);
    res.json({ success: true, contact: withAbsoluteDp(fresh), result });
  } catch (err) {
    console.error('Update Custom Fields Error:', err);
    res.status(500).json({ success: false, message: 'Failed to update custom fields' });
  }
});

// Bulk edit.  Body: { contactIds:[...] | filter:{...} | group:"Leads",  fields:{ city:"Lahore" }  |  clear:["city"],  onlyIfEmpty:true }
router.post('/bulk-fields', auth, async (req, res) => {
  try {
    const { userId, ownerId, scope } = resolveOwner(req.user);
    const body = req.body || {};
    const defsMap = await CF.loadDefsMap(ownerId);

    const updates = { ...(body.fields && typeof body.fields === 'object' ? body.fields : {}) };
    (Array.isArray(body.clear) ? body.clear : []).forEach((k) => { updates[String(k).toLowerCase()] = null; });
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, message: 'Send fields to set or keys to clear.' });
    if ('name' in updates) return res.status(400).json({ success: false, message: 'Bulk edit does not change names.' });

    const and = [{ $or: scope.$or }];
    if (Array.isArray(body.contactIds) && body.contactIds.length) {
      const ids = body.contactIds.filter((id) => mongoose.Types.ObjectId.isValid(id)).slice(0, 5000);
      if (!ids.length) return res.status(400).json({ success: false, message: 'No valid contact ids.' });
      and.push({ _id: { $in: ids } });
    } else if (body.filter || body.group) {
      const built = CF.buildAudienceQuery(CF.parseJsonLoose(body.filter), defsMap);
      if (built.errors.length) return res.status(400).json({ success: false, message: 'Invalid filter.', errors: built.errors });
      and.push(CF.buildGroupFilter(body.group || 'All'), built.query);
    } else {
      return res.status(400).json({ success: false, message: 'Send contactIds, or a filter / group to choose the contacts.' });
    }

    const contacts = await Contact.find({ $and: and }).limit(5000).lean();
    let updated = 0, unchanged = 0;
    const problems = [];
    for (let i = 0; i < contacts.length; i += 25) {
      const part = await Promise.all(contacts.slice(i, i + 25).map((c) => {
        let u = updates;
        if (body.onlyIfEmpty === true) {
          u = Object.fromEntries(Object.entries(updates).filter(([k]) => c.customFields?.[k] === undefined || c.customFields?.[k] === null || c.customFields?.[k] === ''));
        }
        return CF.applyContactFieldUpdates(c, u, { ownerId, source: 'bulk', actor: userId, defsMap });
      }));
      part.forEach((r) => {
        if (r.applied.length) updated++; else unchanged++;
        r.rejected.forEach((x) => { if (problems.length < 20 && !problems.some((p) => p.key === x.key && p.error === x.error)) problems.push(x); });
      });
    }
    res.json({ success: true, matched: contacts.length, updated, unchanged, problems });
  } catch (err) {
    console.error('Bulk Custom Fields Error:', err);
    res.status(500).json({ success: false, message: 'Bulk update failed' });
  }
});

module.exports = router;