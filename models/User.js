const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    companyName: {
      type: String,
      required: function() { return this.authProvider === 'local'; },
      default: ""
    },
    firstName: {
      type: String,
      required: true,
    },
    lastName: {
      type: String,
      default: "",
    },
    username: {
      type: String,
      unique: true,
      sparse: true, // Social logins ke liye unique constraint mein conflict na ho
    },
    phone: {
      type: String,
      default: "",
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    password: {
      type: String,
      required: function() { return this.authProvider === 'local'; },
    },

    // 🌐 SOCIAL LOGIN FIELDS
    authProvider: {
      type: String,
      enum: ["local", "google", "facebook", "apple"],
      default: "local"
    },
    googleId: {
      type: String,
      default: null,
    },
    facebookId: {
      type: String,
      default: null,
    },
    appleId: {
      type: String,
      default: null,
    },

    // 🖼️ PROFILE PICTURE / AVATAR FIELDS
    avatar: {
      type: String,
      default: "",
    },
    profilePic: {
      type: String,
      default: "",
    },

    // 🔑 FORGOT PASSWORD / PASSWORD RESET FIELDS
    resetPasswordToken: {
      type: String,
      default: null,
    },
    resetPasswordExpires: {
      type: Date,
      default: null,
    },

    // ⬇️ Subscription plan fields
    plan: {
      type: String,
      default: "Free",
    },
    subscribed: {
      type: Boolean,
      default: false,
    },

    // ⚡ Detailed Subscription Object
    subscription: {
      planId: { 
        type: String, 
        default: "price_free" 
      },
      status: { 
        type: String, 
        default: "inactive" 
      },
      billingPeriod: { 
        type: String, 
        default: "monthly" 
      },
      startDate: { 
        type: Date, 
        default: null 
      },
      endDate: { 
        type: Date, 
        default: null 
      },
      isManual: { 
        type: Boolean, 
        default: false 
      },
      addons: {
        supportCustomize: { 
          type: Boolean, 
          default: false 
        },
        verifiedPortfolio: { 
          type: Boolean, 
          default: false 
        }
      }
    },

    // 👥 ONBOARDING FIELDS
    teamSize: {
      type: String,
      default: "",
    },
    onboardingCompleted: {
      type: Boolean,
      default: false,
    },

    // 🟢 ACCOUNT STATUS FOR ADMIN CONTROL
    status: {
      type: String,
      enum: ["Active", "Suspended", "Terminated"],
      default: "Active"
    },

    // 📊 USER METRICS (Track Active Time & Sent Messages)
    metrics: {
      lastActiveAt: {
        type: Date,
        default: Date.now
      },
      totalActiveTimeMinutes: {
        type: Number,
        default: 0
      },
      totalMessagesSent: {
        type: Number,
        default: 0
      }
    },

    // 🟢 ADD-ON SERVICES
    addons: {
      supportCustomize: { 
        type: Boolean, 
        default: false 
      },
      verifiedPortfolio: { 
        type: Boolean, 
        default: false 
      }
    },
    
    // 🛠️ SETTINGS CONFIGURATIONS
    settings: {
      vendorTitle: { 
        type: String, 
        default: "" 
      },
      businessType: { 
        type: String, 
        default: "" 
      },
      website: { 
        type: String, 
        default: "" 
      },
      addressLine: { 
        type: String, 
        default: "" 
      },
      postalCode: { 
        type: String, 
        default: "" 
      },
      city: { 
        type: String, 
        default: "" 
      },
      state: { 
        type: String, 
        default: "" 
      },
      country: { 
        type: String, 
        default: "" 
      },
      businessPhone: { 
        type: String, 
        default: "" 
      },
      contactEmail: { 
        type: String, 
        default: "" 
      },
      timezone: { 
        type: String, 
        default: "UTC" 
      },
      defaultLanguage: { 
        type: String, 
        default: "English (System Language)" 
      }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);