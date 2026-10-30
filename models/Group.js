const mongoose = require("mongoose");

const GroupSchema = new mongoose.Schema(
  {
    // 🌟 User ID (Jis user ne group banaya)
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    // 🌟 Admin ID (Agent/Multi-tenant scope ke liye)
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    // 🏷️ Group Name (Trimmed taake extra spaces ka issue na ho)
    name: { 
      type: String, 
      required: true,
      trim: true
    }
  },
  { 
    timestamps: true // Automated createdAt & updatedAt fields
  }
);

// 🔒 COMPOUND INDEX (Most Important Fix): 
// Yeh ensure karega ki aik user/admin account ke andar 
// same name ka group duplicate NA bane.
GroupSchema.index({ userId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Group", GroupSchema);