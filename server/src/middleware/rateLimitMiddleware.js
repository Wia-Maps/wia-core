import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/**
 * Helper function for fallback to IP when primary identifier unavailable
 * Ensures IPv6-safe IP extraction when needed
 */
const fallbackToIp = (primaryKey, req, res) => primaryKey || ipKeyGenerator(req, res);

/**
 * CRITICAL: Login attempts - 5 requests per 15 minutes per IP
 * Prevents brute force attacks on admin credentials
 */
export const loginLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_LOGIN_WINDOW_MS || 15 * 60 * 1000), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_LOGIN_MAX || 5),
  message: 'Too many login attempts, please try again later.',
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  keyGenerator: ipKeyGenerator, // Use helper for IPv6-safe IP extraction
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many login attempts. Please try again in 15 minutes.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});

/**
 * CRITICAL: Admin account registration - 3 per hour per IP
 * Prevents account enumeration and registration abuse
 */
export const registerLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_REGISTER_WINDOW_MS || 60 * 60 * 1000), // 1 hour
  max: parseInt(process.env.RATE_LIMIT_REGISTER_MAX || 3),
  message: 'Too many accounts created from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator, // Use helper for IPv6-safe IP extraction
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many registration attempts. Please try again in 1 hour.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});

/**
 * CRITICAL: Analytics worker endpoints - 100 req/min per token
 * Protects worker infrastructure from token abuse or leaked credentials
 */
export const analyticsWorkerLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WORKER_WINDOW_MS || 60 * 1000), // 1 minute
  max: parseInt(process.env.RATE_LIMIT_WORKER_MAX || 100),
  message: 'Worker rate limit exceeded.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => fallbackToIp(req.headers['authorization']?.split(' ')[1], req, res),
  handler: (req, res) => {
    res.status(429).json({
      error: 'Worker rate limit exceeded. Please wait before retrying.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});

/**
 * HIGH: Bulk admin operations - 5 per minute per user
 * Limits destructive bulk operations (import, upsert, delete)
 */
export const bulkOperationLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_BULK_WINDOW_MS || 60 * 1000), // 1 minute
  max: parseInt(process.env.RATE_LIMIT_BULK_MAX || 5),
  message: 'Too many bulk operations. Please wait before retrying.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => fallbackToIp(req.user?.id, req, res), // User ID if authenticated, else IP
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many bulk operations. Please wait 1 minute before retrying.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});

/**
 * HIGH: Power control actions - 20 per minute per user
 * Limits destructive power operations (lock, schedule changes)
 */
export const powerControlLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_POWER_CONTROL_WINDOW_MS || 60 * 1000), // 1 minute
  max: parseInt(process.env.RATE_LIMIT_POWER_CONTROL_MAX || 20),
  message: 'Rate limit exceeded for power operations.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => fallbackToIp(req.user?.id, req, res),
  handler: (req, res) => {
    res.status(429).json({
      error: 'Power control rate limit exceeded. Please wait before retrying.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});

/**
 * HIGH: Public power reports - 10 per minute per IP
 * Limits crowd-sourced power outage reports to prevent spam
 */
export const powerReportLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_POWER_REPORT_WINDOW_MS || 60 * 1000), // 1 minute
  max: parseInt(process.env.RATE_LIMIT_POWER_REPORT_MAX || 10),
  message: 'Rate limit exceeded for power reports.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator, // Use helper for IPv6-safe IP extraction
  handler: (req, res) => {
    res.status(429).json({
      error: 'Power report rate limit exceeded. Please wait before retrying.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});

/**
 * HIGH: Map GeoJSON endpoint - 30 per minute per IP
 * Limits large payload GeoJSON requests to prevent bandwidth abuse
 */
export const mapDataLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_MAP_WINDOW_MS || 60 * 1000), // 1 minute
  max: parseInt(process.env.RATE_LIMIT_MAP_MAX || 30),
  message: 'Rate limit exceeded for map data.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator, // Use helper for IPv6-safe IP extraction
  handler: (req, res) => {
    res.status(429).json({
      error: 'Map data rate limit exceeded. Please wait before retrying.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});

/**
 * MEDIUM: General public data endpoints - 60 per minute per IP
 * Default limit for public location, power, notification data
 */
export const publicDataLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_PUBLIC_WINDOW_MS || 60 * 1000), // 1 minute
  max: parseInt(process.env.RATE_LIMIT_PUBLIC_MAX || 60),
  message: 'Rate limit exceeded.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyGenerator, // Use helper for IPv6-safe IP extraction
  handler: (req, res) => {
    res.status(429).json({
      error: 'Rate limit exceeded. Please wait before retrying.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});

/**
 * MEDIUM: Telemetry submissions - 50 per minute per device
 * Limits route telemetry submissions by device ID or IP
 */
export const telemetryLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_TELEMETRY_WINDOW_MS || 60 * 1000), // 1 minute
  max: parseInt(process.env.RATE_LIMIT_TELEMETRY_MAX || 50),
  message: 'Rate limit exceeded for telemetry.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => fallbackToIp(req.body?.deviceId, req, res),
  handler: (req, res) => {
    res.status(429).json({
      error: 'Telemetry rate limit exceeded. Please wait before retrying.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});

/**
 * MEDIUM: Admin activity queries - 30 per minute per user
 * Limits audit log queries to prevent information scraping
 */
export const adminActivityLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_ACTIVITY_WINDOW_MS || 60 * 1000), // 1 minute
  max: parseInt(process.env.RATE_LIMIT_ACTIVITY_MAX || 30),
  message: 'Rate limit exceeded for activity logs.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => fallbackToIp(req.user?.id, req, res),
  handler: (req, res) => {
    res.status(429).json({
      error: 'Activity log rate limit exceeded. Please wait before retrying.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});
