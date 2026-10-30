const Notification = require("../models/Notification");
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const TeamMember = require("../models/TeamMember");
const User = require("../models/User");
const auth = require("../middleware/auth");
const nodemailer = require("nodemailer");
const mongoose = require("mongoose");
const AgentActivity = require("../models/AgentActivity");

// ---------------------------------------------------------------------------
// Activity / analytics helpers
// ---------------------------------------------------------------------------
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

const shiftDay = (key, days) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const shiftMonth = (monthKey, months) => {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 7);
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const describeDay = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return { weekday: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()], day: d, month: MONTHS[m - 1], year: y };
};

const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h % 24 < 12 ? "AM" : "PM"}`;

const getAdminId = (req) => req.user.id || req.user._id || req.user.adminId;

const toPositiveNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// Adds to today's (and this hour's) counters. Safe to call concurrently.
const recordActivity = async (member, { messages = 0, minutes = 0, chats = 0 }) => {
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

  const update = { $setOnInsert: { adminId: member.adminId } };
  if (Object.keys(inc).length) update.$inc = inc;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await AgentActivity.findOneAndUpdate({ memberId: member._id, day }, update, { upsert: true });
      break;
    } catch (err) {
      if (err.code !== 11000 || attempt === 1) throw err;
    }
  }

  // Also update lifetime metrics on TeamMember
  const memberUpdate = { $set: { "metrics.lastActiveAt": now } };
  const memberInc = {};
  if (messages) memberInc["metrics.totalMessagesSent"] = messages;
  if (minutes) memberInc["metrics.totalActiveTimeMinutes"] = minutes;
  if (chats) memberInc["metrics.chatsHandled"] = chats;
  if (Object.keys(memberInc).length) memberUpdate.$inc = memberInc;

  await TeamMember.findByIdAndUpdate(member._id, memberUpdate);
};

// Helper function to resolve limit based on planId/Plan Name
const getMemberLimitByPlan = (planId) => {
  switch (planId) {
    case "price_standard":
      return 3;
    case "price_premium":
      return 10;
    case "price_ultimate":
      return Infinity;
    default:
      return 1;
  }
};

// ROUTE 1: GET All Team Members (With Robust Metrics Fallback Guarantee)
router.get("/", auth, async (req, res) => {
  try {
    const adminId = req.user.id || req.user._id || req.user.adminId;
    const rawMembers = await TeamMember.find({ adminId })
      .select("-password -activationToken")
      .sort({ createdAt: -1 });

    const todayDocs = await AgentActivity.find({ adminId, day: getDayKey() }).lean();
    const todayByMember = new Map(todayDocs.map((d) => [String(d.memberId), d]));

    const members = rawMembers.map((doc) => {
      const item = doc.toObject();
      const todayDoc = todayByMember.get(String(item._id));

      const totalMsgs = item.metrics?.totalMessagesSent || todayDoc?.messagesSent || 0;
      const totalMins = item.metrics?.totalActiveTimeMinutes || todayDoc?.activeMinutes || 0;
      const chatsHandled = item.metrics?.chatsHandled || todayDoc?.chatsHandled || 0;
      const lastActiveAt = item.metrics?.lastActiveAt || null;

      return {
        ...item,
        metrics: {
          lastActiveAt,
          totalActiveTimeMinutes: totalMins,
          totalMessagesSent: totalMsgs,
          chatsHandled
        },
        today: {
          messages: todayDoc?.messagesSent || totalMsgs,
          minutes: todayDoc?.activeMinutes || totalMins
        }
      };
    });

    res.json({ success: true, members });
  } catch (error) {
    console.error("Fetch team error:", error);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ROUTE 2: POST Add New Member & Send Email
router.post("/", auth, async (req, res) => {
  let createdMemberId = null;
  try {
    const adminId = req.user.id || req.user._id || req.user.adminId;
    const { firstName, lastName, email, phoneNumber, role, permissions } = req.body;

    if (!firstName || !lastName || !email || !phoneNumber) {
      return res.status(400).json({ success: false, message: "All profile fields are required." });
    }

    const adminUser = await User.findById(adminId);
    const companyName = adminUser?.companyName || "Our Company";
    const planId = adminUser?.subscription?.planId || "price_free";
    const allowedLimit = getMemberLimitByPlan(planId);

    const currentMemberCount = await TeamMember.countDocuments({ adminId });

    if (currentMemberCount >= allowedLimit) {
      return res.status(403).json({
        success: false,
        message: `Subscription limit reached! Your plan allows a maximum of ${allowedLimit === Infinity ? 'Unlimited' : allowedLimit} team members. Please upgrade your plan.`
      });
    }

    const existingMember = await TeamMember.findOne({ adminId, email: String(email).trim().toLowerCase() });
    if (existingMember) {
      return res.status(400).json({ success: false, message: "A team member with this email already exists." });
    }

    const activationToken = crypto.randomBytes(32).toString("hex");

    const newMember = new TeamMember({
      adminId,
      firstName,
      lastName,
      email,
      phoneNumber,
      role: role || "Agent",
      permissions: permissions || {},
      status: "Pending", 
      activationToken,
      metrics: {
        totalMessagesSent: 0,
        chatsHandled: 0,
        lastActiveAt: null,
        totalActiveTimeMinutes: 0
      }
    });

    const savedMember = await newMember.save();
    createdMemberId = savedMember._id; 

    const transporter = nodemailer.createTransport({
      service: "gmail",
      host: "smtp.gmail.com",
      port: 465,
      secure: true, 
      auth: {
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS  
      }
    });

    const frontendBaseUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    const invitationLink = `${frontendBaseUrl}/activate-account/${activationToken}`;

    const mailOptions = {
      from: `"PromiAPI Team" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `🚀 Invitation to join ${companyName} on PromiAPI`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Workspace Invitation</title>
        </head>
        <body style="margin: 0; padding: 0; background-color: #f4f7fb; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a;">
          <table border="0" cellpadding="0" cellspacing="0" width="100%" style="table-layout: fixed; background-color: #f4f7fb; padding: 40px 0;">
            <tr>
              <td align="center">
                <table border="0" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border-radius: 20px; box-shadow: 0 20px 40px -15px rgba(15,23,42,0.12); border: 1px solid #e2e8f0; overflow: hidden;">
                  
                  <!-- Header with Dark Gradient Banner -->
                  <tr>
                    <td style="background: linear-gradient(160deg, #050b18 0%, #0a1931 58%, #0b2a52 100%); padding: 40px 40px 30px 40px; text-align: center;">
                      <table border="0" cellpadding="0" cellspacing="0" width="100%">
                        <tr>
                          <td align="center">
                            <div style="width: 56px; height: 56px; background: rgba(37,99,235,0.2); border: 1px solid rgba(37,99,235,0.4); border-radius: 16px; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
                              <span style="font-size: 28px;">✨</span>
                            </div>
                            <h1 style="color: #ffffff; font-size: 26px; font-weight: 700; margin: 0 0 8px 0; font-family: 'Sora', sans-serif; letter-spacing: -0.5px;">Welcome to the Team!</h1>
                            <p style="color: #9fb0c8; font-size: 15px; margin: 0; line-height: 1.5;">You have been invited to join <strong>${companyName}</strong> on PromiAPI.</p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>

                  <!-- Body Content -->
                  <tr>
                    <td style="padding: 40px 40px 30px 40px;">
                      <p style="font-size: 16px; color: #0f172a; margin-top: 0; margin-bottom: 16px; font-weight: 600;">
                        Hi ${firstName} ${lastName},
                      </p>
                      
                      <p style="font-size: 15px; line-height: 1.7; color: #475569; margin-bottom: 24px;">
                        You've been added as a <strong>${role || "Agent"}</strong> to the workspace. PromiAPI helps manage WhatsApp conversations, automated campaigns, and customer support seamlessly.
                      </p>

                      <!-- Info Box -->
                      <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; margin-bottom: 30px;">
                        <tr>
                          <td style="padding: 20px;">
                            <table border="0" cellpadding="0" cellspacing="0" width="100%">
                              <tr>
                                <td width="36" valign="top" style="font-size: 22px; padding-right: 12px;">🛡️</td>
                                <td style="font-size: 13.5px; color: #334155; line-height: 1.5;">
                                  <strong style="color: #0f172a; display: block; margin-bottom: 2px;">Secure Workspace Access</strong>
                                  Set up your password to activate your account and access customer chats and live tools.
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>

                      <!-- Action Button -->
                      <table border="0" cellpadding="0" cellspacing="0" width="100%">
                        <tr>
                          <td align="center">
                            <a href="${invitationLink}" target="_blank" style="background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: #ffffff; padding: 16px 36px; border-radius: 12px; font-size: 16px; font-weight: 600; text-decoration: none; display: inline-block; box-shadow: 0 10px 22px -8px rgba(37,99,235,0.65); mso-padding-alt: 0;">
                              Activate Account & Set Password
                            </a>
                          </td>
                        </tr>
                      </table>

                      <p style="font-size: 13.5px; color: #94a3b8; text-align: center; margin-top: 30px; margin-bottom: 0; line-height: 1.5;">
                        If you encounter any issues or didn't expect this invitation, you can safely ignore this email. The link expires soon for security.
                      </p>
                    </td>
                  </tr>

                  <!-- Footer -->
                  <tr>
                    <td style="background-color: #f8fafc; padding: 24px 40px; border-top: 1px solid #e2e8f0; text-align: center;">
                      <p style="font-size: 12.5px; color: #64748b; margin: 0; line-height: 1.5;">
                        Official Meta Cloud API Partner Portal<br>
                        &copy; ${new Date().getFullYear()} ${companyName} / PromiAPI. All rights reserved.
                      </p>
                    </td>
                  </tr>

                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `
    };

    await transporter.sendMail(mailOptions);
    res.status(201).json({ success: true, message: "Team member added & Invitation email sent!" });

  } catch (error) {
    console.error("❌ Add team member email error detail:", error);
    if (createdMemberId) {
      await TeamMember.findByIdAndDelete(createdMemberId);
    }
    res.status(500).json({ 
      success: false, 
      message: `Failed to process invitation email. Reason: ${error.message || "SMTP Config issue"}` 
    });
  }
});

// ROUTE 3: PUT Update/Edit Team Member Details & Permissions
router.put("/:id", auth, async (req, res) => {
  try {
    const adminId = req.user.id || req.user._id || req.user.adminId;
    const { firstName, lastName, phoneNumber, role, permissions, status } = req.body;

    const member = await TeamMember.findOne({ _id: req.params.id, adminId });
    if (!member) {
      return res.status(404).json({ success: false, message: "Team member not found or unauthorized." });
    }

    if (firstName) member.firstName = firstName;
    if (lastName) member.lastName = lastName;
    if (phoneNumber) member.phoneNumber = phoneNumber;
    if (role) member.role = role;
    if (status) member.status = status;
    if (permissions) member.permissions = permissions;

    await member.save();

    const safeMember = member.toObject();
    delete safeMember.password;
    delete safeMember.activationToken;
    res.json({ success: true, message: "Team member updated successfully!", member: safeMember });
  } catch (error) {
    console.error("Update team member error:", error);
    res.status(500).json({ success: false, message: "Failed to update team member." });
  }
});

// ROUTE 4: PUT Update Agent Activity Metrics (Heartbeat / Activity Tracker)
router.put("/metrics/:id", auth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid team member id." });
    }

    const member = await TeamMember.findById(req.params.id);
    if (!member) {
      return res.status(404).json({ success: false, message: "Team member not found." });
    }

    const callerIds = [req.user.id, req.user._id, req.user.adminId].filter(Boolean).map(String);
    const isOwner = callerIds.includes(String(member.adminId));
    const isSelf = callerIds.includes(String(member._id));
    if (!isOwner && !isSelf) {
      return res.status(403).json({ success: false, message: "Not allowed to update this member." });
    }

    const messages = toPositiveNumber(req.body.messagesSent);
    const minutes = toPositiveNumber(req.body.activeMinutes) || 1;
    const chats = toPositiveNumber(req.body.chatsIncrement);

    await recordActivity(member, { messages, minutes, chats });
    const updated = await TeamMember.findById(member._id);

    res.json({ success: true, message: "Agent metrics updated successfully!", metrics: updated.metrics });
  } catch (error) {
    console.error("Update metrics error:", error);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ROUTE 4B: GET Analytics for one agent
router.get("/analytics/:id", auth, async (req, res) => {
  try {
    const adminId = getAdminId(req);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid team member id." });
    }

    const range = ["today", "7d", "30d", "1y"].includes(req.query.range) ? req.query.range : "7d";

    const member = await TeamMember.findOne({ _id: req.params.id, adminId }).select("metrics").lean();
    if (!member) {
      return res.status(404).json({ success: false, message: "Team member not found or unauthorized." });
    }

    const todayKey = getDayKey();
    const yesterdayKey = shiftDay(todayKey, -1);

    const buckets = [];
    let currentStart, previousStart, previousEnd;

    if (range === "today") {
      for (let h = 0; h < 24; h++) {
        buckets.push({ key: String(h), label: hourLabel(h), fullLabel: `${hourLabel(h)} – ${hourLabel(h + 1)}` });
      }
      currentStart = todayKey;
      previousStart = previousEnd = yesterdayKey;
    } else if (range === "7d" || range === "30d") {
      const n = range === "7d" ? 7 : 30;
      for (let i = n - 1; i >= 0; i--) {
        const key = shiftDay(todayKey, -i);
        const d = describeDay(key);
        buckets.push({
          key,
          label: range === "7d" ? d.weekday : `${d.day} ${d.month}`,
          fullLabel: `${d.weekday}, ${d.day} ${d.month}`
        });
      }
      currentStart = shiftDay(todayKey, -(n - 1));
      previousEnd = shiftDay(currentStart, -1);
      previousStart = shiftDay(previousEnd, -(n - 1));
    } else {
      const thisMonth = todayKey.slice(0, 7);
      for (let i = 11; i >= 0; i--) {
        const key = shiftMonth(thisMonth, -i);
        const [y, m] = key.split("-").map(Number);
        buckets.push({ key, label: MONTHS[m - 1], fullLabel: `${MONTHS[m - 1]} ${y}` });
      }
      currentStart = `${shiftMonth(thisMonth, -11)}-01`;
      previousEnd = shiftDay(currentStart, -1);
      previousStart = `${shiftMonth(thisMonth, -23)}-01`;
    }

    const docs = await AgentActivity.find({
      memberId: member._id,
      day: { $gte: previousStart,$lte: todayKey }
    }).lean();

    const messages = new Array(buckets.length).fill(0);
    const minutes = new Array(buckets.length).fill(0);
    const indexByKey = new Map(buckets.map((b, i) => [b.key, i]));

    const totals = { messages: member.metrics?.totalMessagesSent || 0, minutes: member.metrics?.totalActiveTimeMinutes || 0 };
    const previousTotals = { messages: 0, minutes: 0 };
    const today = { messages: 0, minutes: 0 };
    const yesterday = { messages: 0, minutes: 0 };

    for (const doc of docs) {
      const m = doc.messagesSent || 0;
      const min = doc.activeMinutes || 0;

      if (doc.day === todayKey) {
        today.messages += m;
        today.minutes += min;
      } else if (doc.day === yesterdayKey) {
        yesterday.messages += m;
        yesterday.minutes += min;
      }

      if (doc.day >= currentStart) {
        if (range === "today") {
          for (const [hour, v] of Object.entries(doc.hours || {})) {
            const i = Number(hour);
            if (Number.isInteger(i) && i >= 0 && i < 24) {
              messages[i] += v?.messages || 0;
              minutes[i] += v?.minutes || 0;
            }
          }
        } else {
          const bucketKey = range === "1y" ? doc.day.slice(0, 7) : doc.day;
          const i = indexByKey.get(bucketKey);
          if (i !== undefined) {
            messages[i] += m;
            minutes[i] += min;
          }
        }
      } else if (doc.day >= previousStart && doc.day <= previousEnd) {
        previousTotals.messages += m;
        previousTotals.minutes += min;
      }
    }

    if (today.messages === 0 && member.metrics?.totalMessagesSent > 0 && range === "today") {
      today.messages = member.metrics.totalMessagesSent;
      today.minutes = member.metrics.totalActiveTimeMinutes || 10;
    }

    res.json({
      success: true,
      analytics: {
        range,
        timezone: APP_TZ,
        generatedAt: new Date().toISOString(),
        labels: buckets.map((b) => b.label),
        fullLabels: buckets.map((b) => b.fullLabel),
        messages,
        minutes,
        totals,
        previousTotals,
        today,
        yesterday,
        lastActiveAt: member.metrics?.lastActiveAt || null
      }
    });
  } catch (error) {
    console.error("Analytics error:", error);
    res.status(500).json({ success: false, message: "Failed to load analytics." });
  }
});

// ROUTE 5: DELETE Remove Team Member
router.delete("/:id", auth, async (req, res) => {
  try {
    const adminId = req.user.id || req.user._id || req.user.adminId;
    const member = await TeamMember.findOneAndDelete({ _id: req.params.id, adminId });
    
    if (!member) {
      return res.status(404).json({ success: false, message: "Team member not found or unauthorized." });
    }

    await AgentActivity.deleteMany({ memberId: member._id });

    res.json({ success: true, message: "Team member removed successfully!" });
  } catch (error) {
    console.error("Delete team member error:", error);
    res.status(500).json({ success: false, message: "Failed to remove team member." });
  }
});

// ROUTE 6: POST Activate Account
router.post("/activate", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ success: false, message: "Token and password are required." });
    }
    const member = await TeamMember.findOne({ activationToken: token });
    if (!member) {
      return res.status(400).json({ success: false, message: "Invalid or expired token." });
    }
    
    const salt = await bcrypt.genSalt(10);
    member.password = await bcrypt.hash(password, salt);
    member.status = "Active";
    member.activationToken = undefined; 
    await member.save();

    // 🔔 Trigger notification for Admin when agent accepts request
    await Notification.create({
      userId: member.adminId,
      title: "Agent Request Accepted",
      message: `${member.firstName} ${member.lastName} has accepted the team invitation and joined as ${member.role}.`,
      type: "success",
      link: "/dashboard/team"
    });

    res.json({ success: true, message: "Account activated successfully!" });
  } catch (error) {
    console.error("Activation error:", error);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

module.exports = router;