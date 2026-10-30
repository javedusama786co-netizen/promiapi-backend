const mongoose = require("mongoose");

const TenantSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true
    },
    companyName: { 
      type: String, 
      default: "" 
    },
    customDomain: { 
      type: String, 
      default: null, 
      unique: true, 
      sparse: true, // 🚀 Multi-tenancy ke liye zaroori hai (Allows multiple null values)
      set: (val) => (val === "" || !val ? null : val.toLowerCase().trim()) // Empty string ko null bana dega
    },
    logoUrl: { 
      type: String, 
      default: "" 
    },
    primaryColor: { 
      type: String, 
      default: "#2563eb" 
    },
    branding: {
      logoUrl: { type: String, default: "" },
      primaryColor: { type: String, default: "#2563eb" },
      faviconUrl: { type: String, default: "/favicon.ico" }
    },
    vendorId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Vendor" 
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Tenant", TenantSchema);