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
router.post("/register", async (req, res) => {
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

    const lowerEmail = email ? email.toLowerCase().trim() : "";

    const userExists = await User.findOne({
      $or: [{ email: lowerEmail }, { username }],
    });

    if (userExists) {
      return res.status(400).json({ success: false, message: "Email or Username already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      companyName: companyName || "",
      firstName,
      lastName,
      username,
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
      process.env.JWT_SECRET || "my_super_secret_key_123",
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
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 1.5. SOCIAL LOGIN ROUTE (Google / Facebook / Apple)
// ==========================================
router.post("/social-login", async (req, res) => {
  try {
    const { provider, email, firstName, lastName, profilePic, providerId } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required from social provider." });
    }

    const lowerEmail = email.toLowerCase().trim();
    let user = await User.findOne({ email: lowerEmail });
    let isNewUser = false;

    if (user) {
      if (provider === "google" && !user.googleId) user.googleId = providerId;
      if (provider === "facebook" && !user.facebookId) user.facebookId = providerId;
      if (provider === "apple" && !user.appleId) user.appleId = providerId;
      
      if (!user.avatar && profilePic) user.avatar = profilePic;
      if (!user.profilePic && profilePic) user.profilePic = profilePic;
      
      await user.save();
    } else {
      isNewUser = true;
      user = await User.create({
        email: lowerEmail,
        firstName: firstName || "User",
        lastName: lastName || "",
        companyName: "",
        username: `user_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        phone: "",
        authProvider: provider || "google",
        googleId: provider === "google" ? providerId : null,
        facebookId: provider === "facebook" ? providerId : null,
        appleId: provider === "apple" ? providerId : null,
        avatar: profilePic || "",
        profilePic: profilePic || "",
        status: "Active"
      });

      try {
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
                          <h1 style="color: #ffffff; font-size: 24px; margin: 0 0 10px 0;">Welcome, ${user.firstName}! 🚀</h1>
                          <p style="color: #9fb0c8; font-size: 15px; margin: 0;">You have successfully signed in via ${provider ? provider.toUpperCase() : 'Social Auth'}.</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 40px;">
                          <p style="font-size: 16px; color: #334155; margin-top: 0;">Hello <strong>${user.firstName}</strong>,</p>
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
        await transporter.sendMail(welcomeMailOptions);
      } catch (mailErr) {
        console.error("🚨 Failed to send social registration welcome email:", mailErr);
      }
    }

    if (user.status === "Terminated" || user.status === "Suspended") {
      return res.status(403).json({ success: false, message: "Your account is suspended or terminated." });
    }

    const token = jwt.sign(
      { id: user._id, role: "Admin", adminId: user._id },
      process.env.JWT_SECRET || "my_super_secret_key_123",
      { expiresIn: "7d" }
    );

    const avatarUrl = user.avatar || user.profilePic || "";

    return res.status(200).json({
      success: true,
      message: isNewUser ? "Account created successfully!" : "Login successful",
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        avatar: avatarUrl,
        profilePic: avatarUrl,
        role: "Admin",
        companyName: user.companyName || "",
        phone: user.phone || "",
        subscribed: user.subscribed || false,
        plan: user.plan || "Free",
        expiresAt: user.subscription?.endDate || null
      }
    });

  } catch (error) {
    console.error("🚨 Social Login Error:", error);
    return res.status(500).json({ success: false, message: error.message || "Social login failed." });
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
    } = req.body;
    const userId = req.user.id || req.user._id;

    if (!companyName || !phone) {
      return res.status(400).json({ success: false, message: "Company name and phone number are required." });
    }
    if (!businessType || !addressLine || !city || !country) {
      return res.status(400).json({ success: false, message: "Business type, address, city and country are required." });
    }

    let user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    user.companyName = companyName.trim();
    user.phone = phone.trim();
    if (teamSize) user.teamSize = teamSize;

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

    await user.save();

    return res.status(200).json({
      success: true,
      message: "Onboarding completed successfully!",
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        companyName: user.companyName,
        phone: user.phone,
        teamSize: user.teamSize || "",
        settings: user.settings,
        role: "Admin"
      }
    });
  } catch (error) {
    console.error("🚨 Onboarding Error:", error);
    return res.status(500).json({ success: false, message: error.message || "Internal server error." });
  }
});

// ==========================================
// 2. FORGOT PASSWORD ROUTE
// ==========================================
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    const lowerEmail = email.toLowerCase().trim();
    let user = await User.findOne({ email: lowerEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "No registered account found with this email.",
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
      message: error.message || "Failed to send reset email.",
    });
  }
});

// ==========================================
// 3. RESET PASSWORD ROUTE
// ==========================================
router.post("/reset-password/:token", async (req, res) => {
  try {
    const { password } = req.body;
    const { token } = req.params;

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long.",
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
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// 4. LOGIN ROUTE
// ==========================================
router.post("/login", async (req, res) => {
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

    if (!account.password && account.authProvider !== "local") {
      return res.status(400).json({ success: false, message: "This account uses Social Login. Please sign in with Google/Facebook." });
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
      process.env.JWT_SECRET || "my_super_secret_key_123",
      { expiresIn: "7d" }
    );

    let subscriptionData = { subscribed: false, plan: null, expiresAt: null };
    
    if (isAgent) {
      const mainAdmin = await User.findById(account.adminId);
      if (mainAdmin) {
        subscriptionData.subscribed = mainAdmin.subscribed || false;
        subscriptionData.plan = mainAdmin.plan || null;
        subscriptionData.expiresAt = mainAdmin.expiresAt || null;
      }
    } else {
      subscriptionData.subscribed = account.subscribed || false;
      subscriptionData.plan = account.plan || null;
      subscriptionData.expiresAt = account.expiresAt || null;
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
        subscriptionData.expiresAt = mainAdmin.expiresAt || null;
      }
    } else {
      subscriptionData.subscribed = account.subscribed || false;
      subscriptionData.plan = account.plan || null;
      subscriptionData.expiresAt = account.expiresAt || null;
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