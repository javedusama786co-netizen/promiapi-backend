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

// 🟢 STRICT WHATSAPP STATUS CHECK (FIXED: Non-WhatsApp numbers will strictly be marked INVALID)
async function checkWhatsAppStatus(phone, userId) {
  const cleanPhone = formatToInternationalPhone(phone);
  if (!cleanPhone) return { status: 'INVALID', phone: cleanPhone };

  try {
    // 1. Check via Baileys Socket if active
    const activeSock = getActiveSocket(userId) || getActiveSocket(String(userId));
    if (activeSock) {
      try {
        const [result] = await activeSock.onWhatsApp(cleanPhone);
        if (result && result.exists) {
          return { status: 'ACTIVE', phone: (result.jid ? result.jid.split('@')[0] : cleanPhone) };
        } else {
          return { status: 'INVALID', phone: cleanPhone };
        }
      } catch (bailErr) {
        console.warn(`⚠️ Baileys single check warning for ${phone}:`, bailErr.message);
      }
    }

    // 2. Check via Official Meta Cloud API if configured
    let configRecord = null;
    if (WhatsAppConfig) {
      configRecord = await WhatsAppConfig.findOne({ userId: userId, platform: { $in: ["whatsapp", "whatsapp_official"] } });
    }

    if (configRecord && configRecord.phoneNumberId && configRecord.accessToken) {
      const { phoneNumberId, accessToken } = configRecord;
      const metaUrl = `https://graph.facebook.com/v20.0/${phoneNumberId}/contacts`;

      const response = await axios.post(
        metaUrl,
        { blocking: 'wait', contacts: [`+${cleanPhone}`] },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 4000
        }
      );

      const contactResult = response.data?.contacts?.[0];
      if (contactResult && contactResult.status === 'valid') {
        return { status: 'ACTIVE', phone: contactResult.wa_id || cleanPhone };
      } else {
        return { status: 'INVALID', phone: cleanPhone };
      }
    }

    // 3. Strict Default Fallback if no active gateway is connected
    return { status: 'INVALID', phone: cleanPhone };
  } catch (err) {
    console.error(`❌ checkWhatsAppStatus error for ${phone}:`, err.message);
    return { status: 'INVALID', phone: cleanPhone };
  }
}

// =========================================================
// 🛡️ BULK WHATSAPP NUMBER VERIFICATION GATEWAY (STRICT & PROFESSIONAL)
// =========================================================
router.post('/verify-whatsapp', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const activeSock = getActiveSocket(userId) || getActiveSocket(String(userId));
    
    const contacts = await Contact.find({ 
      $or: [{ userId: userId }, { adminId: userId }],
      platform: 'whatsapp' 
    });

    if (contacts.length === 0) {
      return res.status(400).json({ success: false, message: "Verification ke liye koi WhatsApp contact maujood nahi hai." });
    }

    let verifiedCount = 0;
    let activeCount = 0;
    let invalidCount = 0;

    let configRecord = null;
    if (WhatsAppConfig) {
      configRecord = await WhatsAppConfig.findOne({ userId: userId, platform: { $in: ["whatsapp", "whatsapp_official"] } });
    }

    // 1. Baileys QR Socket Bulk Verification
    if (activeSock) {
      for (const contact of contacts) {
        const phone = contact.phone || contact.phoneNumber;
        if (!phone) continue;
        try {
          const cleanPhone = phone.replace(/\D/g, '');
          const [result] = await activeSock.onWhatsApp(cleanPhone);
          
          if (result && result.exists) {
            contact.status = 'ACTIVE';
            if (result.jid) contact.phone = result.jid.split('@')[0];
            activeCount++;
          } else {
            contact.status = 'INVALID';
            invalidCount++;
          }
          await contact.save();
          verifiedCount++;
        } catch (err) {
          console.warn(`⚠️ Baileys onWhatsApp warning for ${phone}:`, err.message);
          contact.status = 'INVALID';
          invalidCount++;
          await contact.save();
          verifiedCount++;
        }
      }
    } 
    // 2. Official Meta Cloud API Bulk Verification
    else if (configRecord && configRecord.phoneNumberId && configRecord.accessToken) {
      const { phoneNumberId, accessToken } = configRecord;
      const metaUrl = `https://graph.facebook.com/v20.0/${phoneNumberId}/contacts`;

      const chunkSize = 50;
      for (let i = 0; i < contacts.length; i += chunkSize) {
        const chunk = contacts.slice(i, i + chunkSize);
        const phoneList = chunk.map(c => {
          let p = c.phone || c.phoneNumber || '';
          p = p.replace(/\D/g, '');
          return p.startsWith('+') ? p : `+${p}`;
        });

        try {
          const response = await axios.post(
            metaUrl,
            { blocking: 'wait', contacts: phoneList },
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              },
              timeout: 10000
            }
          );

          const results = response.data?.contacts || [];
          for (let j = 0; j < chunk.length; j++) {
            const contact = chunk[j];
            const cleanOriginal = (contact.phone || contact.phoneNumber || '').replace(/\D/g, '');
            
            const match = results.find(r => (r.input || '').replace(/\D/g, '') === cleanOriginal || (r.wa_id || '').replace(/\D/g, '') === cleanOriginal);

            if (match && match.status === 'valid') {
              contact.status = 'ACTIVE';
              if (match.wa_id) contact.phone = match.wa_id;
              activeCount++;
            } else {
              contact.status = 'INVALID';
              invalidCount++;
            }
            await contact.save();
            verifiedCount++;
          }
        } catch (metaErr) {
          console.error("❌ Meta API bulk verification batch error:", metaErr.response?.data || metaErr.message);
          for (const contact of chunk) {
            contact.status = 'INVALID';
            invalidCount++;
            await contact.save();
            verifiedCount++;
          }
        }
      }
    } 
    else {
      // Agar koi session active nahi hai toh strict check function run karein
      for (const contact of contacts) {
        const phone = contact.phone || contact.phoneNumber;
        const check = await checkWhatsAppStatus(phone, userId);
        contact.status = check.status;
        if (check.status === 'ACTIVE') activeCount++;
        else invalidCount++;
        await contact.save();
        verifiedCount++;
      }
    }

    return res.json({
      success: true,
      message: `Verification Mukammal! Total Checked: ${verifiedCount} | Active WhatsApp: ${activeCount} | Invalid: ${invalidCount}`,
      stats: { verifiedCount, activeCount, invalidCount }
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
    const userId = req.user.id || req.user._id;
    const adminId = req.user.adminId || null;
    const role = req.user.role ? req.user.role.toLowerCase() : 'admin';

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

    if (ids.platform === 'whatsapp' && ids.phone) {
      const waCheck = await checkWhatsAppStatus(ids.phone, userId);
      calculatedStatus = waCheck.status;
      ids.phone = waCheck.phone;
      ids.recipientId = waCheck.phone;
      
      if (calculatedStatus === 'ACTIVE') {
        dpUrl = await fetchContactDp(ids.phone, userId);
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
      status: calculatedStatus
    });

    const contact = await newContact.save();

    res.json({
      success: true,
      message: calculatedStatus === 'ACTIVE'
        ? "Contact saved successfully!"
        : "Contact saved but marked as INVALID (Not on WhatsApp).",
      contact
    });
  } catch (err) {
    console.error("Single Add Error:", err);
    res.status(500).json({ success: false, message: 'Failed to add contact' });
  }
});

router.post('/bulk-import', auth, upload.single('excelFile'), async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const adminId = req.user.adminId || null;
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

    const formattedContactsPromises = excelRows.map(async (row) => {
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

        const waCheck = await checkWhatsAppStatus(rawPhone, userId);
        let dpUrl = null;
        if (waCheck.status === 'ACTIVE') {
          dpUrl = await fetchContactDp(waCheck.phone, userId);
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
          status: waCheck.status
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
    });

    const resolvedContacts = await Promise.all(formattedContactsPromises);
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