const Tenant = require("../models/Tenant");

const DEFAULT_BRANDING = {
  companyName: "PromiAPI",
  logoUrl: "/default-logo.png",
  primaryColor: "#2563eb",
  faviconUrl: "/favicon.ico"
};

// 1. Get Branding (Strict Isolated Query)
exports.getBrandingByDomain = async (req, res) => {
  try {
    const { domain } = req.query;
    let tenant = null;

    // 🚀 Priority 1: Agar valid req.user hai, toh strict userId par query chalao
    if (req.user && req.user.id) {
      tenant = await Tenant.findOne({ userId: req.user.id });
    }

    // 🚀 Priority 2: Public Domain Check (Sirf tab chalega jab actual custom domain ho)
    if (!tenant && domain && domain !== "localhost" && domain !== "127.0.0.1") {
      tenant = await Tenant.findOne({ customDomain: domain.toLowerCase().trim() });
    }

    // Default Fallback agar query match na ho
    if (!tenant) {
      return res.json({
        success: true,
        isCustom: false,
        branding: DEFAULT_BRANDING
      });
    }

    // Dynamic extraction: Pehle nested branding structure, phir direct fallback
    const logo = (tenant.branding && tenant.branding.logoUrl) || tenant.logoUrl || "";
    const name = tenant.companyName || tenant.vendorTitle || "";
    const color = (tenant.branding && tenant.branding.primaryColor) || tenant.primaryColor || DEFAULT_BRANDING.primaryColor;

    return res.json({
      success: true,
      isCustom: true,
      branding: {
        companyName: name,
        logoUrl: logo,
        primaryColor: color,
        faviconUrl: (tenant.branding && tenant.branding.faviconUrl) || DEFAULT_BRANDING.faviconUrl
      }
    });
  } catch (error) {
    console.error("Branding fetch error:", error);
    res.status(500).json({ success: false, message: "Server error occurred." });
  }
};

// 2. Update Tenant Branding (Dynamic Field Updates)
exports.updateBranding = async (req, res) => {
  try {
    const { companyName, customDomain, logoUrl, primaryColor } = req.body;
    const userId = req.user ? req.user.id : null;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized: User identification missing." });
    }

    // Sirf wahi fields update payload mein daalein jo req.body mein pass hue hain
    const updateFields = {};

    if (companyName !== undefined) {
      updateFields.companyName = companyName;
    }

    if (customDomain !== undefined) {
      if (!customDomain || typeof customDomain !== "string") {
        updateFields.customDomain = null;
      } else {
        const formattedDomain = customDomain.trim().toLowerCase();
        if (formattedDomain === "" || formattedDomain === "localhost" || formattedDomain === "127.0.0.1") {
          updateFields.customDomain = null;
        } else {
          updateFields.customDomain = formattedDomain;
        }
      }
    }

    if (logoUrl !== undefined) {
      updateFields.logoUrl = logoUrl;
      updateFields["branding.logoUrl"] = logoUrl;
    }

    if (primaryColor !== undefined) {
      updateFields.primaryColor = primaryColor;
      updateFields["branding.primaryColor"] = primaryColor;
    }

    // findOneAndUpdate + $set se baqi koi field overwrite nahi hogi
    const tenant = await Tenant.findOneAndUpdate(
      { userId },
      { $set: updateFields },
      { new: true, upsert: true, runValidators: true }
    );

    return res.json({
      success: true,
      message: "Aapki general settings successfully save ho gayi hain!",
      branding: {
        companyName: tenant.companyName,
        logoUrl: (tenant.branding && tenant.branding.logoUrl) || tenant.logoUrl || "",
        primaryColor: (tenant.branding && tenant.branding.primaryColor) || tenant.primaryColor || "#2563eb",
        customDomain: tenant.customDomain
      }
    });
  } catch (error) {
    console.error("Update branding error:", error);

    if (error.code === 11000 && error.keyPattern && error.keyPattern.customDomain) {
      return res.status(400).json({
        success: false,
        message: "Yeh Custom Domain pehle se kisi aur user ke account mein registered hai."
      });
    }

    return res.status(500).json({ success: false, message: "Settings save karne mein masla aya." });
  }
};