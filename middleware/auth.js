const jwt = require("jsonwebtoken");

module.exports = (req, res, next) => {
  // Request header se token nikalen
  const authHeader = req.header("Authorization");
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No token, authorization denied" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // 🚨 'YOUR_JWT_SECRET' ki jagah apni asli secret key daalein jo aapne login me use ki hai
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "YOUR_JWT_SECRET");
    
    // User data request object me attach karein
    req.user = decoded; 
    next();
  } catch (err) {
    res.status(401).json({ success: false, message: "Token is not valid" });
  }
};