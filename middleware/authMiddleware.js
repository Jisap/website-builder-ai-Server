import jwt from "jsonwebtoken"

export function authMiddleware(req, res, next) {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ error: "Acces denied. No session token provided." })
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret");
    req.user = decoded;
    next();
  } catch (error) {
    console.error("Invalid token:", error);
    return res.status(401).json({ error: "Invalid or expired session token" })
  }
}