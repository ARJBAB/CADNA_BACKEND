import asyncHandler from "express-async-handler";
import jwt from "jsonwebtoken";
import speakeasy from "speakeasy"; // TOTP 2FA
import qrcode from "qrcode"; // for generating QR code dataURL
import User from "../models/userModel.js";
import Exam from "../models/examModel.js";
import AuthLog from "../models/authLogModel.js";
import { tokenBlacklist } from "../middleware/AuthMiddleware.js";
import { signAccessToken, signRefreshToken } from "../utils/generateToken.js"; // helper to sign tokens
import dotenv from "dotenv";

dotenv.config();

const {
  REFRESH_COOKIE_NAME = "jid",
  REFRESH_EXPIRES = "24h",
  NODE_ENV = "development",
} = process.env;

const isProd = NODE_ENV === "production";
const refreshCookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? "none" : "lax",
  maxAge: (() => {
    const r = REFRESH_EXPIRES;
    const num = parseInt(r.slice(0, -1), 10);
    const unit = r.slice(-1);
    if (unit === "d") return num * 24 * 60 * 60 * 1000;
    if (unit === "h") return num * 60 * 60 * 1000;
    if (unit === "m") return num * 60 * 1000;
    return 24 * 60 * 60 * 1000;
  })(),
  path: "/",
};

// helper decode TTL
function getTtlSecondsFromToken(token) {
  try {
    const dec = jwt.decode(token);
    if (!dec || !dec.exp) return Math.floor(refreshCookieOptions.maxAge / 1000);
    const now = Math.floor(Date.now() / 1000);
    const ttl = dec.exp - now;
    return ttl > 0 ? ttl : 0;
  } catch {
    return Math.floor(refreshCookieOptions.maxAge / 1000);
  }
}

/* ---------- AUTH endpoints ---------- */

/**
 * POST /api/auth/register
 * Registers user and returns access + refresh tokens.
 */
export const register = asyncHandler(async (req, res) => {
  const {
    firstName,
    lastName,
    email,
    phone,
    password,
    role = "student",
    university,
    studentId,
    organizationName,
  } = req.body;

  const missing = [];
  if (!firstName) missing.push("firstName");
  if (!lastName) missing.push("lastName");
  if (!email) missing.push("email");
  if (!phone) missing.push("phone");
  if (!password) missing.push("password");

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Missing required fields: ${missing.join(", ")}`,
      data: null,
    });
  }

  const existing = await User.findOne({ email });
  if (existing)
    return res
      .status(409)
      .json({ success: false, message: "Email already in use", data: null });

  const user = await User.create({
    firstName,
    lastName,
    email,
    phone,
    password,
    role,
    university,
    studentId,
    organizationName: role === "instructor" ? organizationName : undefined,
  });

  const accessToken = signAccessToken(user._id.toString(), user.role);
  const refreshToken = signRefreshToken(user._id.toString());
  user.refreshToken = refreshToken;
  await user.save();

  // Auto-enroll new students in all active exams
  if (user.role === "student") {
    await Exam.updateMany(
      { isActive: true },
      { $addToSet: { enrolledStudents: user._id } }
    );
  }

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);

  const safeUser = {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    university: user.university,
    studentId: user.studentId,
    organizationName: user.organizationName,
  };
  return res.status(201).json({
    success: true,
    message: "Registered",
    data: { user: safeUser, accessToken },
  });
});

/**
 * POST /api/auth/login
 * If 2FA enabled => return { twoFARequired: true, tempToken }.
 * Else => return access+refresh as usual.
 */
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({
      success: false,
      message: "Provide email and password",
      data: null,
    });

  const user = await User.findOne({ email });
  if (!user)
    return res
      .status(401)
      .json({ success: false, message: "Invalid credentials", data: null });

  const valid = await user.comparePassword(password);
  if (!valid)
    return res
      .status(401)
      .json({ success: false, message: "Invalid credentials", data: null });

  // If 2FA enabled -> issue short-lived "2fa" temp token and instruct client to ask for TOTP code
  if (user.twoFAEnabled) {
    // temp token type '2fa' valid for short time (5 minutes)
    const temp2faToken = jwt.sign(
      { sub: user._id.toString(), type: "2fa" },
      process.env.JWT_SECRET,
      { expiresIn: "5m" }
    );
    return res.status(200).json({
      success: true,
      message: "2FA required",
      data: { twoFARequired: true, tempToken: temp2faToken },
    });
  }

  // No 2FA: issue normal tokens
  const accessToken = signAccessToken(user._id.toString(), user.role);
  const refreshToken = signRefreshToken(user._id.toString());
  user.refreshToken = refreshToken;
  await user.save();
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);

  // Log successful login
  await AuthLog.create({
    userId: user._id,
    action: "login",
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  const safeUser = {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    university: user.university,
    studentId: user.studentId,
    organizationName: user.organizationName,
  };
  return res.json({
    success: true,
    message: "Logged in",
    data: { user: safeUser, accessToken },
  });
});

/**
 * POST /api/auth/verify-2fa-login
 * Body: { tempToken, code }
 * Verifies the short-lived temp token then validates the TOTP code and issues real access+refresh tokens.
 */
export const verify2faLogin = asyncHandler(async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code)
    return res.status(400).json({
      success: false,
      message: "Missing tempToken or code",
      data: null,
    });

  let payload;
  try {
    payload = jwt.verify(tempToken, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired temp token",
      data: null,
    });
  }
  if (payload.type !== "2fa")
    return res
      .status(401)
      .json({ success: false, message: "Invalid temp token type", data: null });

  const user = await User.findById(payload.sub);
  if (!user)
    return res
      .status(401)
      .json({ success: false, message: "User not found", data: null });
  if (!user.twoFAEnabled || !user.twoFASecret)
    return res.status(400).json({
      success: false,
      message: "2FA not enabled for user",
      data: null,
    });

  const verified = speakeasy.totp.verify({
    secret: user.twoFASecret,
    encoding: "base32",
    token: code,
    window: 1, // allow 1 step clock-drift
  });

  if (!verified)
    return res
      .status(401)
      .json({ success: false, message: "Invalid 2FA code", data: null });

  // success: issue normal tokens
  const accessToken = signAccessToken(user._id.toString(), user.role);
  const refreshToken = signRefreshToken(user._id.toString());
  user.refreshToken = refreshToken;
  await user.save();
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);

  const safeUser = {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    university: user.university,
    studentId: user.studentId,
    organizationName: user.organizationName,
  };
  return res.json({
    success: true,
    message: "2FA verified, logged in",
    data: { user: safeUser, accessToken },
  });
});

/**
 * POST /api/auth/setup-2fa
 * Protected route. Generates a temp TOTP secret and returns otpauth_url (and optional qr).
 * Frontend should show QR for user to scan. Saves temp secret to user.twoFATempSecret.
 */
export const setup2fa = asyncHandler(async (req, res) => {
  // req.user expected from protect middleware
  const user = await User.findById(req.user._id);
  if (!user)
    return res
      .status(404)
      .json({ success: false, message: "User not found", data: null });

  // generate secret (base32)
  const secret = speakeasy.generateSecret({ name: `CADNA (${user.email})` });

  // save temp secret; do NOT activate until user verifies
  user.twoFATempSecret = secret.base32;
  await user.save();

  // provide otpauth_url and optionally a QR dataURL
  const otpauth_url = secret.otpauth_url;
  let qrDataURL = null;
  try {
    qrDataURL = await qrcode.toDataURL(otpauth_url);
  } catch (e) {
    // ignore; frontend can render QR from otpauth_url if desired
  }

  return res.json({
    success: true,
    message: "2FA setup initiated",
    data: { otpauth_url, qrDataURL },
  });
});

/**
 * POST /api/auth/verify-2fa-enable
 * Protected route. Body: { code }
 * Verifies user's code against twoFATempSecret; if valid, move temp -> twoFASecret and set twoFAEnabled = true
 */
export const verify2faEnable = asyncHandler(async (req, res) => {
  const { code } = req.body;
  if (!code)
    return res
      .status(400)
      .json({ success: false, message: "Missing code", data: null });

  const user = await User.findById(req.user._id);
  if (!user)
    return res
      .status(404)
      .json({ success: false, message: "User not found", data: null });
  if (!user.twoFATempSecret)
    return res
      .status(400)
      .json({ success: false, message: "No pending 2FA setup", data: null });

  const ok = speakeasy.totp.verify({
    secret: user.twoFATempSecret,
    encoding: "base32",
    token: code,
    window: 1,
  });
  if (!ok)
    return res
      .status(401)
      .json({ success: false, message: "Invalid 2FA code", data: null });

  // enable 2FA
  user.twoFASecret = user.twoFATempSecret;
  user.twoFATempSecret = null;
  user.twoFAEnabled = true;
  await user.save();

  return res.json({ success: true, message: "2FA enabled", data: null });
});

/**
 * POST /api/auth/disable-2fa
 * Protected route. Body: { password } OR require TOTP code (we'll accept password for now)
 * Verify password and then remove 2FA.
 */
export const disable2fa = asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password)
    return res.status(400).json({
      success: false,
      message: "Password required to disable 2FA",
      data: null,
    });

  const user = await User.findById(req.user._id);
  if (!user)
    return res
      .status(404)
      .json({ success: false, message: "User not found", data: null });

  const valid = await user.comparePassword(password);
  if (!valid)
    return res
      .status(401)
      .json({ success: false, message: "Invalid password", data: null });

  user.twoFAEnabled = false;
  user.twoFASecret = null;
  user.twoFATempSecret = null;
  await user.save();

  return res.json({ success: true, message: "2FA disabled", data: null });
});

/* --------- existing endpoints: refresh, logout, me (adapted) --------- */

export const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies && req.cookies[REFRESH_COOKIE_NAME];
  if (!token)
    return res
      .status(401)
      .json({ success: false, message: "No refresh token", data: null });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired refresh token",
      data: null,
    });
  }

  const userId = payload.sub || payload.id;
  if (!userId)
    return res
      .status(401)
      .json({ success: false, message: "Invalid token payload", data: null });

  const user = await User.findById(userId);
  if (!user || !user.refreshToken)
    return res
      .status(401)
      .json({ success: false, message: "No matching session", data: null });
  if (user.refreshToken !== token) {
    user.refreshToken = null;
    await user.save();
    return res
      .status(401)
      .json({ success: false, message: "Refresh token mismatch", data: null });
  }

  const newAccess = signAccessToken(user._id.toString(), user.role);
  const newRefresh = signRefreshToken(user._id.toString());
  user.refreshToken = newRefresh;
  await user.save();
  res.cookie(REFRESH_COOKIE_NAME, newRefresh, refreshCookieOptions);
  return res.json({
    success: true,
    message: "Token refreshed",
    data: { accessToken: newAccess },
  });
});

export const logout = asyncHandler(async (req, res) => {
  const cookieToken = req.cookies && req.cookies[REFRESH_COOKIE_NAME];
  if (cookieToken) {
    try {
      const dec = jwt.decode(cookieToken);
      const uid = dec && (dec.sub || dec.id);
      if (uid)
        await User.findByIdAndUpdate(uid, { $unset: { refreshToken: 1 } });
    } catch {}
  }
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions);
  const accessToken =
    req.headers.authorization && req.headers.authorization.startsWith("Bearer")
      ? req.headers.authorization.split(" ")[1]
      : null;
  if (accessToken) {
    const ttl = getTtlSecondsFromToken(accessToken);
    tokenBlacklist.set(
      accessToken,
      true,
      ttl || Math.floor(refreshCookieOptions.maxAge / 1000)
    );
  }
  return res.json({ success: true, message: "Logged out" });
});

export const me = asyncHandler(async (req, res) => {
  if (!req.user)
    return res
      .status(401)
      .json({ success: false, message: "Not authenticated", data: null });
  const safeUser = {
    id: req.user._id,
    firstName: req.user.firstName,
    lastName: req.user.lastName,
    email: req.user.email,
    phone: req.user.phone,
    role: req.user.role,
    university: req.user.university,
    studentId: req.user.studentId,
    organizationName: req.user.organizationName,
    twoFAEnabled: req.user.twoFAEnabled,
  };
  return res.json({ success: true, data: safeUser });
});
