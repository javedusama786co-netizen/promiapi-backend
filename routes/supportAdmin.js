// Owner-side support desk: list, answer and close the tickets customers send from the dashboard.
//
// IMPORTANT - how this file is protected:
// It does NOT do its own owner check. routes/adminRoutes.js mounts it behind its owner guard:
//
//     router.use("/support", verifyOwnerAdmin, require("./supportAdmin"));
//
// so the URL is  /api/admin/support/tickets  (what AdminPanel.jsx calls) and only the owner can reach it.
// If it were ever mounted without that guard, the check below still refuses anyone who is not logged in.
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const SupportTicket = require("../models/SupportTicket");

const STATUSES = ["open", "in_progress", "resolved", "closed"];
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

router.use((req, res, next) => (req.user ? next() : res.status(401).json({ success: false, message: "Not authenticated" })));

// ---------------------------------------------------------------- list (newest first) + counts per status
router.get("/tickets", async (req, res) => {
  try {
    const filter = {};
    if (STATUSES.includes(req.query.status)) filter.status = req.query.status;
    const q = String(req.query.q || "").trim().slice(0, 80);
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ ticketNo: rx }, { subject: rx }, { email: rx }, { name: rx }, { message: rx }];
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);

    const [tickets, grouped] = await Promise.all([
      SupportTicket.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      SupportTicket.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    const counts = { open: 0, in_progress: 0, resolved: 0, closed: 0, total: 0 };
    grouped.forEach((g) => { if (counts[g._id] !== undefined) counts[g._id] = g.n; counts.total += g.n; });

    res.json({ success: true, tickets, counts });
  } catch (err) {
    console.error("Admin support list error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---------------------------------------------------------------- change status and / or write the reply
router.patch("/tickets/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid ticket id." });
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found." });

    const b = req.body || {};
    let changed = false;
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ success: false, message: "Unknown status." });
      if (ticket.status !== b.status) { ticket.status = b.status; changed = true; }
    }
    if (b.reply !== undefined) {
      const reply = String(b.reply || "").replace(/\r/g, "").trim().slice(0, 4000);
      if (reply !== ticket.reply) {
        ticket.reply = reply;
        ticket.repliedAt = reply ? new Date() : null;
        changed = true;
      }
    }
    if (!changed) return res.json({ success: true, message: "Nothing to update.", ticket });

    await ticket.save();
    res.json({ success: true, message: "Ticket updated.", ticket });
  } catch (err) {
    console.error("Admin support update error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---------------------------------------------------------------- delete (spam / test tickets)
router.delete("/tickets/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid ticket id." });
    const gone = await SupportTicket.findByIdAndDelete(req.params.id);
    if (!gone) return res.status(404).json({ success: false, message: "Ticket not found." });
    res.json({ success: true, message: "Ticket deleted." });
  } catch (err) {
    console.error("Admin support delete error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;