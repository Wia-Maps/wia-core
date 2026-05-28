import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1']);
import 'dotenv/config';
import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import mongoose from 'mongoose';
import connectDB from './src/config/db.js';
import adminActivityRoutes from './src/routes/adminActivityRoutes.js';
import adminLocationRoutes from './src/routes/adminLocationRoutes.js';
import adminPowerRoutes from './src/routes/adminPowerRoutes.js';
import adminRouteRoutes from './src/routes/adminRouteRoutes.js';
import analyticsWorkerRoutes from './src/routes/analyticsWorkerRoutes.js';
import authRoutes from './src/routes/authRoutes.js';
import locationRoutes from './src/routes/locationRoutes.js';
import { adminMapRouter, publicMapRouter } from './src/routes/mapRoutes.js';
import notificationRoutes from './src/routes/notificationRoutes.js';
import powerRoutes from './src/routes/powerRoutes.js';
import telemetryRoutes from './src/routes/telemetryRoutes.js';
import { ensureAllMapDatasetsSeeded } from './src/services/mapDatasetService.js';
import { startNotificationQueueWorker } from './src/services/notificationQueue.js';
import { startPowerScheduleWorker } from './src/services/powerSchedulingService.js';
import { initializePowerSocket, handlePowerUpgrade } from './src/realtime/powerSocket.js';
import { initializeLiveLocationSocket, handleLiveLocationUpgrade } from './src/realtime/liveLocationSocket.js';

const app = express();
const server = createServer(app);
const PORT = Number(process.env.PORT) || 5000;
const SERVER_START_TIME = Date.now();

app.set('trust proxy', 1);

const resolveCorsOrigins = () => {
  const rawOrigins = process.env.CLIENT_ORIGIN?.trim();

  if (!rawOrigins) {
    return true;
  }

  return rawOrigins.split(',').map((origin) => origin.trim()).filter(Boolean);
};

app.use(
  cors({
    origin: resolveCorsOrigins(),
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));

const getConnectionStatusLabel = (readyState) => {
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };
  return states[readyState] || 'unknown';
};

app.get('/api/v1/health', (_req, res) => {
  const uptime = Date.now() - SERVER_START_TIME;
  const mongoConnection = mongoose.connection;
  
  res.status(200).json({
    success: true,
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: {
        ms: uptime,
        seconds: Math.floor(uptime / 1000),
        minutes: Math.floor(uptime / 60000),
        hours: Math.floor(uptime / 3600000),
      },
      server: {
        version: process.env.npm_package_version || '1.0.0',
        node: process.version,
        environment: process.env.NODE_ENV || 'development',
      },
      database: {
        status: getConnectionStatusLabel(mongoConnection.readyState),
        connected: mongoConnection.readyState === 1
      },
    },
  });
});

app.use('/api/v1/admin', authRoutes);
app.use('/api/v1/admin/locations', adminLocationRoutes);
app.use('/api/v1/admin/power', adminPowerRoutes);
app.use('/api/v1/admin/activity', adminActivityRoutes);
app.use('/api/v1/admin/map', adminMapRouter);
app.use('/api/v1/admin/routes', adminRouteRoutes);
app.use('/api/v1/analytics/worker', analyticsWorkerRoutes);
app.use('/api/v1/map', publicMapRouter);
app.use('/api/v1/locations', locationRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/power', powerRoutes);
app.use('/api/v1/telemetry', telemetryRoutes);

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
  });
});

const startServer = async () => {
  await connectDB();
  await ensureAllMapDatasetsSeeded();
  initializePowerSocket();
  initializeLiveLocationSocket();
  startNotificationQueueWorker();
  startPowerScheduleWorker();

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);

    if (pathname === '/ws/power') {
      handlePowerUpgrade(request, socket, head);
    } else if (pathname === '/ws/live-location') {
      handleLiveLocationUpgrade(request, socket, head);
    } else {
      socket.destroy();
    }
  });

  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
};

startServer().catch((error) => {
  console.error('Failed to start server:', error.message);
  process.exit(1);
});
