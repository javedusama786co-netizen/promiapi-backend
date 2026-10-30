const jwt = require("jsonwebtoken");

module.exports = (req, res, next) => {
  // Check Authorization Header OR Query Parameter (for media proxy / direct tags)
  let token = null;
  const authHeader = req.header("Authorization");

  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ success: false, message: "No token, authorization denied" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "my_super_secret_key_123");
    
    // 🎯 REPAIRED USER SCOPE: Ensure adminId always exists in req.user context
    req.user = {
      id: decoded.id,
      role: decoded.role || "Admin",
      adminId: decoded.adminId || decoded.id // Fallback to id if adminId is not present
    }; 
    
    next();
  } catch (err) {
    res.status(401).json({ success: false, message: "Token is not valid" });
  }
};