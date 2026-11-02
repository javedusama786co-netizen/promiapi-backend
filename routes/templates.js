const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const axios = require("axios");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const FormData = require("form-data"); 
const mongoose = require("mongoose");

const Template = require("../models/Template");
const WhatsAppConfig = require("../models/whatsappConfigModel"); 

// =========================================================
// 📁 MULTER CONFIGURATION FOR FILE UPLOADS
// =========================================================
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = "uploads/templates/";
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const businessScopeId = req.user.adminId || req.user.id;
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `user-${businessScopeId}-${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

// 🔐 token sanitiser (quotes / newlines in saved tokens were breaking the Authorization header)
const cleanTok = (tok) => String(tok || "").replace(/^[\"']|[\"']$/g, "").trim().replace(/[\r\n]+/g, "");

// 🆔 Resumable-upload API needs the Facebook APP id (NOT the WABA id).
async function resolveAppId(token) {
  const envId = process.env.FACEBOOK_APP_ID || process.env.META_APP_ID || process.env.FB_APP_ID;
  if (envId) return String(envId).trim();
  try {
    const r = await axios.get("https://graph.facebook.com/v20.0/debug_token", { params: { input_token: token, access_token: token } });
    if (r.data?.data?.app_id) return String(r.data.data.app_id);
  } catch (e) { /* ignore */ }
  return "1543305467331355"; // same default used in whatsappConfig.js
}

// Helper function for robust user query filter (Strictly targeting Official WhatsApp & Meta Config)
const getMetaConfigQuery = (user) => {
  const businessScopeId = user.adminId || user.id || user._id;
  const userCond = [{ userId: businessScopeId }, { userId: String(businessScopeId) }];
  if (mongoose.Types.ObjectId.isValid(businessScopeId)) {
    userCond.push({ userId: new mongoose.Types.ObjectId(businessScopeId) });
  }
  if (user.adminId) {
    userCond.push({ userId: user.adminId }, { userId: String(user.adminId) });
    if (mongoose.Types.ObjectId.isValid(user.adminId)) {
      userCond.push({ userId: new mongoose.Types.ObjectId(user.adminId) });
    }
  }
  
  return {
    $or: userCond,
    platform: { $in: ["whatsapp_official", "whatsapp"] },
    businessAccountId: { $exists: true, $ne: null }
  };
};

// =========================================================
// 1. 🔄 META TEMPLATES SYNC
// =========================================================
router.get("/sync-meta", auth, async (req, res) => {
  try {
    const queryFilter = getMetaConfigQuery(req.user);
    const userConfig = await WhatsAppConfig.findOne(queryFilter).sort({ updatedAt: -1 });

    if (!userConfig || !userConfig.accessToken || !userConfig.businessAccountId) {
      return res.status(400).json({ 
        success: false, 
        message: "Please save your Token and Business Account ID in the dashboard WhatsApp Cloud API settings first!" 
      });
    }

    const syncToken = cleanTok(userConfig.accessToken);
    let metaTemplates = [];
    let nextUrl = `https://graph.facebook.com/v20.0/${userConfig.businessAccountId}/message_templates?limit=100`;
    for (let page = 0; nextUrl && page < 20; page++) {
      const response = await axios.get(nextUrl, { headers: { Authorization: `Bearer ${syncToken}` } });
      metaTemplates = metaTemplates.concat(response.data?.data || []);
      nextUrl = response.data?.paging?.next || null;
    }
    const savedTemplates = [];

    const businessScopeId = req.user.adminId || req.user.id;

    for (const mt of metaTemplates) {
      if (!mt.name) continue;

      const bodyComponent = mt.components ? mt.components.find(c => c.type === "BODY") : null;
      const headerComponent = mt.components ? mt.components.find(c => c.type === "HEADER") : null;
      const footerComponent = mt.components ? mt.components.find(c => c.type === "FOOTER") : null;
      const buttonsComponent = mt.components ? mt.components.find(c => c.type === "BUTTONS") : null;

      const bodyContent = bodyComponent ? bodyComponent.text : "No Content Description";
      const metaHeaderText = (headerComponent && headerComponent.format === "TEXT") ? headerComponent.text : "";
      const metaFooterText = footerComponent ? footerComponent.text : "";
      
      let metaHeaderType = "none";
      if (headerComponent && headerComponent.format) {
        const fmt = headerComponent.format.toLowerCase();
        if (['text', 'image', 'document', 'audio', 'video'].includes(fmt)) {
          metaHeaderType = fmt;
        }
      }

      let parsedButtons = [];
      if (buttonsComponent && buttonsComponent.buttons) {
        parsedButtons = buttonsComponent.buttons.map(b => {
          let type = "reply";
          let val = "";
          if (b.type === "URL") { type = "url"; val = b.url || ""; }
          if (b.type === "PHONE_NUMBER") { type = "call"; val = b.phone_number || ""; }
          return { buttonText: b.text || "Click Here", buttonType: type, value: val };
        });
      }

      let checkStatus = "PENDING";
      if (mt.status) {
        const upperSt = mt.status.toUpperCase();
        if (["APPROVED", "PENDING", "REJECTED"].includes(upperSt)) {
          checkStatus = upperSt;
        }
      }

      try {
        const updatedTemplate = await Template.findOneAndUpdate(
          { name: mt.name, userId: businessScopeId }, 
          {
            userId: businessScopeId,
            title: mt.name,
            name: mt.name, 
            content: bodyContent,
            headerType: metaHeaderType,
            headerText: metaHeaderText,
            footerText: metaFooterText,
            status: checkStatus,
            category: mt.category || "UTILITY",
            language: mt.language || "en_US",
            buttons: parsedButtons
          },
          { returnDocument: 'after', upsert: true }
        );
        savedTemplates.push(updatedTemplate);
      } catch (dbLoopErr) {
        console.error(`⚠️ Sync skip for ${mt.name}:`, dbLoopErr.message);
      }
    }

    return res.json({ success: true, message: `${savedTemplates.length} Templates synchronized!`, templates: savedTemplates });
  } catch (err) {
    const metaMsg = err.response?.data?.error?.message;
    console.error("❌ Sync Error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: metaMsg ? `Meta error: ${metaMsg}` : "Sync error occurred.", error: err.response?.data?.error || err.message });
  }
});

// =========================================================
// 2. 🔌 GET ALL TEMPLATES
// =========================================================
router.get("/", auth, async (req, res) => {
  try {
    const businessScopeId = req.user.adminId || req.user.id;
    const templates = await Template.find({ userId: businessScopeId }).sort({ createdAt: -1 });
    res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ success: false, message: "DB loading failed." });
  }
});

// =========================================================
// 3. 📤 CREATE TEMPLATE
// =========================================================
router.post("/", auth, upload.single("media"), async (req, res) => {
  try {
    const businessScopeId = req.user.adminId || req.user.id;
    const { title, content, delayTime, headerType, headerText, footerText, category, language } = req.body;
    
    let parsedButtons = [];
    if (req.body.buttons) {
      try { parsedButtons = JSON.parse(req.body.buttons); } catch (e) { parsedButtons = []; }
    }

    const templateCleanName = (title || "template")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/_+/g, "_");

    let dynamicMediaUrl = "";
    if (req.file) {
      dynamicMediaUrl = `https://api.promiapi.com/uploads/templates/${req.file.filename}`;
    }

    const savedTemplate = await Template.create({
      userId: businessScopeId,
      title: templateCleanName,
      name: templateCleanName,
      content,
      delayTime: delayTime || 0,
      headerType: headerType || "none",
      headerText: headerText || "", 
      footerText: footerText || "", 
      mediaType: headerType || "none",
      mediaUrl: dynamicMediaUrl, 
      category: category || "UTILITY",
      language: language || "en_US",
      buttons: parsedButtons,
      status: "PENDING"
    });

    const queryFilter = getMetaConfigQuery(req.user);
    const userConfig = await WhatsAppConfig.findOne(queryFilter).sort({ updatedAt: -1 });

    let metaSyncedStatus = false;
    let metaNotice = "Saved locally on dashboard testing mode.";
    let headerUploadFailed = false;
    let headerUploadError = "";

    if (userConfig && userConfig.accessToken && userConfig.businessAccountId) {
      const metaComponents = [];

      if (headerType === "text" && headerText) {
        const headerComponentObj = { 
          type: "HEADER", 
          format: "TEXT", 
          text: headerText 
        };

        const headerMatches = headerText.match(/\{\{(\d+)\}\}/g);
        if (headerMatches && headerMatches.length > 0) {
          const sampleValues = headerMatches.map((match) => {
            const num = match.match(/\d+/)[0];
            return `Sample_${num}`;
          });

          headerComponentObj.example = {
            header_text: sampleValues
          };
        }

        metaComponents.push(headerComponentObj);
      } 
      else if (headerType && headerType !== "none" && headerType !== "text") {
        let metaHeaderHandle = "";
        const upToken = cleanTok(userConfig.accessToken);

        if (!req.file || !fs.existsSync(req.file.path)) {
          headerUploadError = "Header media file was not received by the server.";
        } else {
          const fileSize = fs.statSync(req.file.path).size;

          let normalizedMime = req.file.mimetype;
          if (!normalizedMime || normalizedMime === "application/octet-stream") {
            if (headerType === "image") normalizedMime = "image/jpeg";
            else if (headerType === "video") normalizedMime = "video/mp4";
            else if (headerType === "document") normalizedMime = "application/pdf";
          }

          try {
            // Step 1: create upload session on the APP id (WABA id / "app" literal do not work)
            const appId = await resolveAppId(upToken);
            const sessionRes = await axios.post(
              `https://graph.facebook.com/v20.0/${appId}/uploads`,
              null,
              { params: { file_length: fileSize, file_type: normalizedMime, file_name: req.file.originalname, access_token: upToken } }
            );
            const uploadSessionId = sessionRes.data.id;

            // Step 2: send the RAW file bytes (multipart/form-data corrupts the file and Meta then rejects the handle)
            const uploadRes = await axios.post(
              `https://graph.facebook.com/v20.0/${uploadSessionId}`,
              fs.readFileSync(req.file.path),
              {
                headers: { Authorization: `OAuth ${upToken}`, file_offset: "0", "Content-Type": "application/octet-stream" },
                maxBodyLength: Infinity,
                maxContentLength: Infinity
              }
            );
            if (uploadRes.data && uploadRes.data.h) metaHeaderHandle = uploadRes.data.h;
            else headerUploadError = "Meta did not return a media handle.";
          } catch (upErr) {
            headerUploadError = upErr.response?.data?.error?.message || upErr.message;
            console.error("❌ META MEDIA HANDLE UPLOAD FAILED:", upErr.response?.data || upErr.message);
          }
        }

        if (metaHeaderHandle) {
          metaComponents.push({
            type: "HEADER",
            format: headerType.toUpperCase(),
            example: { header_handle: [ metaHeaderHandle ] }
          });
        } else {
          headerUploadFailed = true; // template is already saved locally; report the real reason instead of a 500
        }
      }

      const bodyComponent = { type: "BODY", text: content };

      const matches = content.match(/\{\{\d+\}\}/g);
      if (matches && matches.length > 0) {
        const sampleArray = matches.map((_, idx) => `Sample_${idx + 1}`);
        bodyComponent.example = {
          body_text: [sampleArray]
        };
      }
      metaComponents.push(bodyComponent);

      if (footerText && footerText.trim() !== "") {
        metaComponents.push({ type: "FOOTER", text: footerText.trim() });
      }

      if (parsedButtons && parsedButtons.length > 0) {
        const formattedButtons = parsedButtons.map((btn) => {
          if (btn.buttonType === "url") return { type: "URL", text: btn.buttonText, url: btn.value };
          if (btn.buttonType === "call") return { type: "PHONE_NUMBER", text: btn.buttonText, phone_number: btn.value };
          return { type: "QUICK_REPLY", text: btn.buttonText };
        });
        metaComponents.push({ type: "BUTTONS", buttons: formattedButtons });
      }

      const metaPayload = {
        name: templateCleanName, 
        category: category || "UTILITY",
        language: language || "en_US",
        components: metaComponents
      };

      if (headerUploadFailed) {
        metaNotice = `Saved locally! Meta media upload failed: ${headerUploadError || "unknown error"}`;
      } else try {
        const metaRes = await axios.post(
          `https://graph.facebook.com/v20.0/${userConfig.businessAccountId}/message_templates`, 
          metaPayload, 
          { headers: { Authorization: `Bearer ${cleanTok(userConfig.accessToken)}`, "Content-Type": "application/json" } }
        );
        
        metaSyncedStatus = true;
        metaNotice = "Synced with Meta cloud account successfully!";

        if (metaRes.data && metaRes.data.status) {
          await Template.findByIdAndUpdate(savedTemplate._id, { status: metaRes.data.status.toUpperCase() });
        }
      } catch (metaErr) {
        console.error("❌ META REGISTRATION REJECTION DETAILS:", metaErr.response?.data || metaErr.message);
        metaNotice = `Saved locally! (Meta API notice: ${metaErr.response?.data?.error?.message || "Check fields format"})${metaErr.response?.data?.error?.error_user_msg ? " - " + metaErr.response.data.error.error_user_msg : ""}`;
      }
    }

    res.status(200).json({ 
      success: true, 
      message: `🚀 ${metaNotice}`, 
      template: savedTemplate,
      metaSynced: metaSyncedStatus
    });

  } catch (err) {
    console.error("❌ MASTER ROUTE CRASH:", err.message);
    res.status(500).json({ success: false, message: err.message || "Template processing failed on server." });
  }
});

// =========================================================
// 4. 🗑️ DELETE TEMPLATE (Updated with Robust User Config & Meta Delete)
// =========================================================
router.delete("/:id", auth, async (req, res) => {
  try {
    const businessScopeId = req.user.adminId || req.user.id;
    const targetTemplate = await Template.findOne({ _id: req.params.id, userId: businessScopeId });
    
    if (!targetTemplate) {
      return res.status(404).json({ success: false, message: "Template database mein nahi mila." });
    }

    if (targetTemplate.mediaUrl) {
      const filename = targetTemplate.mediaUrl.split("/").pop();
      const localFilePath = path.join(__dirname, "../uploads/templates/", filename);
      if (fs.existsSync(localFilePath)) {
        fs.unlinkSync(localFilePath);
      }
    }

    const queryFilter = getMetaConfigQuery(req.user);
    const userConfig = await WhatsAppConfig.findOne(queryFilter).sort({ updatedAt: -1 });

    if (userConfig && userConfig.accessToken && userConfig.businessAccountId) {
      try {
        await axios.delete(`https://graph.facebook.com/v20.0/${userConfig.businessAccountId}/message_templates?name=${encodeURIComponent(targetTemplate.name)}`, {
          headers: { Authorization: `Bearer ${cleanTok(userConfig.accessToken)}` }
        });
      } catch (metaErr) {
        console.warn("⚠️ Meta remove warning:", metaErr.response?.data || metaErr.message);
      }
    }

    await Template.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Template completely deleted!" });
  } catch (err) {
    console.error("❌ Delete Route Error:", err.message);
    res.status(500).json({ success: false, message: "Delete operation failed." });
  }
});

module.exports = router;