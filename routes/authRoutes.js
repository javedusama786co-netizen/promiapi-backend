const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const User = require("../models/User"); // Admin Model
const TeamMember = require("../models/TeamMember"); // Agent Model
const AgentActivity = require("../models/AgentActivity"); // Agent Activity Model
const authMiddleware = require("../middleware/authMiddleware");
const mongoose = require("mongoose");

// 🔐 JWT secret (same fallback as before so existing tokens / authMiddleware keep working)
// ⚠️ PRODUCTION: set JWT_SECRET in your .env, otherwise the public fallback below is used.
const JWT_SECRET = process.env.JWT_SECRET || "my_super_secret_key_123";
if (!process.env.JWT_SECRET) {
  console.error("⚠️  SECURITY WARNING: JWT_SECRET is not set. Using insecure fallback secret. Set JWT_SECRET in .env!");
}

// 🚦 Tiny in-memory rate limiter (no extra npm package needed)
const createLimiter = ({ windowMs, max, message }) => {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ip = fwd || req.ip || "unknown";
    const emailPart = req.body && typeof req.body.email === "string" ? req.body.email.toLowerCase().trim() : "";
    const key = `${ip}|${emailPart}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) entry = { count: 0, reset: now + windowMs };
    entry.count += 1;
    hits.set(key, entry);
    if (entry.count > max) {
      return res.status(429).json({ success: false, message });
    }
    next();
  };
};
const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many attempts. Please try again after a few minutes.",
});

const escapeHtml = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Onboarding is "done" if the flag is true OR (for older accounts) company + phone already exist
const isOnboarded = (user) =>
  user.onboardingCompleted === true || !!(user.companyName && user.phone);

// Common safe payload for Admin (tenant owner) accounts
const buildAdminPayload = (user) => {
  const avatarUrl = user.avatar || user.profilePic || "";
  return {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName || "",
    username: user.username || "",
    email: user.email,
    avatar: avatarUrl,
    profilePic: avatarUrl,
    role: "Admin",
    companyName: user.companyName || "",
    phone: user.phone || "",
    teamSize: user.teamSize || "",
    settings: user.settings,
    onboardingCompleted: isOnboarded(user),
    subscribed: user.subscribed || false,
    plan: user.plan || "Free",
    expiresAt: user.expiresAt || user.subscription?.endDate || null,
  };
};

// ==========================================
// 🌐 SOCIAL PROVIDER TOKEN VERIFICATION
// The backend NEVER trusts email / id sent by the browser. It verifies the
// provider token itself and reads the identity from the provider.
// ==========================================
const socialError = (status, publicMessage) => {
  const e = new Error(publicMessage);
  e.status = status;
  e.publicMessage = publicMessage;
  return e;
};

const verifyGoogle = async (accessToken) => {
  const allowed = String(process.env.GOOGLE_CLIENT_ID || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) throw socialError(500, "Google login is not configured on the server (GOOGLE_CLIENT_ID missing).");

  const infoRes = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
  );
  if (!infoRes.ok) throw socialError(401, "Invalid Google session. Please try again.");
  const info = await infoRes.json();
  if (!allowed.includes(info.aud) && !allowed.includes(info.azp)) {
    throw socialError(401, "Google token was not issued for this application.");
  }

  const uRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!uRes.ok) throw socialError(401, "Could not read your Google profile.");
  const u = await uRes.json();
  if (!u.sub || !u.email) throw socialError(400, "Google did not return an email address.");
  if (u.email_verified !== true && u.email_verified !== "true") {
    throw socialError(400, "Your Google email is not verified.");
  }
  return {
    providerId: String(u.sub),
    email: u.email,
    firstName: u.given_name || "",
    lastName: u.family_name || "",
    picture: u.picture || "",
  };
};

const verifyFacebook = async (accessToken) => {
  const expectedAppId = process.env.FACEBOOK_APP_ID || "1144553121409101";

  // Which app was this token issued to?  (works with a user token, no app secret needed)
  const appRes = await fetch(
    `https://graph.facebook.com/app?access_token=${encodeURIComponent(accessToken)}`
  );
  const app = await appRes.json();
  if (!appRes.ok || !app.id || String(app.id) !== String(expectedAppId)) {
    throw socialError(401, "Facebook token was not issued for this application.");
  }

  const meRes = await fetch(
    `https://graph.facebook.com/me?fields=id,first_name,last_name,email,picture.type(large)&access_token=${encodeURIComponent(accessToken)}`
  );
  const me = await meRes.json();
  if (!meRes.ok || !me.id) throw socialError(401, "Could not read your Facebook profile.");
  if (!me.email) {
    throw socialError(400, "Facebook did not share your email. Please allow email permission, or use Google / email login.");
  }
  return {
    providerId: String(me.id),
    email: me.email,
    firstName: me.first_name || "",
    lastName: me.last_name || "",
    picture: me.picture?.data?.url || "",
  };
};

let appleJwks = null;
const verifyApple = async (idToken) => {
  const clientId = process.env.APPLE_CLIENT_ID || "com.promiapi.auth";
  let jose;
  try {
    jose = await import("jose"); // npm i jose  (only needed for Apple login)
  } catch (e) {
    throw socialError(500, "Apple login is not configured on the server (run: npm i jose).");
  }
  if (!appleJwks) appleJwks = jose.createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
  const { payload } = await jose.jwtVerify(idToken, appleJwks, {
    issuer: "https://appleid.apple.com",
    audience: clientId,
  });
  if (!payload.sub || !payload.email) throw socialError(400, "Apple did not return an email address.");
  if (!(payload.email_verified === true || payload.email_verified === "true")) {
    throw socialError(400, "Your Apple email is not verified.");
  }
  return { providerId: String(payload.sub), email: payload.email, firstName: "", lastName: "", picture: "" };
};

const SOCIAL_VERIFIERS = { google: verifyGoogle, facebook: verifyFacebook, apple: verifyApple };
const SOCIAL_ID_FIELDS = { google: "googleId", facebook: "facebookId", apple: "appleId" };

// username like "usama_a1b2c3" (unique)
const generateUniqueUsername = async (email) => {
  const base = String(email).split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20) || "user";
  for (let i = 0; i < 6; i++) {
    const candidate = `${base}_${crypto.randomBytes(3).toString("hex")}`;
    const exists = await User.findOne({ username: candidate }).select("_id").lean();
    if (!exists) return candidate;
  }
  return `user_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
};

// 📧 Nodemailer Transporter Setup
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Timezone helper for activity recording on login
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

const recordLoginMetrics = async (member) => {
  try {
    const now = new Date();
    member.metrics = member.metrics || {};
    member.metrics.lastActiveAt = now;
    await member.save();
  } catch (err) {
    console.error("Failed to record login metrics:", err);
  }
};

// ==========================================
// 1. REGISTER ROUTE (Local Email/Password)
// ==========================================
router.post("/register", authLimiter, async (req, res) => {
  try {
    const {
      companyName, firstName, lastName, username, phone, email, password,
      teamSize, businessType, website, addressLine, city, state, postalCode, country, timezone,
    } = req.body;

    if (!firstName || !email || !password) {
      return res.status(400).json({ success: false, message: "First name, email and password are required." });
    }
    if (!companyName || !phone) {
      return res.status(400).json({ success: false, message: "Company name and phone number are required." });
    }
    if (!businessType || !addressLine || !city || !country) {
      return res.status(400).json({ success: false, message: "Business type, address, city and country are required." });
    }

    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ success: false, message: "Invalid email or password format." });
    }
    const lowerEmail = email.toLowerCase().trim();
    if (!/^\S+@\S+\.\S+$/.test(lowerEmail)) {
      return res.status(400).json({ success: false, message: "Please enter a valid email address." });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters long." });
    }

    const cleanUsername = username ? String(username).trim() : undefined;
    const orConditions = [{ email: lowerEmail }];
    if (cleanUsername) orConditions.push({ username: cleanUsername });

    const userExists = await User.findOne({ $or: orConditions });

    if (userExists) {
      return res.status(400).json({ success: false, message: "Email or Username already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      companyName: companyName || "",
      firstName,
      lastName,
      username: cleanUsername,
      phone: phone || "",
      email: lowerEmail,
      password: hashedPassword,
      authProvider: "local",
      teamSize: teamSize || "",
      onboardingCompleted: true,
      settings: {
        vendorTitle: String(companyName).trim(),
        businessType: String(businessType).trim(),
        website: (website || "").trim(),
        addressLine: String(addressLine).trim(),
        city: String(city).trim(),
        state: (state || "").trim(),
        postalCode: (postalCode || "").trim(),
        country: String(country).trim(),
        businessPhone: (phone || "").trim(),
        contactEmail: lowerEmail,
        timezone: timezone || "UTC",
      },
    });

    const token = jwt.sign(
      { id: user._id, role: "Admin" },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      token,
      user: {
        id: user._id,
        companyName: user.companyName,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        phone: user.phone,
        email: user.email,
        avatar: user.avatar || user.profilePic || "",
        profilePic: user.profilePic || user.avatar || "",
        plan: user.plan,
        subscribed: user.subscribed,
        teamSize: user.teamSize || "",
        onboardingCompleted: true,
        settings: user.settings,
        role: "Admin"
      },
    });
  } catch (error) {
    console.error("🚨 Register Error:", error);
    if (error && error.code === 11000) {
      return res.status(400).json({ success: false, message: "Email or Username already exists" });
    }
    res.status(500).json({ success: false, message: "Registration failed. Please try again." });
  }
});

// ==========================================
// 1.5. SOCIAL LOGIN ROUTE (Google / Facebook / Apple)
// ==========================================
router.post("/social-login", authLimiter, async (req, res) => {
  try {
    const { provider, token, firstName: bodyFirst, lastName: bodyLast } = req.body || {};

    if (!SOCIAL_VERIFIERS[provider] || !token || typeof token !== "string") {
      return res.status(400).json({ success: false, message: "Invalid social login request." });
    }

    // 1) Verify the token with the provider (never trust browser-sent email / id)
    let profile;
    try {
      profile = await SOCIAL_VERIFIERS[provider](token);
    } catch (e) {
      console.error(`🚨 Social (${provider}) verification failed:`, e.message);
      return res.status(e.status || 401).json({
        success: false,
        message: e.publicMessage || "Social authentication failed. Please try again.",
      });
    }

    const idField = SOCIAL_ID_FIELDS[provider];
    // If the schema has no such field, a query on it would be stripped by Mongoose and
    // could match a random user -> only query / write it when the field really exists.
    const schemaHasIdField = !!User.schema.path(idField);
    if (!schemaHasIdField) {
      console.error(`⚠️ User schema is missing "${idField}". Add it to models/User.js for safe social linking.`);
    }

    const lowerEmail = profile.email.toLowerCase().trim();
    let user = null;
    if (schemaHasIdField && profile.providerId) {
      user = await User.findOne({ [idField]: profile.providerId });
    }
    if (!user) user = await User.findOne({ email: lowerEmail });
    let isNewUser = false;

    if (user) {
      if (user.status === "Terminated" || user.status === "Suspended") {
        return res.status(403).json({ success: false, message: "Your account is suspended or terminated." });
      }
      if (schemaHasIdField && user[idField] && String(user[idField]) !== profile.providerId) {
        return res.status(409).json({ success: false, message: "This email is already linked to a different social account." });
      }

      let changed = false;
      if (schemaHasIdField && !user[idField]) { user[idField] = profile.providerId; changed = true; }
      if (!user.avatar && profile.picture) { user.avatar = profile.picture; changed = true; }
      if (!user.profilePic && profile.picture) { user.profilePic = profile.picture; changed = true; }
      if (changed) await user.save({ validateModifiedOnly: true });
    } else {
      // Agents / team members must use email + password (don't silently create a 2nd Admin tenant)
      const agent = await TeamMember.findOne({ email: lowerEmail }).select("_id").lean();
      if (agent) {
        return res.status(403).json({
          success: false,
          message: "This email belongs to a team member account. Please sign in with your email and password.",
        });
      }

      isNewUser = true;
      const username = await generateUniqueUsername(lowerEmail);
      const newUserData = {
        email: lowerEmail,
        firstName: profile.firstName || bodyFirst || "User",
        lastName: profile.lastName || bodyLast || "",
        companyName: "",
        username,
        phone: "",
        authProvider: provider,
        avatar: profile.picture || "",
        profilePic: profile.picture || "",
        onboardingCompleted: false,
        status: "Active",
      };
      if (schemaHasIdField) newUserData[idField] = profile.providerId;
      user = await User.create(newUserData);

      try {
        const safeName = escapeHtml(user.firstName);
        const safeProvider = escapeHtml(String(provider).toUpperCase());
        const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
        const welcomeMailOptions = {
          from: `"PromiAPI Team" <${process.env.EMAIL_USER}>`,
          to: user.email,
          subject: "🎉 Welcome to PromiAPI - Account Successfully Created!",
          html: `
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"><title>Welcome to PromiAPI</title></head>
            <body style="margin: 0; padding: 0; background-color: #f4f7fb; font-family: Arial, sans-serif; color: #0f172a;">
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f4f7fb; padding: 40px 0;">
                <tr>
                  <td align="center">
                    <table border="0" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); overflow: hidden;">
                      <tr>
                        <td style="background: linear-gradient(135deg, #050b18 0%, #0a1931 100%); padding: 40px; text-align: center;">
                          <h1 style="color: #ffffff; font-size: 24px; margin: 0 0 10px 0;">Welcome, ${safeName}! 🚀</h1>
                          <p style="color: #9fb0c8; font-size: 15px; margin: 0;">You have successfully signed in via ${safeProvider}.</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 40px;">
                          <p style="font-size: 16px; color: #334155; margin-top: 0;">Hello <strong>${safeName}</strong>,</p>
                          <p style="font-size: 15px; line-height: 1.6; color: #475569;">
                            We are thrilled to have you on board <strong>PromiAPI</strong> — your ultimate omnichannel SaaS marketing and message automation platform.
                          </p>
                          <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 30px 0;">
                            <tr>
                              <td align="center">
                                <a href="${FRONTEND_URL}/dashboard" target="_blank" style="background: #2563eb; color: #ffffff; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: bold; text-decoration: none; display: inline-block;">Go to Your Dashboard</a>
                              </td>
                            </tr>
                          </table>
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
        // fire-and-forget: a slow / broken SMTP must never block or fail the login
        transporter.sendMail(welcomeMailOptions).catch((e) => console.error("🚨 Welcome email failed:", e.message));
      } catch (mailErr) {
        console.error("🚨 Failed to send social registration welcome email:", mailErr);
      }
    }

    const jwtToken = jwt.sign(
      { id: user._id, role: "Admin", adminId: user._id },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      success: true,
      message: isNewUser ? "Account created successfully!" : "Login successful",
      isNewUser,
      token: jwtToken,
      user: buildAdminPayload(user),
    });
  } catch (error) {
    console.error("🚨 Social Login Error:", error);
    if (error && error.code === 11000) {
      return res.status(409).json({ success: false, message: "An account with this email already exists." });
    }
    return res.status(500).json({ success: false, message: "Social login failed. Please try again." });
  }
});

// ==========================================
// 1.8. COMPLETE ONBOARDING ROUTE (New)
// ==========================================
router.post("/complete-onboarding", authMiddleware, async (req, res) => {
  try {
    const {
      companyName, phone, teamSize, businessType, website,
      addressLine, city, state, postalCode, country, timezone,
    } = req.body || {};
    const userId = req.user.id || req.user._id;

    if (req.user.role && req.user.role !== "Admin") {
      return res.status(403).json({ success: false, message: "Only account owners can complete onboarding." });
    }

    const isText = (v) => typeof v === "string" && v.trim().length > 0;
    if (!isText(companyName) || !isText(phone)) {
      return res.status(400).json({ success: false, message: "Company name and phone number are required." });
    }
    if (!isText(businessType) || !isText(addressLine) || !isText(city) || !isText(country)) {
      return res.status(400).json({ success: false, message: "Business type, address, city and country are required." });
    }
    const phoneDigits = phone.replace(/\D/g, "");
    if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      return res.status(400).json({ success: false, message: "Please enter a valid phone number with country code." });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }
    if (user.status === "Terminated" || user.status === "Suspended") {
      return res.status(403).json({ success: false, message: "Account access revoked." });
    }

    user.companyName = companyName.trim();
    user.phone = phone.trim();
    if (teamSize) user.teamSize = String(teamSize);

    // Make sure every account has a username (older / local accounts may not)
    if (!user.username) user.username = await generateUniqueUsername(user.email);

    // 🏢 Professional business profile -> stored in settings
    user.settings = {
      ...(user.settings && user.settings.toObject ? user.settings.toObject() : user.settings || {}),
      vendorTitle: companyName.trim(),
      businessType: String(businessType).trim(),
      website: (website || "").trim(),
      addressLine: String(addressLine).trim(),
      city: String(city).trim(),
      state: (state || "").trim(),
      postalCode: (postalCode || "").trim(),
      country: String(country).trim(),
      businessPhone: phone.trim(),
      contactEmail: (user.settings && user.settings.contactEmail) || user.email,
      timezone: timezone || (user.settings && user.settings.timezone) || "UTC",
    };
    user.onboardingCompleted = true;

    await user.save({ validateModifiedOnly: true });

    return res.status(200).json({
      success: true,
      message: "Onboarding completed successfully!",
      user: buildAdminPayload(user),
    });
  } catch (error) {
    console.error("🚨 Onboarding Error:", error);
    return res.status(500).json({ success: false, message: "Could not save your details. Please try again." });
  }
});

// ==========================================
// 2. FORGOT PASSWORD ROUTE
// ==========================================
router.post("/forgot-password", authLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    const lowerEmail = email.toLowerCase().trim();
    let user = await User.findOne({ email: lowerEmail });

    // Same answer whether or not the account exists (prevents email enumeration)
    if (!user) {
      return res.status(200).json({
        success: true,
        message: "If an account exists for this email, a password reset link has been sent.",
      });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");

    await User.findByIdAndUpdate(user._id, {
      resetPasswordToken: hashedToken,
      resetPasswordExpires: Date.now() + 3600000,
    });

    const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
    const resetUrl = `${FRONTEND_URL}/reset-password/${resetToken}`;

    const mailOptions = {
      from: `"PromiAPI Security" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: "🔒 Password Reset Request - PromiAPI",
      html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>Password Reset</title></head>
        <body style="font-family: Arial, sans-serif; background-color: #f4f7fb; padding: 20px;">
          <div style="max-width: 600px; background: #ffffff; padding: 30px; border-radius: 10px;">
            <h2>Password Reset Request</h2>
            <p>Click the link below to reset your password:</p>
            <a href="${resetUrl}" style="background: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Reset Password</a>
            <p>This link is valid for 1 hour.</p>
          </div>
        </body>
        </html>
      `
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({
      success: true,
      message: "Password reset link has been sent to your email!",
    });
  } catch (error) {
    console.error("🚨 Forgot Password Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to send reset email. Please try again later.",
    });
  }
});

// ==========================================
// 3. RESET PASSWORD ROUTE
// ==========================================
router.post("/reset-password/:token", authLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    const { token } = req.params;

    if (!password || typeof password !== "string" || password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters long.",
      });
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Reset token is invalid or has expired.",
      });
    }

    user.password = await bcrypt.hash(password, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.authProvider = "local";

    await user.save({ validateModifiedOnly: true });

    res.status(200).json({
      success: true,
      message: "🎉 Password updated successfully!",
    });
  } catch (error) {
    console.error("🚨 Reset Password Error:", error);
    res.status(500).json({ success: false, message: "Could not reset password. Please try again." });
  }
});

// ==========================================
// 4. LOGIN ROUTE
// ==========================================
router.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    const lowerEmail = email.toLowerCase().trim();
    let account = null;
    let isAgent = false;

    account = await User.findOne({ email: lowerEmail });

    if (!account) {
      account = await TeamMember.findOne({ email: lowerEmail });
      if (account) isAgent = true;
    }

    if (!account) {
      return res.status(400).json({ success: false, message: "Invalid Email or Password." });
    }

    if (account.status === "Terminated") {
      return res.status(403).json({ success: false, message: "Your account has been terminated." });
    }

    if (account.status === "Suspended") {
      return res.status(403).json({ success: false, message: "Your account is temporarily suspended." });
    }

    if (isAgent && account.status !== "Active") {
      return res.status(400).json({ success: false, message: "Your account status is pending activation." });
    }

    if (!account.password) {
      return res.status(400).json({ success: false, message: "This account uses Social Login. Please sign in with Google, Facebook or Apple." });
    }

    const isMatch = await bcrypt.compare(password, account.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: "Invalid Email or Password." });
    }

    if (isAgent) {
      await recordLoginMetrics(account);
    }

    const token = jwt.sign(
      { 
        id: account._id, 
        role: isAgent ? account.role : "Admin",
        adminId: isAgent ? account.adminId : account._id
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    let subscriptionData = { subscribed: false, plan: null, expiresAt: null };
    
    if (isAgent) {
      const mainAdmin = await User.findById(account.adminId);
      if (mainAdmin) {
        subscriptionData.subscribed = mainAdmin.subscribed || false;
        subscriptionData.plan = mainAdmin.plan || null;
        subscriptionData.expiresAt = mainAdmin.expiresAt || mainAdmin.subscription?.endDate || null;
      }
    } else {
      subscriptionData.subscribed = account.subscribed || false;
      subscriptionData.plan = account.plan || null;
      subscriptionData.expiresAt = account.expiresAt || account.subscription?.endDate || null;
    }

    const avatarUrl = account.avatar || account.profilePic || "";

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: account._id,
        firstName: account.firstName || account.name || "User",
        lastName: account.lastName || "",
        email: account.email,
        avatar: avatarUrl,
        profilePic: avatarUrl,
        role: isAgent ? account.role : "Admin",
        companyName: account.companyName || "",
        phone: account.phone || "",
        username: account.username || "",
        onboardingCompleted: isAgent ? true : isOnboarded(account),
        settings: isAgent ? undefined : account.settings,
        permissions: account.permissions || null,
        subscribed: subscriptionData.subscribed,
        plan: subscriptionData.plan,             
        expiresAt: subscriptionData.expiresAt     
      }
    });

  } catch (error) {
    console.error("🚨 Critical Authentication System Failure:", error);
    return res.status(500).json({ success: false, message: "Internal server gateway error." });
  }
});

// ==========================================
// 5. CURRENT PROFILE ROUTE
// ==========================================
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    let account = null;

    if (req.user.role === "Admin") {
      account = await User.findById(userId).select("-password");
    } else {
      account = await TeamMember.findById(userId).select("-password");
    }

    if (!account) {
      return res.status(404).json({ success: false, message: "User session profile not found." });
    }

    if (account.status === "Terminated" || account.status === "Suspended") {
      return res.status(403).json({ success: false, message: "Account access revoked." });
    }

    let subscriptionData = { subscribed: false, plan: null, expiresAt: null };
    if (req.user.role !== "Admin") {
      const mainAdmin = await User.findById(account.adminId);
      if (mainAdmin) {
        subscriptionData.subscribed = mainAdmin.subscribed || false;
        subscriptionData.plan = mainAdmin.plan || null;
        subscriptionData.expiresAt = mainAdmin.expiresAt || mainAdmin.subscription?.endDate || null;
      }
    } else {
      subscriptionData.subscribed = account.subscribed || false;
      subscriptionData.plan = account.plan || null;
      subscriptionData.expiresAt = account.expiresAt || account.subscription?.endDate || null;
    }

    const avatarUrl = account.avatar || account.profilePic || "";

    res.json({
      success: true,
      user: {
        id: account._id,
        firstName: account.firstName || account.name || "User",
        lastName: account.lastName || "",
        email: account.email,
        avatar: avatarUrl,
        profilePic: avatarUrl,
        role: req.user.role,
        companyName: account.companyName || "",
        phone: account.phone || "",
        username: account.username || "",
        onboardingCompleted: req.user.role !== "Admin" ? true : isOnboarded(account),
        permissions: account.permissions || null,
        subscribed: subscriptionData.subscribed,
        plan: subscriptionData.plan,             
        expiresAt: subscriptionData.expiresAt     
      }
    });
  } catch (error) {
    console.error("Get profile me error:", error);
    res.status(500).json({ success: false, message: "Server error reading profile." });
  }
});

// ==========================================
// 6. LOGOUT ROUTE
// ==========================================
router.post("/logout", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    
    if (req.user.role !== "Admin" && mongoose.isValidObjectId(userId)) {
      await TeamMember.findByIdAndUpdate(userId, {
        $set: { "metrics.lastActiveAt": null }
      });
    }

    res.json({ success: true, message: "Logged out successfully." });
  } catch (error) {
    console.error("🚨 Logout Error:", error);
    res.status(500).json({ success: false, message: "Internal server error during logout." });
  }
});

module.exports = router;