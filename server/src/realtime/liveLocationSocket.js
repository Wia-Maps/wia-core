import { WebSocket, WebSocketServer } from 'ws';
import SosHistory from '../models/SosHistory.js';
import {
  getLiveSession,
  removeLiveSession,
  verifyLiveSocketToken,
} from '../services/liveShareService.js';

let locationSocketServer = null;

const readAllowedOrigins = () => {
  const rawOrigins = process.env.CLIENT_ORIGIN?.trim();
  if (!rawOrigins) return null;
  return rawOrigins.split(',').map((origin) => origin.trim()).filter(Boolean);
};

const isOriginAllowed = (origin) => {
  const allowedOrigins = readAllowedOrigins();
  if (!allowedOrigins || !origin) return true;
  return allowedOrigins.includes(origin);
};

export const initializeLiveLocationSocket = () => {
  locationSocketServer = new WebSocketServer({ noServer: true });

  locationSocketServer.on('connection', (socket) => {
    let currentSessionId = null;
    let currentRole = null;

    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data);

        switch (message.type) {
          case 'join': {
            try {
              const role = typeof message.role === 'string' ? message.role.trim() : '';
              const token = typeof message.token === 'string' ? message.token.trim() : '';
              const expectedType = role === 'broadcaster' ? 'live-broadcaster' : role === 'viewer' ? 'live-viewer' : '';

              if (!expectedType) {
                socket.send(JSON.stringify({ type: 'join_rejected', reason: 'Invalid role.' }));
                socket.close();
                break;
              }

              const payload = verifyLiveSocketToken(token, expectedType);
              currentSessionId = payload.sessionId;
              currentRole = role;
              const session = getLiveSession(payload.sessionId);

              if (!session) {
                socket.send(JSON.stringify({ type: 'join_rejected', reason: 'This live session is no longer active.' }));
                socket.close();
                break;
              }

              if (role === 'broadcaster') {
                session.broadcaster = socket;
                socket.send(JSON.stringify({
                  type: 'joined',
                  role,
                  sessionId: payload.sessionId,
                  viewerCount: session.viewers.size,
                }));
              } else {
                session.viewers.add(socket);
                socket.send(JSON.stringify({
                  type: 'joined',
                  role,
                  sessionId: payload.sessionId,
                  coordinates: session.lastLocation
                    ? [session.lastLocation.lat, session.lastLocation.lng]
                    : session.initialCoordinates,
                  sos: session.sos,
                }));
                
                // Notify broadcaster of new viewer count
                if (session.broadcaster && session.broadcaster.readyState === WebSocket.OPEN) {
                  session.broadcaster.send(JSON.stringify({
                    type: 'viewer_count_update',
                    count: session.viewers.size
                  }));
                }

                // Fetch and send history for breadcrumb trail
                SosHistory.find({ sessionId: payload.sessionId }).sort({ timestamp: 1 }).then(history => {
                  if (history.length > 0) {
                    socket.send(JSON.stringify({
                      type: 'location_history',
                      data: history.map(h => ({
                        lat: h.location.coordinates[1],
                        lng: h.location.coordinates[0],
                        timestamp: h.timestamp
                      }))
                    }));
                  }
                }).catch(err => console.error('History fetch error:', err));
              }
            } catch (error) {
              socket.send(JSON.stringify({
                type: 'join_rejected',
                reason: error.message || 'Unable to verify this live session.',
              }));
              socket.close();
            }
            break;
          }

          case 'location_update': {
            if (currentRole === 'broadcaster' && currentSessionId) {
              const session = getLiveSession(currentSessionId);
              if (session) {
                const locationData = {
                  lat: message.lat,
                  lng: message.lng,
                  sessionId: currentSessionId
                };
                
                session.lastLocation = locationData;

                // Persist to database
                new SosHistory({
                  sessionId: currentSessionId,
                  location: {
                    type: 'Point',
                    coordinates: [message.lng, message.lat]
                  },
                  accuracy: message.accuracy
                }).save().catch(err => console.error('SOS Log Error:', err));

                const payload = JSON.stringify({
                  type: 'location_update',
                  data: locationData
                });

                session.viewers.forEach((viewer) => {
                  if (viewer.readyState === WebSocket.OPEN) {
                    viewer.send(payload);
                  }
                });
              }
            }
            break;
          }

          case 'end_session': {
            if (currentRole === 'broadcaster' && currentSessionId) {
              const session = getLiveSession(currentSessionId);
              if (session) {
                const endPayload = JSON.stringify({ type: 'session_ended', reason: 'manual' });
                session.viewers.forEach(v => v.send(endPayload));
                removeLiveSession(currentSessionId);
              }
            }
            break;
          }
        }
      } catch (error) {
        console.error('WS Location Error:', error);
      }
    });

    socket.on('close', () => {
      if (currentSessionId) {
        const session = getLiveSession(currentSessionId);
        if (!session) {
          return;
        }
        if (currentRole === 'broadcaster') {
          session.broadcaster = null;
          // Notify viewers that broadcaster is offline, but session remains for persistence
          const offlinePayload = JSON.stringify({ type: 'broadcaster_offline' });
          session.viewers.forEach(v => v.send(offlinePayload));
        } else {
          session.viewers.delete(socket);
          // Notify broadcaster of updated viewer count
          if (session.broadcaster && session.broadcaster.readyState === WebSocket.OPEN) {
            session.broadcaster.send(JSON.stringify({
              type: 'viewer_count_update',
              count: session.viewers.size
            }));
          }
        }

        // Cleanup only if session is empty AND timer expired (handled by setTimeout)
        // or if we want to cleanup immediately when everyone leaves:
        if (!session.broadcaster && session.viewers.size === 0) {
          removeLiveSession(currentSessionId);
        }
      }
    });
  });

  return locationSocketServer;
};

export const handleLiveLocationUpgrade = (request, socket, head) => {
  if (!locationSocketServer) return;

  const origin = request.headers.origin;
  if (!isOriginAllowed(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  locationSocketServer.handleUpgrade(request, socket, head, (ws) => {
    locationSocketServer.emit('connection', ws, request);
  });
};
