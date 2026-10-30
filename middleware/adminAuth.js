const jwt = require("jsonwebtoken");
const User = require("../models/User");

const DEVELOPER_OWNER_EMAIL = "javedusama786.co@gmail.com"; // Yahan apni email likhein

module.exports = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ success: false, message: "Unauthorized" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user || user.role !== "admin" || user.email !== DEVELOPER_OWNER_EMAIL) {
      return res.status(403).json({ success: false, message: "Access Denied: Owner only" });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
};