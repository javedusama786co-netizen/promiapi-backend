const mongoose = require("mongoose");

const botFlowSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      default: "user_101", // Multi-user isolation ke liye
      index: true,
    },
    name: {
      type: String,
      required: true,
      default: "Main Flow",
      trim: true,
    },
    // React Flow Nodes Data Store
    nodes: [
      {
        id: { type: String, required: true },
        type: { type: String, required: true },
        position: {
          x: { type: Number, required: true },
          y: { type: Number, required: true },
        },
        data: { type: mongoose.Schema.Types.Mixed, default: {} }, // Dynamic mediaUrl, keywords, caption flexibility
      },
    ],
    // React Flow Edges Data Store
    edges: [
      {
        id: { type: String, required: true },
        source: { type: String, required: true },
        target: { type: String, required: true },
        sourceHandle: { type: String, default: null },
        targetHandle: { type: String, default: null },
        animated: { type: Boolean, default: true },
        style: { type: mongoose.Schema.Types.Mixed, default: {} },
        markerEnd: { type: mongoose.Schema.Types.Mixed, default: {} },
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BotFlow", botFlowSchema);