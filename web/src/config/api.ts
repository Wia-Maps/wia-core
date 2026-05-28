const DEFAULT_PRODUCTION_API_BASE_URL = 'https://wia-core-op3x.onrender.com/api/v1';
const DEFAULT_API_BASE_URL = (import.meta as { env?: { PROD?: boolean } }).env?.PROD
  ? DEFAULT_PRODUCTION_API_BASE_URL
  : '/api/v1';

  
const getFrontendEnv = (): Record<string, string | undefined> => {
  return ((import.meta as { env?: Record<string, string | undefined> }).env ?? {});
};

const toAbsoluteUrl = (value: string): string => {
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  return new URL(value, origin).toString();
};

export const resolveApiBaseUrl = (): string => {
  const configuredUrl = getFrontendEnv().VITE_API_BASE_URL?.trim();
  return configuredUrl || DEFAULT_API_BASE_URL;
};

export const resolveSocketBaseUrl = (): string => {
  const configuredUrl = getFrontendEnv().VITE_SOCKET_BASE_URL?.trim();
  return configuredUrl || resolveApiBaseUrl();
};

export const toAbsoluteApiBaseUrl = (): string => {
  return toAbsoluteUrl(resolveApiBaseUrl());
};

export const toApiUrl = (path: string): string => {
  const baseUrl = toAbsoluteApiBaseUrl();
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  return new URL(path.replace(/^\/+/, ''), normalizedBaseUrl).toString();
};

export const resolveSocketUrl = (pathname: string): string => {
  const socketUrl = new URL(toAbsoluteSocketBaseUrl());

  if (socketUrl.protocol === 'https:') {
    socketUrl.protocol = 'wss:';
  } else if (socketUrl.protocol === 'http:') {
    socketUrl.protocol = 'ws:';
  }

  socketUrl.pathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
  socketUrl.search = '';
  socketUrl.hash = '';

  return socketUrl.toString();
};

export const toAbsoluteSocketBaseUrl = (): string => {
  return toAbsoluteUrl(resolveSocketBaseUrl());
};
