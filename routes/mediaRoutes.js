const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const auth = require("../middleware/auth"); // Auth middleware import

// Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Auth middleware se req.user fetch karna
    const userId = req.user?.adminId || req.user?.id || req.user?._id || "user_101";
    const userDir = path.join(__dirname, `../uploads/${userId}`);

    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({ storage });

// 1. File Upload Route (Protected)
router.post("/upload", auth, upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    const userId = req.user?.adminId || req.user?.id || req.user?._id || "user_101";
    const filePath = `/uploads/${userId}/${req.file.filename}`;

    res.status(200).json({
      success: true,
      message: "File uploaded successfully!",
      filePath: filePath,
    });
  } catch (error) {
    console.error("Upload Route Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. User Media Gallery Fetch Route (Protected)
router.get("/user-gallery", auth, (req, res) => {
  try {
    const userId = req.user?.adminId || req.user?.id || req.user?._id || "user_101";
    const userDir = path.join(__dirname, `../uploads/${userId}`);

    if (!fs.existsSync(userDir)) {
      return res.status(200).json({ success: true, files: [] });
    }

    fs.readdir(userDir, (err, files) => {
      if (err) {
        return res.status(500).json({ success: false, error: "Unable to scan directory" });
      }

      // Filter out hidden/system files
      const validFiles = files.filter((file) => !file.startsWith("."));

      const fileUrls = validFiles.map(
        (file) => `http://localhost:5000/uploads/${userId}/${file}`
      );

      res.status(200).json({ success: true, files: fileUrls });
    });
  } catch (error) {
    console.error("Gallery Fetch Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;