export const AUTH_COOKIE_NAME = 'wia_admin_token';

const DEFAULT_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PRODUCTION_SAME_SITE = 'none';
const DEFAULT_DEVELOPMENT_SAME_SITE = 'lax';

const normalizeSameSite = (value) => {
  const normalizedValue = typeof value === 'string' ? value.trim().toLowerCase() : '';

  if (normalizedValue === 'strict' || normalizedValue === 'lax' || normalizedValue === 'none') {
    return normalizedValue;
  }

  return null;
};

const resolveCookieMaxAgeMs = () => {
  const rawValue = process.env.JWT_COOKIE_MAX_AGE_MS;
  const parsedValue = Number.parseInt(rawValue ?? '', 10);

  if (Number.isNaN(parsedValue) || parsedValue <= 0) {
    return DEFAULT_COOKIE_MAX_AGE_MS;
  }

  return parsedValue;
};

const resolveCookieSameSite = () => {
  const configuredValue = normalizeSameSite(process.env.JWT_COOKIE_SAME_SITE);

  if (configuredValue) {
    return configuredValue;
  }

  return process.env.NODE_ENV === 'production'
    ? DEFAULT_PRODUCTION_SAME_SITE
    : DEFAULT_DEVELOPMENT_SAME_SITE;
};

const resolveCookieSecure = () => {
  if (typeof process.env.JWT_COOKIE_SECURE === 'string') {
    return process.env.JWT_COOKIE_SECURE.trim().toLowerCase() === 'true';
  }

  return process.env.NODE_ENV === 'production';
};

const resolveCookieDomain = () => {
  const configuredDomain = process.env.JWT_COOKIE_DOMAIN?.trim();
  return configuredDomain || undefined;
};

export const resolveAuthCookieOptions = () => ({
  httpOnly: true,
  sameSite: resolveCookieSameSite(),
  secure: resolveCookieSecure(),
  domain: resolveCookieDomain(),
  maxAge: resolveCookieMaxAgeMs(),
  path: '/',
});
