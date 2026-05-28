const PROXY_PATH_PREFIXES = ['/api/', '/ws/power'];

const shouldProxyRequest = (pathname) => {
  return PROXY_PATH_PREFIXES.some((prefix) => {
    if (prefix.endsWith('/')) {
      return pathname === prefix.slice(0, -1) || pathname.startsWith(prefix);
    }

    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  });
};

const buildProxyUrl = (requestUrl, apiOrigin) => {
  const sourceUrl = new URL(requestUrl);
  const targetUrl = new URL(sourceUrl.pathname + sourceUrl.search, apiOrigin);
  return targetUrl.toString();
};

const cloneProxyHeaders = (request) => {
  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', new URL(request.url).host);
  headers.set('x-forwarded-proto', new URL(request.url).protocol.replace(':', ''));
  return headers;
};

const toProxyRequestInit = (request) => {
  const init = {
    method: request.method,
    headers: cloneProxyHeaders(request),
    redirect: 'manual',
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  return init;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!shouldProxyRequest(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    const apiOrigin = env.API_ORIGIN?.trim();

    if (!apiOrigin) {
      return new Response('Missing API_ORIGIN binding for proxy worker.', {
        status: 500,
      });
    }

    const upstreamResponse = await fetch(buildProxyUrl(request.url, apiOrigin), toProxyRequestInit(request));
    return upstreamResponse;
  },
};
