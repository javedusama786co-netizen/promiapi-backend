const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const axios = require('axios');
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Group = require('../models/Group');
const auth = require('../middleware/auth');

// ⚡ Centralized Baileys Service Import for DP fetching
const { getActiveSocket } = require('../routes/whatsappBaileysService');

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
    const ppUrl = await activeSock.profilePictureUrl(jid, "image");
    return ppUrl || null;
  } catch (err) {
    return null;
  }
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

    const contacts = await Contact.find(query).sort({ createdAt: -1 });
    res.json({ success: true, contacts });
  } catch (err) {
    console.error("Fetch Contacts Error:", err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

router.post('/add', auth, async (req, res) => {
  const { platform, name, phone, recipientId, facebookId, instagramId, group, tags, sourceAd } = req.body;
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
      waCheckedAt: waCheckedAt
    });

    const contact = await newContact.save();

    res.json({
      success: true,
      message: calculatedStatus === 'INVALID'
        ? "Contact saved but marked as INVALID (Not on WhatsApp)."
        : "Contact saved successfully!",
      contact
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

    const processRow = async (row) => {
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
          status: 'ACTIVE'
        };
      }

      return null;
    };

    // Saari rows ek saath nahi — 5-5 ke batch mein (WhatsApp/DB par bojh kam)
    const resolvedContacts = [];
    const BATCH = 5;
    for (let i = 0; i < excelRows.length; i += BATCH) {
      const part = await Promise.all(excelRows.slice(i, i + BATCH).map(processRow));
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
      insertedContacts
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

    res.json({ success: true, contact });
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

    res.json({ success: true, contact });
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

    res.json({ success: true, contact });
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

module.exports = router;