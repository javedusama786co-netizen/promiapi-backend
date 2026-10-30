const express = require("express");
const router = express.Router();
const WidgetConfig = require("../models/WidgetConfig");
const authMiddleware = require("../middleware/auth");

// Get Widget Config
router.get("/config", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.user?.adminId;
    let config = await WidgetConfig.findOne({ userId });
    if (!config) {
      config = new WidgetConfig({ userId, phoneNumber: "", title: "Support Team", welcomeMessage: "Hi! How can we help?", position: "right" });
      await config.save();
    }
    return res.status(200).json({ success: true, data: config });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error fetching widget config." });
  }
});

// Save/Update Widget Config
router.post("/config", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.user?.adminId;
    const { phoneNumber, title, welcomeMessage, position } = req.body;

    const config = await WidgetConfig.findOneAndUpdate(
      { userId },
      { phoneNumber, title, welcomeMessage, position },
      { new: true, upsert: true }
    );

    return res.status(200).json({ success: true, message: "Widget configuration saved!", data: config });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Serve dynamic widget script (widget.js)
router.get("/widget.js", async (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.send(`
    (function() {
      const scriptTag = document.currentScript;
      const phone = scriptTag.getAttribute("data-phone") || "";
      const title = scriptTag.getAttribute("data-title") || "Support";
      const msg = scriptTag.getAttribute("data-msg") || "Hello!";
      const pos = scriptTag.getAttribute("data-pos") || "right";

      if (!phone) return;

      const div = document.createElement("div");
      div.innerHTML = \`<div id="promi-chat-widget" style="position:fixed; bottom:20px; \${pos}:20px; z-index:999999; font-family:sans-serif;">
        <div id="promi-box" style="display:none; width:300px; background:#fff; border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,0.15); overflow:hidden; margin-bottom:12px; border:1px solid #e4e7ec;">
          <div style="background:#2f46e0; color:#fff; padding:14px; font-weight:700; font-size:14px;">\${title}</div>
          <div style="padding:14px; font-size:13px; color:#475467; background:#f8f9fb;">\${msg}</div>
          <div style="padding:14px;"><a href="https://wa.me/\${phone}?text=\${encodeURIComponent(msg)}" target="_blank" style="display:block; text-align:center; background:#12b76a; color:#fff; padding:10px; border-radius:8px; text-decoration:none; font-weight:600; font-size:13.5px;">Start WhatsApp Chat</a></div>
        </div>
        <button id="promi-btn" style="width:54px; height:54px; border-radius:50%; background:#12b76a; color:#fff; border:0; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,0.2); display:grid; place-items:center;">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"></path></svg>
        </button>
      </div>\`;
      document.body.appendChild(div);

      const btn = document.getElementById("promi-btn");
      const box = document.getElementById("promi-box");
      btn.onclick = () => {
        box.style.display = box.style.display === "none" ? "block" : "none";
      };
    })();
  `);
});

module.exports = router;