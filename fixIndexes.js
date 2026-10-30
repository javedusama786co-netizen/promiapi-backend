// fixIndexes.js
require("dotenv").config();
const mongoose = require("mongoose");

async function dropOldIndex() {
  try {
    await mongoose.connect(process.env.MONGO_URI || process.env.DATABASE_URL);
    console.log("Connected to MongoDB...");

    const collection = mongoose.connection.collection("whatsappconfigs");
    
    // Drop old unique userId index
    await collection.dropIndex("userId_1");
    console.log("✅ Old userId_1 index successfully dropped!");

    process.exit(0);
  } catch (error) {
    console.error("❌ Index Drop Error:", error.message);
    process.exit(1);
  }
}

dropOldIndex();