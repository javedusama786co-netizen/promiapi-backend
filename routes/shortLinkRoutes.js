const express = require("express");
const router = express.Router();
const ShortLink = require("../models/ShortLink");
const authMiddleware = require("../middleware/auth");

const getBaseUrl = (req) => {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${protocol}://${host}`;
};

// Create Short Link
router.post("/create", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.user?.adminId;
    const { title, slug, phoneNumber, defaultMessage } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: "WhatsApp number is required." });
    }

    const finalSlug = slug ? slug.toLowerCase().replace(/[^a-z0-9-_]/g, "") : Math.random().toString(36).substring(2, 8);

    const existing = await ShortLink.findOne({ slug: finalSlug });
    if (existing) {
      return res.status(400).json({ success: false, message: "This custom slug is already taken. Choose another." });
    }

    const newLink = new ShortLink({
      userId,
      title: title || "Untitled Short Link",
      slug: finalSlug,
      phoneNumber,
      defaultMessage: defaultMessage || "",
    });

    await newLink.save();
    const shortUrl = `${getBaseUrl(req)}/s/${finalSlug}`;

    return res.status(201).json({
      success: true,
      message: "Short link created successfully!",
      data: { ...newLink.toObject(), shortUrl },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Get All User Short Links
router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id || req.user?.adminId;
    const links = await ShortLink.find({ userId }).sort({ createdAt: -1 });
    const baseUrl = getBaseUrl(req);

    const formatted = links.map((l) => ({
      ...l.toObject(),
      shortUrl: `${baseUrl}/s/${l.slug}`,
    }));

    return res.status(200).json({ success: true, data: formatted });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Error fetching short links." });
  }
});

// Public Redirection Route for Short Links
router.get("/s/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const link = await ShortLink.findOneAndUpdate({ slug }, { $inc: { clicks: 1 } }, { returnDocument: "after" });

    if (!link) return res.status(404).send("Short link not found or expired.");

    const cleanNum = link.phoneNumber.replace(/[^0-9]/g, "");
    const msg = encodeURIComponent(link.defaultMessage || "");
    const waUrl = `https://wa.me/${cleanNum}${msg ? `?text=${msg}` : ""}`;

    return res.redirect(waUrl);
  } catch (error) {
    return res.status(500).send("Server error processing short link.");
  }
});

module.exports = router;