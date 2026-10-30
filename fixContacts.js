const mongoose = require("mongoose");
const Contact = require("./models/Contact");

const mongoURI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  "mongodb://usamajaved786:usamajaved786.com@ac-bmeifj6-shard-00-00.klimewy.mongodb.net:27017,ac-bmeifj6-shard-00-01.klimewy.mongodb.net:27017,ac-bmeifj6-shard-00-02.klimewy.mongodb.net:27017/whatsapp_saas?ssl=true&replicaSet=atlas-j72fne-shard-0&authSource=admin&appName=Cluster0";

function asString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function digitsOnly(value) {
  return asString(value).replace(/\D/g, "");
}

mongoose
  .connect(mongoURI)
  .then(async () => {
    console.log("⚡ MongoDB connected...");

    const contacts = await Contact.find({}).lean();
    let updatedCount = 0;
    let skipped = 0;
    let failed = 0;

    for (const c of contacts) {
      try {
        const platform = asString(c.platform || "whatsapp").toLowerCase();
        const setFields = {};

        if (c.phone !== undefined && c.phone !== null && typeof c.phone !== "string") {
          setFields.phone = String(c.phone);
        }
        if (c.phoneNumber !== undefined && c.phoneNumber !== null && typeof c.phoneNumber !== "string") {
          setFields.phoneNumber = String(c.phoneNumber);
        }
        if (c.recipientId !== undefined && c.recipientId !== null && typeof c.recipientId !== "string") {
          setFields.recipientId = String(c.recipientId);
        }

        if (!c.platform) {
          setFields.platform = ["instagram", "messenger"].includes(platform)
            ? platform
            : "whatsapp";
        }

        const currentPlatform = setFields.platform || platform;
        const phoneDigits = digitsOnly(setFields.phone || c.phone || c.phoneNumber || "");
        const currentRecipient = asString(setFields.recipientId || c.recipientId);

        if (currentPlatform === "whatsapp") {
          if (phoneDigits.length >= 8) {
            if (!asString(setFields.phone || c.phone)) setFields.phone = phoneDigits;
            if (!currentRecipient) setFields.recipientId = phoneDigits;
          } else if (!currentRecipient) {
            skipped++;
            console.log("⚠️ SKIP (no WhatsApp phone):", String(c._id), c.name);
            continue;
          }
        }

        if (currentPlatform === "instagram") {
          const ig = asString(c.instagramId || c.recipientId || c.phone);
          if (ig) {
            if (!asString(c.instagramId)) setFields.instagramId = ig;
            if (!currentRecipient) setFields.recipientId = ig;
          } else {
            skipped++;
            console.log("⚠️ SKIP (no Instagram ID):", String(c._id), c.name);
            continue;
          }
        }

        if (currentPlatform === "messenger") {
          const fb = asString(c.facebookId || c.recipientId || c.phone);
          if (fb) {
            if (!asString(c.facebookId)) setFields.facebookId = fb;
            if (!currentRecipient) setFields.recipientId = fb;
          } else {
            skipped++;
            console.log("⚠️ SKIP (no Messenger ID):", String(c._id), c.name);
            continue;
          }
        }

        if (Object.keys(setFields).length === 0) continue;

        await Contact.updateOne(
          { _id: c._id },
          { $set: setFields },
          { runValidators: false }
        );

        updatedCount++;
        console.log(
          "✅ Fixed:",
          c.name,
          "| phone:",
          setFields.phone || c.phone,
          "| recipientId:",
          setFields.recipientId || c.recipientId
        );
      } catch (err) {
        failed++;
        console.error("❌ Failed:", String(c._id), c.name, err.message);
      }
    }

    console.log("---------------------------------");
    console.log("✅ Updated:", updatedCount);
    console.log("⚠️ Skipped:", skipped);
    console.log("❌ Failed:", failed);
    console.log("📦 Total scanned:", contacts.length);

    await mongoose.disconnect();
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Connection error:", err.message);
    process.exit(1);
  });