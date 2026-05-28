import jwt from 'jsonwebtoken';
import { AUTH_COOKIE_NAME } from '../config/auth.js';

const parseCookies = (cookieHeader = '') => {
  return cookieHeader
    .split(';')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .reduce((accumulator, cookiePair) => {
      const separatorIndex = cookiePair.indexOf('=');

      if (separatorIndex === -1) {
        return accumulator;
      }

      const key = decodeURIComponent(cookiePair.slice(0, separatorIndex).trim());
      const value = decodeURIComponent(cookiePair.slice(separatorIndex + 1).trim());
      accumulator[key] = value;
      return accumulator;
    }, {});
};

const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const [scheme, token] = authHeader.split(' ');
    const cookies = parseCookies(req.headers.cookie || '');
    const cookieToken = cookies[AUTH_COOKIE_NAME];
    const resolvedToken = scheme === 'Bearer' && token ? token : cookieToken;

    if (!resolvedToken) {
      return res.status(401).json({
        success: false,
        error: 'Authentication is required',
      });
    }

    const secret = process.env.JWT_SECRET?.trim();

    if (!secret) {
      throw new Error('JWT_SECRET is required');
    }

    req.user = jwt.verify(resolvedToken, secret);
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: error.message === 'JWT_SECRET is required' ? error.message : 'Invalid or expired token',
    });
  }
};

export default authMiddleware;
