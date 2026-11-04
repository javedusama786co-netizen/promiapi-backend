const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const auth = require("../middleware/auth"); // Auth middleware import
const { createUploader, urlPathOf, getBaseUrl, userSegment, listKeys, R2_ENABLED } = require("../middleware/upload");

// Files go to Cloudflare R2 (Render's own disk is wiped on every restart).
// The saved path keeps the OLD format "/uploads/<userId>/<file>", so the flow builder / frontend need no change.
const upload = createUploader({ folder: "", perUser: true, prefix: "file", maxSize: 100 * 1024 * 1024 });

// 1. File Upload Route (Protected)
router.post("/upload", auth, upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    const filePath = urlPathOf(req.file); // "/uploads/<userId>/<file>"

    res.status(200).json({
      success: true,
      message: "File uploaded successfully!",
      filePath,                                  // same as before (relative)
      url: `${getBaseUrl(req)}${filePath}`,      // full link, for convenience
      fileName: req.file.originalname,
    });
  } catch (error) {
    console.error("Upload Route Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. User Media Gallery Fetch Route (Protected)
router.get("/user-gallery", auth, async (req, res) => {
  try {
    const base = getBaseUrl(req);
    const folder = userSegment(req);

    if (R2_ENABLED) {
      const items = await listKeys(`uploads/${folder}/`);
      const files = items
        .filter((o) => !path.basename(o.key).startsWith("."))
        .map((o) => `${base}/${o.key}`);
      return res.status(200).json({ success: true, files });
    }

    // Local-disk fallback (development without R2 variables)
    const userDir = path.join(__dirname, `../uploads/${folder}`);
    if (!fs.existsSync(userDir)) {
      return res.status(200).json({ success: true, files: [] });
    }
    const validFiles = fs.readdirSync(userDir).filter((file) => !file.startsWith("."));
    res.status(200).json({ success: true, files: validFiles.map((file) => `${base}/uploads/${folder}/${file}`) });
  } catch (error) {
    console.error("Gallery Fetch Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;