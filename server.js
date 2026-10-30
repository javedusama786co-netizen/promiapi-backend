require('dotenv').config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs"); 
const multer = require("multer"); 

const connectDB = require("./db");
const auth = require("./middleware/auth");
const User = require("./models/User");

// 🟢 REGISTER MONGOOSE MODELS FIRST TO PREVENT SCHEMA ERRORS
require("./models/MetaConfig"); 
require("./models/Order"); // 🟢 Fix: Order model yahan register kar diya hai taake MongoDB mein orders collection ban sakay

// ROUTE IMPORTS
const adminRoutes = require("./routes/adminRoutes");
const analyticsRoute = require('./routes/analyticsRoute');
const qrRoutes = require("./routes/qrRoutes");
const tenantRoutes = require("./routes/tenantRoutes");
const mediaRoutes = require("./routes/mediaRoutes");
const botFlowRoutes = require("./routes/botFlowRoutes");
const aiSettingsRoutes = require("./routes/aiSettings");
const vendorRoutes = require("./routes/vendor");
const subscriptionRoutes = require("./routes/subscription");
const statsRoutes = require("./routes/stats");
const teamRoutes = require("./routes/teamRoutes");
const notificationRoutes = require('./routes/notifications');
const groupRoutes = require("./routes/groups");
const contactRoutes = require("./routes/contacts");
const templateRoutes = require("./routes/templates");
const campaignRoutes = require("./routes/campaigns");
const webhookRoutes = require("./routes/webhookRoutes");
const botReplyRoutes = require("./routes/botReplyRoutes");
const authRoutes = require("./routes/authRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const messageLogRoutes = require("./routes/messageLogRoutes");
const chatRoutes = require("./routes/chatRoutes");
const shortLinkRoutes = require("./routes/shortLinkRoutes");
const ctaRoutes = require("./routes/ctaRoutes");
const widgetRoutes = require("./routes/widgetRoutes");

// 🔗 Auto-Integration Routes Import
const integrationRoutes = require("./routes/integrationRoutes");

// 🛒 E-commerce Webhook Router Import
const ecommerceRoutes = require("./routes/ecommerceRoutes");

// 🎯 WhatsApp Router File Import
const whatsappConfigRoutes = require("./routes/whatsappConfig");
const WhatsAppConfig = require("./models/whatsappConfigModel");

// 🤖 Dedicated AI Bot Settings Router Import
const aiBotRoutes = require("./routes/aiBotRoutes");

const { connectToWhatsApp, getQR } = require('./services/whatsappService');
const { processIncomingWithAI } = require("./utils/aiChatEngine");

const app = express();

// Live Server par HTTPS protocol read karne ke liye
app.set('trust proxy', true);

// ==========================================
// 🟢 FIXED CORS FOR NGROK, LOCAL DEV & PATCH REQUESTS
// ==========================================
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning"],
    credentials: true,
  })
);

// ngrok ka browser warning bypass header
app.use((req, res, next) => {
  res.header("ngrok-skip-browser-warning", "true");
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 🖼️ UPDATED: CROSS-ORIGIN STATIC MEDIA SERVING
// ==========================================
app.use("/uploads", (req, res, next) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  next();
}, express.static(path.join(__dirname, "uploads")));

// Database Connection
connectDB();

// ==========================================
// 📁 UPLOADS DIRECTORIES SETUP (LOGOS & AVATARS)
// ==========================================
const uploadsBaseDir = path.join(__dirname, "uploads");
const logoUploadDir = path.join(__dirname, "uploads/logos");
const avatarUploadDir = path.join(__dirname, "uploads/avatars");

[uploadsBaseDir, logoUploadDir, avatarUploadDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Logo Storage Config
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, logoUploadDir);
  },
  filename: (req, file, cb) => {
    const userId = req.user?.id || req.user?._id || req.user?.adminId || `usr_${Date.now()}`;
    const ext = path.extname(file.originalname);
    const uniqueFileName = `logo-${userId}-${Date.now()}${ext}`;
    cb(null, uniqueFileName);
  },
});

const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed!"));
    }
  },
});

// Dedicated Upload Endpoint for Vendor Logos
app.post("/api/vendor/upload-logo", auth, uploadLogo.single("logo"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const logoUrl = `${req.protocol}://${req.get("host")}/uploads/logos/${req.file.filename}`;

    return res.status(200).json({
      success: true,
      url: logoUrl,
      filename: req.file.filename,
    });
  } catch (error) {
    console.error("Logo upload error:", error);
    return res.status(500).json({ success: false, message: "Failed to upload logo." });
  }
});

// ==========================================
// 📸 DIRECT AVATAR UPLOAD ROUTE
// ==========================================
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarUploadDir),
  filename: (req, file, cb) => {
    const userId = req.user?.id || req.user?._id || req.user?.adminId || `usr_${Date.now()}`;
    cb(null, `avatar-${userId}-${Date.now()}${path.extname(file.originalname)}`);
  }
});

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.post("/api/auth/profile/avatar", auth, uploadAvatar.single("avatar"), async (req, res) => {
  try {
    const file = req.file || req.files?.file?.[0];
    if (!file) {
      return res.status(400).json({ success: false, message: "No avatar image provided" });
    }

    const userId = req.user?.id || req.user?._id || req.user?.adminId;
    const avatarPath = `/uploads/avatars/${file.filename}`;

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: { avatar: avatarPath, profilePic: avatarPath } },
      { new: true }
    ).select("-password");

    return res.json({
      success: true,
      message: "Avatar saved to database!",
      avatar: avatarPath,
      profilePic: avatarPath,
      user: updatedUser
    });
  } catch (err) {
    console.error("Avatar Save Error:", err);
    return res.status(500).json({ success: false, message: "Database update failed." });
  }
});

// ==========================================
// 🔴 REGISTERED APP ROUTES (PRIORITY ORDERED)
// ==========================================

// 🎯 HIGH PRIORITY: CAMPAIGNS ROUTE
app.use("/api/campaigns", campaignRoutes);

// 🟢 1. High-Priority System & Core Auth Routes
app.use("/api/admin", adminRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);

// 🟢 2. Secondary Feature Routes
app.use("/api/chats", chatRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/ecommerce", ecommerceRoutes);
app.use("/api/qr", qrRoutes);
app.use("/api/ai-bot", aiBotRoutes);
app.use("/api/short-links", shortLinkRoutes);
app.use("/", shortLinkRoutes); // Public redirect /s/:slug ke liye
app.use("/api/cta-urls", ctaRoutes);
app.use("/api/widgets", widgetRoutes);
app.use("/", widgetRoutes); // /widget.js serve karne ke liye

// 🟢 3. Tenant & Dynamic Specific Routes
app.use("/api/tenant", tenantRoutes);

// Rest of App Routes
app.use('/api/analytics', analyticsRoute);
app.use("/api/media", mediaRoutes);
app.use("/api/bot-flows", botFlowRoutes);
app.use("/api/vendor", aiSettingsRoutes);
app.use("/api/vendor", vendorRoutes);
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/stats", statsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/groups", groupRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/bot-replies", botReplyRoutes);
app.use("/api/message-logs", messageLogRoutes);

// 🔑 Social Router
app.use("/api", whatsappConfigRoutes);

// Webhook routes (Multi-path support for foolproof integration)[cite: 17]
app.use("/api/webhooks", webhookRoutes);
app.use("/api/webhook", webhookRoutes);
app.use("/shopify", webhookRoutes);       // Direct root fallback for Shopify
app.use("/woocommerce", webhookRoutes);   // Direct root fallback for WooCommerce

app.use("/api/team", teamRoutes);

// DIRECT WHATSAPP CONFIG FALLBACK ROUTES
app.post("/api/whatsapp/config", auth, async (req, res) => {
    try {
        const userId = req.user?.adminId || req.user?.id || req.user?._id;
        let { accessToken, phoneNumberId, businessAccountId } = req.body;

        if (!userId) {
            return res.status(401).json({ success: false, message: "User authentication missing." });
        }

        if (!accessToken || !phoneNumberId || !businessAccountId) {
            return res.status(400).json({ success: false, message: "All fields are required." });
        }

        accessToken = accessToken.trim();
        phoneNumberId = phoneNumberId.trim();
        businessAccountId = businessAccountId.trim();

        const updatedConfig = await WhatsAppConfig.findOneAndUpdate(
            { userId: userId },
            { accessToken, phoneNumberId, businessAccountId },
            { returnDocument: 'after', upsert: true, runValidators: true }
        );

        return res.json({
            success: true,
            message: "Configurations securely saved!",
            config: updatedConfig
        });
    } catch (error) {
        console.error("❌ Config Save Error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get("/api/whatsapp/config", auth, async (req, res) => {
    try {
        const userId = req.user?.adminId || req.user?.id || req.user?._id;
        const config = await WhatsAppConfig.findOne({ userId });
        res.json({ success: true, config: config || null });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// WHATSAPP QR & INSTANCE CHANNELS
app.post('/api/whatsapp/init', auth, async (req, res) => {
    try {
        const userId = req.user.id || req.user._id;
        await connectToWhatsApp(userId);
        res.json({ success: true, message: "Initialization started..." });
    } catch (error) {
        res.status(500).json({ success: false, message: "WhatsApp initialization failed." });
    }
});

app.get('/api/whatsapp/qr', auth, (req, res) => {
    const userId = req.user.id || req.user._id;
    const qr = getQR(userId);
    
    if (qr) {
        res.json({ success: true, qr });
    } else {
        res.json({ success: false, message: "QR not generated yet or device already linked." });
    }
});

// Home route
app.get("/", (req, res) => {
  res.send("Backend is running securely");
}); 

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend Server running on port ${PORT}`);
});