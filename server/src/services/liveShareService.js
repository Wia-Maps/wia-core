import crypto from 'node:crypto';

const LIVE_SHARE_SECRET = process.env.LIVE_SHARE_SECRET?.trim() || process.env.JWT_SECRET?.trim() || 'wia-live-share-dev-secret';
const LIVE_SHARE_AAD = 'wia-live-share';
const SESSION_TIMEOUT_MS = 60 * 60 * 1000;
const sessions = new Map();

const deriveKey = () => crypto.scryptSync(LIVE_SHARE_SECRET, LIVE_SHARE_AAD, 32);

const encodeBase64Url = (value) => Buffer.from(value).toString('base64url');
const decodeBase64Url = (value) => Buffer.from(value, 'base64url');

const sendIfOpen = (socket, payload) => {
  if (socket && socket.readyState === 1) {
    socket.send(payload);
  }
};

const createSessionTimer = (sessionId) => setTimeout(() => {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }

  const endPayload = JSON.stringify({ type: 'session_ended', reason: 'timeout' });
  sendIfOpen(session.broadcaster, endPayload);
  session.viewers.forEach((viewer) => sendIfOpen(viewer, endPayload));
  sessions.delete(sessionId);
}, SESSION_TIMEOUT_MS);

const ensureSessionRecord = (sessionId, metadata = {}) => {
  const existingSession = sessions.get(sessionId);
  if (existingSession) {
    if (metadata.initialCoordinates) {
      existingSession.initialCoordinates = metadata.initialCoordinates;
    }
    if (typeof metadata.sos === 'boolean') {
      existingSession.sos = metadata.sos;
    }
    return existingSession;
  }

  const session = {
    sessionId,
    broadcaster: null,
    viewers: new Set(),
    lastLocation: null,
    initialCoordinates: metadata.initialCoordinates ?? [0, 0],
    sos: Boolean(metadata.sos),
    timer: createSessionTimer(sessionId),
  };

  sessions.set(sessionId, session);
  return session;
};

const removeSessionRecord = (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }

  clearTimeout(session.timer);
  sessions.delete(sessionId);
};

const sealToken = (payload) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  cipher.setAAD(Buffer.from(LIVE_SHARE_AAD));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${encodeBase64Url(iv)}.${encodeBase64Url(tag)}.${encodeBase64Url(ciphertext)}`;
};

const openToken = (token) => {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error('A token is required.');
  }

  const [ivPart, tagPart, ciphertextPart] = token.split('.');
  if (!ivPart || !tagPart || !ciphertextPart) {
    throw new Error('The token format is invalid.');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), decodeBase64Url(ivPart));
  decipher.setAAD(Buffer.from(LIVE_SHARE_AAD));
  decipher.setAuthTag(decodeBase64Url(tagPart));

  const plaintext = Buffer.concat([
    decipher.update(decodeBase64Url(ciphertextPart)),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString('utf8'));
};

const validateExpiry = (payload) => {
  if (typeof payload?.exp !== 'number' || payload.exp <= Date.now()) {
    throw new Error('This live-share token has expired.');
  }
};

export const issueLiveShareSession = ({
  sessionId,
  lat,
  lng,
  sos,
  broadcasterToken,
}) => {
  const trimmedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!trimmedSessionId) {
    throw new Error('sessionId is required.');
  }

  let session = sessions.get(trimmedSessionId);
  if (session) {
    const broadcasterPayload = openToken(broadcasterToken);
    validateExpiry(broadcasterPayload);

    if (broadcasterPayload.type !== 'live-broadcaster' || broadcasterPayload.sessionId !== trimmedSessionId) {
      throw new Error('The broadcaster proof is invalid.');
    }
  }

  session = ensureSessionRecord(trimmedSessionId, {
    initialCoordinates: [lat, lng],
    sos,
  });

  const exp = Date.now() + SESSION_TIMEOUT_MS;
  const nextBroadcasterToken = broadcasterToken || sealToken({
    type: 'live-broadcaster',
    sessionId: trimmedSessionId,
    exp,
  });

  const shareToken = sealToken({
    type: 'live-share',
    sessionId: trimmedSessionId,
    lat,
    lng,
    sos: Boolean(sos),
    exp,
  });

  return {
    sessionId: trimmedSessionId,
    broadcasterToken: nextBroadcasterToken,
    shareToken,
    expiresAt: exp,
  };
};

export const resolveLiveShare = (liveToken) => {
  const payload = openToken(liveToken);
  validateExpiry(payload);

  if (payload.type !== 'live-share') {
    throw new Error('The live-share token is invalid.');
  }

  const session = sessions.get(payload.sessionId);
  if (!session) {
    throw new Error('This live session is no longer active.');
  }

  const coordinates = session.lastLocation
    ? [session.lastLocation.lat, session.lastLocation.lng]
    : session.initialCoordinates;
  const exp = Date.now() + SESSION_TIMEOUT_MS;
  const viewerToken = sealToken({
    type: 'live-viewer',
    sessionId: payload.sessionId,
    exp,
  });

  return {
    sessionId: payload.sessionId,
    coordinates,
    isSos: session.sos,
    viewerToken,
    expiresAt: exp,
  };
};

export const verifyLiveSocketToken = (token, expectedType) => {
  const payload = openToken(token);
  validateExpiry(payload);

  if (payload.type !== expectedType) {
    throw new Error('The live-share role proof is invalid.');
  }

  const session = sessions.get(payload.sessionId);
  if (!session) {
    throw new Error('This live session is no longer active.');
  }

  return payload;
};

export const getLiveSession = (sessionId) => sessions.get(sessionId) ?? null;
export const removeLiveSession = removeSessionRecord;
export const ensureLiveSession = ensureSessionRecord;
export const getLiveSessionTimeoutMs = () => SESSION_TIMEOUT_MS;
