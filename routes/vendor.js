const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware"); // Aapka authentication middleware
const User = require("../models/User"); // Aapka updated User model

// 📥 1. GET ROUTE: Existing settings database se load karne ke liye
router.get("/settings", authMiddleware, async (req, res) => {
  try {
    // Req.user.id se user find kar ke sirf settings wala object select kar rahe hain
    const user = await User.findById(req.user.id).select("settings");
    
    if (!user) {
      return res.status(404).json({ success: false, message: "User workspace not found" });
    }
    
    // Agar database mein settings empty hon to frontend safe default values use kar sake
    res.json({ 
      success: true, 
      settings: user.settings || {} 
    });
  } catch (error) {
    console.error("Fetch settings error:", error);
    res.status(500).json({ success: false, message: "Database validation crash while fetching settings." });
  }
});

// 📤 2. POST ROUTE: Frontend form ka data database mein save/update karne ke liye
router.post("/settings", authMiddleware, async (req, res) => {
  try {
    const {
      vendorTitle,
      addressLine,
      postalCode,
      city,
      state,
      country,
      businessPhone,
      contactEmail,
      timezone,
      defaultLanguage
    } = req.body;

    // User document ke andar sirf settings sub-object ko atomic update ($set) kar rahe hain
    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      {
        $set: {
          settings: {
            vendorTitle,
            addressLine,
            postalCode,
            city,
            state,
            country,
            businessPhone,
            contactEmail,
            timezone,
            defaultLanguage
          }
        }
      },
      { new: true, runValidators: true } // new: true se updated data return hota hai
    );

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: "User session expired or user not found." });
    }

    res.json({ 
      success: true, 
      message: "Settings saved to database successfully!", 
      settings: updatedUser.settings 
    });
  } catch (error) {
    console.error("Save settings error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error: Configurations failed to save." });
  }
});

module.exports = router;