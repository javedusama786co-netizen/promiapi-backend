const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const User = require("../models/User");
const TeamMember = require("../models/TeamMember");

// 📧 Nodemailer Transporter Setup
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// 📝 REGISTER CONTROLLER (FIXED TOKEN PAYLOAD)
exports.register = async (req, res) => {
  try {
    const {
      companyName,
      firstName,
      lastName,
      username,
      phone,
      email,
      password,
    } = req.body;

    const lowerEmail = email ? email.toLowerCase().trim() : "";

    const userExists = await User.findOne({
      $or: [{ email: lowerEmail }, { username }],
    });

    if (userExists) {
      return res.status(400).json({
        success: false,
        message: "Email or Username already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      companyName,
      firstName,
      lastName,
      username,
      phone,
      email: lowerEmail,
      password: hashedPassword,
    });

    // 🎯 FIX: Added adminId to JWT token payload during registration
    const token = jwt.sign(
      { 
        id: user._id, 
        role: "Admin",
        adminId: user._id 
      },
      process.env.JWT_SECRET || "my_super_secret_key_123",
      { expiresIn: "7d" }
    );

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      token,
      user: {
        id: user._id,
        adminId: user._id,
        companyName: user.companyName,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        phone: user.phone,
        email: user.email,
        plan: user.plan,
        subscribed: user.subscribed,
        role: "Admin",
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// 🎯 MULTI-LOGIN: ADMIN + AGENT LOGIN MANAGEMENT
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    const lowerEmail = email.toLowerCase().trim();
    let account = null;
    let isAgent = false;

    // 1. Check Admin Collection
    account = await User.findOne({ email: lowerEmail });

    // 2. Check Team Member (Agent) Collection if not admin
    if (!account) {
      account = await TeamMember.findOne({ email: lowerEmail });
      if (account) isAgent = true;
    }

    // 3. Email not found in both
    if (!account) {
      return res.status(400).json({
        success: false,
        message: "Invalid Email or Password.",
      });
    }

    // 🟢 Status Checks (Terminated/Suspended)
    if (account.status === "Terminated" || account.status === "Suspended") {
      return res.status(403).json({ 
        success: false, 
        message: `Your account is ${account.status}. Please contact support.` 
      });
    }

    // 4. Verify Agent Status
    if (isAgent && account.status !== "Active") {
      return res.status(400).json({
        success: false,
        message: `Your account status is ${account.status || 'Pending'}. Please complete activation or contact admin.`,
      });
    }

    // 5. Compare Encrypted Password
    const isMatch = await bcrypt.compare(password, account.password);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Invalid Email or Password.",
      });
    }

    // 6. JWT Token Generation
    const tokenPayload = { 
      id: account._id, 
      role: isAgent ? account.role : "Admin",
      adminId: isAgent ? account.adminId : account._id 
    };

    const token = jwt.sign(
      tokenPayload,
      process.env.JWT_SECRET || "my_super_secret_key_123",
      { expiresIn: "7d" }
    );

    // 7. Dynamic Subscription Data Extraction
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

    // 8. Dynamic Response Matrix
    res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: account._id,
        firstName: account.firstName || account.name || "User",
        lastName: account.lastName || "",
        email: account.email,
        role: isAgent ? account.role : "Admin",
        adminId: isAgent ? account.adminId : account._id,
        companyName: account.companyName || "", 
        permissions: account.permissions || null,
        subscribed: subscriptionData.subscribed,
        plan: subscriptionData.plan,
        expiresAt: subscriptionData.expiresAt,
      },
    });
  } catch (error) {
    console.error("🚨 Critical Authentication Failure:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Internal server gateway error.",
    });
  }
};

// 🔑 FORGOT PASSWORD CONTROLLER
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email enter karna zaroori hai." });
    }

    const lowerEmail = email.toLowerCase().trim();
    let user = await User.findOne({ email: lowerEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Is email se koi registered account nahi mila.",
      });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = Date.now() + 3600000;

    await user.save();

    const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
    const resetUrl = `${FRONTEND_URL}/reset-password/${resetToken}`;

    const mailOptions = {
      from: `"PromiAPI Support" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: "🔑 Password Reset Request",
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
          <h2>Password Reset Request</h2>
          <p>Aapne PromiAPI account ke password reset ke liye request ki hai.</p>
          <a href="${resetUrl}" style="background: #2563eb; color: white; padding: 12px 20px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 15px 0;">Reset Password</a>
          <p style="color: #64748b; font-size: 13px;">Yeh link 1 ghante tak valid hai.</p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({
      success: true,
      message: "Password reset link aapke email par bhej diya gaya hai!",
    });
  } catch (error) {
    console.error("🚨 Forgot Password Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Email send nahi ho saka. SMTP settings check karein.",
    });
  }
};

// 🔒 RESET PASSWORD CONTROLLER
exports.resetPassword = async (req, res) => {
  try {
    const { password } = req.body;
    const { token } = req.params;

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password kam se kam 6 characters ka hona chahiye.",
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
        message: "Reset token invalid hai ya expire ho chuka hai.",
      });
    }

    user.password = await bcrypt.hash(password, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;

    await user.save();

    res.status(200).json({
      success: true,
      message: "🎉 Password successfully update ho gaya hai!",
    });
  } catch (error) {
    console.error("🚨 Reset Password Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// 🎯 GET PROFILE ROUTE (/me SESSION MATRIX)
exports.getProfile = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    let account = null;
    let isAgent = req.user.role !== "Admin";

    if (!isAgent) {
      account = await User.findById(userId).select("-password");
    } else {
      account = await TeamMember.findById(userId).select("-password");
    }

    if (!account) {
      return res.status(404).json({
        success: false,
        message: "User session profile not found.",
      });
    }

    if (account.status === "Terminated" || account.status === "Suspended") {
      return res.status(403).json({ 
        success: false, 
        message: "Account access revoked. Please contact administrator." 
      });
    }

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

    res.status(200).json({
      success: true,
      user: {
        id: account._id,
        adminId: isAgent ? account.adminId : account._id,
        firstName: account.firstName || account.name || "User",
        lastName: account.lastName || "",
        email: account.email,
        role: req.user.role,
        permissions: account.permissions || null,
        subscribed: subscriptionData.subscribed,
        plan: subscriptionData.plan,
        expiresAt: subscriptionData.expiresAt,
      },
    });
  } catch (error) {
    console.error("🚨 Get Profile Error:", error);
    res.status(500).json({
      success: false,
      message: "Server error reading profile.",
    });
  }
};