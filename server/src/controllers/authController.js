import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Admin from '../models/Admin.js';
import { AUTH_COOKIE_NAME, resolveAuthCookieOptions } from '../config/auth.js';

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const createToken = (admin) => {
  const secret = process.env.JWT_SECRET?.trim();

  if (!secret) {
    throw new Error('JWT_SECRET is required');
  }

  return jwt.sign(
    {
      adminId: admin._id,
      email: admin.email,
    },
    secret,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    }
  );
};

const formatAdminResponse = (admin) => ({
  id: admin._id,
  email: admin.email,
  createdAt: admin.createdAt,
});

const setAuthCookie = (res, token) => {
  res.cookie(AUTH_COOKIE_NAME, token, resolveAuthCookieOptions());
};

const clearAuthCookie = (res) => {
  const { maxAge, ...cookieOptions } = resolveAuthCookieOptions();
  void maxAge;

  res.clearCookie(AUTH_COOKIE_NAME, {
    ...cookieOptions,
  });
};

export const registerAdmin = async (req, res) => {
  try {
    const email = toTrimmedString(req.body.email).toLowerCase();
    const password = toTrimmedString(req.body.password);

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required',
      });
    }

    const existingAdmin = await Admin.findOne({ email });

    if (existingAdmin) {
      return res.status(409).json({
        success: false,
        error: 'Admin already exists',
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const admin = await Admin.create({
      email,
      password: hashedPassword,
    });

    const token = createToken(admin);
    setAuthCookie(res, token);

    return res.status(201).json({
      success: true,
      data: {
        token,
        admin: formatAdminResponse(admin),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Unable to register admin',
    });
  }
};

export const loginAdmin = async (req, res) => {
  try {
    const email = toTrimmedString(req.body.email).toLowerCase();
    const password = toTrimmedString(req.body.password);

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required',
      });
    }

    const admin = await Admin.findOne({ email });

    if (!admin) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      });
    }

    const passwordMatches = await bcrypt.compare(password, admin.password);

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      });
    }

    const token = createToken(admin);
    setAuthCookie(res, token);

    return res.status(200).json({
      success: true,
      data: {
        token,
        admin: formatAdminResponse(admin),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Unable to log in admin',
    });
  }
};

export const getAdminSession = async (req, res) => {
  try {
    const admin = await Admin.findById(req.user.adminId).lean();

    if (!admin) {
      clearAuthCookie(res);
      return res.status(401).json({
        success: false,
        error: 'Session is invalid',
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        admin: formatAdminResponse(admin),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Unable to validate admin session',
    });
  }
};

export const logoutAdmin = async (_req, res) => {
  clearAuthCookie(res);

  return res.status(200).json({
    success: true,
    data: {
      message: 'Logged out',
    },
  });
};
