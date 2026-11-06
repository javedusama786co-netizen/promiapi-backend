const express = require("express");
const router = express.Router();
const axios = require("axios");
const auth = require("../middleware/auth");
const SupportTicket = require("../models/SupportTicket");

const CATEGORIES = ["technical", "billing", "whatsapp", "campaigns", "feature", "other"];
const clip = (v, n) => String(v == null ? "" : v).replace(/\r/g, "").trim().slice(0, n);

// small anti-spam guard: 5 tickets per hour per user (in memory, resets on restart)
const LIMIT = 5;
const WINDOW_MS = 60 * 60 * 1000;
const sent = new Map();
function tooMany(key) {
  const now = Date.now();
  const list = (sent.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= LIMIT) { sent.set(key, list); return true; }
  list.push(now);
  sent.set(key, list);
  return false;
}

const newTicketNo = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid mix-ups
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return `PM-${out}`;
};

// optional: tell your team instantly (Slack / Discord / any webhook that accepts {"text": "..."})
async function notifyTeam(ticket) {
  const url = process.env.SUPPORT_NOTIFY_WEBHOOK;
  if (!url) return;
  try {
    await axios.post(
      url,
      { text: `🆘 New support ticket ${ticket.ticketNo} [${ticket.category}] from ${ticket.name || "user"} <${ticket.email}>\n*${ticket.subject}*\n${ticket.message.slice(0, 600)}`, content: `New support ticket ${ticket.ticketNo}: ${ticket.subject}` },
      { timeout: 6000 }
    );
  } catch (e) {
    console.warn("Support notify webhook failed:", e.message);
  }
}

// ---------------------------------------------------------------- create a ticket
router.post("/tickets", auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const ownerId = req.user.adminId || userId;

    if (tooMany(String(userId))) {
      return res.status(429).json({ success: false, message: "You have sent several requests in the last hour. Please wait a little or email us directly." });
    }

    const b = req.body || {};
    const subject = clip(b.subject, 140);
    const message = clip(b.message, 4000);
    const category = CATEGORIES.includes(b.category) ? b.category : "other";
    if (subject.length < 4) return res.status(400).json({ success: false, message: "Please add a short subject." });
    if (message.length < 15) return res.status(400).json({ success: false, message: "Please describe the problem in a few more words." });

    let ticket = null;
    for (let attempt = 0; attempt < 5 && !ticket; attempt++) {
      try {
        ticket = await SupportTicket.create({
          ticketNo: newTicketNo(),
          userId, ownerId,
          name: clip(req.user.name || b.name, 120),
          email: clip(req.user.email || b.email, 160),
          role: clip(req.user.role, 40),
          category, subject, message,
          pageUrl: clip(b.pageUrl, 500),
          userAgent: clip(req.headers["user-agent"], 300),
        });
      } catch (err) {
        if (err && err.code === 11000) continue; // ticket number clash: try another one
        throw err;
      }
    }
    if (!ticket) return res.status(500).json({ success: false, message: "Could not create the ticket. Please try again." });

    notifyTeam(ticket); // fire and forget
    res.status(201).json({
      success: true,
      ticket: { _id: ticket._id, ticketNo: ticket.ticketNo, status: ticket.status, subject: ticket.subject, category: ticket.category, createdAt: ticket.createdAt },
    });
  } catch (err) {
    console.error("Support create ticket error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---------------------------------------------------------------- my tickets (own tickets only)
router.get("/tickets", auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const tickets = await SupportTicket.find({ userId })
      .sort({ createdAt: -1 })
      .limit(30)
      .select("ticketNo category subject message status reply repliedAt createdAt")
      .lean();
    res.json({ success: true, tickets });
  } catch (err) {
    console.error("Support list tickets error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
