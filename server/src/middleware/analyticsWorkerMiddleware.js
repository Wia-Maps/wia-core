import { timingSafeEqual } from 'node:crypto';

const toTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const tokensMatch = (left, right) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
};

const analyticsWorkerMiddleware = (req, res, next) => {
  const configuredToken = toTrimmedString(process.env.ANALYTICS_WORKER_TOKEN);

  if (!configuredToken) {
    return res.status(503).json({
      success: false,
      error: 'ANALYTICS_WORKER_TOKEN is not configured.',
    });
  }

  const authHeader = toTrimmedString(req.headers.authorization);
  const [scheme, bearerToken] = authHeader.split(' ');
  const headerToken = toTrimmedString(req.headers['x-analytics-worker-token']);
  const providedToken =
    scheme === 'Bearer' && bearerToken ? toTrimmedString(bearerToken) : headerToken;

  if (!providedToken || !tokensMatch(providedToken, configuredToken)) {
    return res.status(401).json({
      success: false,
      error: 'Analytics worker authentication is required.',
    });
  }

  const workerId =
    toTrimmedString(req.headers['x-analytics-worker-id']) ||
    toTrimmedString(req.query.workerId) ||
    'default';

  req.analyticsWorker = {
    id: workerId,
  };

  return next();
};

export default analyticsWorkerMiddleware;
