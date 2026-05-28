import { WebSocket, WebSocketServer } from 'ws';

let powerSocketServer = null;

const readAllowedOrigins = () => {
  const rawOrigins = process.env.CLIENT_ORIGIN?.trim();

  if (!rawOrigins) {
    return null;
  }

  return rawOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
};

const isOriginAllowed = (origin) => {
  const allowedOrigins = readAllowedOrigins();

  if (!allowedOrigins || !origin) {
    return true;
  }

  return allowedOrigins.includes(origin);
};

const serializePowerReport = (report) => ({
  _id: String(report._id),
  locationId: report.locationId,
  powerStatus: Boolean(report.powerStatus),
  reportedAt:
    report.reportedAt instanceof Date ? report.reportedAt.toISOString() : String(report.reportedAt),
  reportedBy: typeof report.reportedBy === 'string' ? report.reportedBy : null,
});

export const initializePowerSocket = () => {
  powerSocketServer = new WebSocketServer({ noServer: true });

  powerSocketServer.on('connection', (socket) => {
    socket.send(
      JSON.stringify({
        type: 'power:ready',
        data: {
          connectedAt: new Date().toISOString(),
        },
      })
    );
  });

  return powerSocketServer;
};

export const handlePowerUpgrade = (request, socket, head) => {
  if (!powerSocketServer) return;
  
  const origin = request.headers.origin;
  if (!isOriginAllowed(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  powerSocketServer.handleUpgrade(request, socket, head, (ws) => {
    powerSocketServer.emit('connection', ws, request);
  });
};

export const broadcastPowerReport = (report) => {
  if (!powerSocketServer) {
    return;
  }

  const payload = JSON.stringify({
    type: 'power:update',
    data: serializePowerReport(report),
  });

  powerSocketServer.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
};
