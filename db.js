const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    await mongoose.connect(
      "mongodb://usamajaved786:usamajaved786.com@ac-bmeifj6-shard-00-00.klimewy.mongodb.net:27017,ac-bmeifj6-shard-00-01.klimewy.mongodb.net:27017,ac-bmeifj6-shard-00-02.klimewy.mongodb.net:27017/whatsapp_saas?ssl=true&replicaSet=atlas-j72fne-shard-0&authSource=admin&appName=Cluster0"
    );

    console.log("MongoDB Connected 🚀");
  } catch (error) {
    console.log("DB Error:", error.message);
    process.exit(1);
  }
};

module.exports = connectDB;