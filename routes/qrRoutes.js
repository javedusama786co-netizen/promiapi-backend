const express = require("express");
const router = express.Router();
const QRCode = require("../models/QRCode");
const authMiddleware = require("../middleware/auth"); 

// Helper function to dynamically construct Host URL (handles ngrok & proxies)
const getBaseUrl = (req) => {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${protocol}://${host}`;
};

// 1. SAVE NEW QR CODE
router.post("/save", authMiddleware, async (req, res) => {
  try {
    const { title, phoneNumber, defaultMessage, fgColor, bgColor, logoUrl } = req.body;

    // Robust User ID Extraction from Authenticated Token
    const userId = req.user?.id || req.user?._id || req.user?.adminId;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication failed. User ID missing." });
    }

    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: "Phone number is required" });
    }

    const newQr = new QRCode({
      userId,
      title: title || "WhatsApp Marketing QR",
      phoneNumber,
      defaultMessage: defaultMessage || "",
      fgColor: fgColor || "#0f172a",
      bgColor: bgColor || "#ffffff",
      logoUrl: logoUrl || "",
    });

    await newQr.save();

    // Dynamically generate public tracking URL using current host domain (ngrok or live)
    const trackingUrl = `${getBaseUrl(req)}/api/qr/track/${newQr._id}`;

    return res.status(201).json({
      success: true,
      message: "QR Code saved successfully!",
      data: {
        ...newQr.toObject(),
        trackingUrl,
      },
    });
  } catch (error) {
    console.error("Save QR Error:", error);
    return res.status(500).json({ success: false, message: error.message || "Server error saving QR Code" });
  }
});

// 2. GET ALL USER SAVED QRs
router.get("/my-qrs", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.user?.adminId;
    const qrs = await QRCode.find({ userId }).sort({ createdAt: -1 });
    
    const baseUrl = getBaseUrl(req);
    const formattedQrs = qrs.map((qr) => ({
      ...qr.toObject(),
      trackingUrl: `${baseUrl}/api/qr/track/${qr._id}`,
    }));

    return res.status(200).json({ success: true, count: qrs.length, data: formattedQrs });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error fetching QR codes" });
  }
});

// 3. PUBLIC ANALYTICS TRACKING ROUTE
router.get("/track/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const qr = await QRCode.findByIdAndUpdate(
      id,
      { $inc: { scansCount: 1 } },
      { returnDocument: "after" }
    );

    if (!qr) {
      return res.status(404).send("Invalid or expired QR Code.");
    }

    const cleanNumber = qr.phoneNumber.replace(/[^0-9]/g, "");
    const encodedMsg = encodeURIComponent(qr.defaultMessage || "");
    const waUrl = `https://wa.me/${cleanNumber}${encodedMsg ? `?text=${encodedMsg}` : ""}`;

    return res.redirect(waUrl);
  } catch (error) {
    console.error("Track QR Error:", error);
    return res.status(500).send("Error processing QR Code redirection.");
  }
});

// 4. DELETE QR CODE
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.user?.adminId;
    const qr = await QRCode.findOneAndDelete({ _id: req.params.id, userId });
    
    if (!qr) {
      return res.status(404).json({ success: false, message: "QR Code not found" });
    }

    return res.status(200).json({ success: true, message: "QR Code deleted successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error deleting QR code" });
  }
});

module.exports = router;