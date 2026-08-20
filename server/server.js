import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/authRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import workerRoutes from './routes/workerRoutes.js';
import scheduleRoutes from './routes/scheduleRoutes.js';
import scheduleTemplateRoutes from './routes/scheduleTemplateRoutes.js';
import settingsRoutes from './routes/settingsRoutes.js';

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/myscheduler';

if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

if (!process.env.JWT_SECRET) {
  console.error('Missing JWT_SECRET. Copy server/.env.example to server/.env and set a secret.');
  process.exit(1);
}

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/workers', workerRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/schedule-templates', scheduleTemplateRoutes);
app.use('/api/settings', settingsRoutes);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, '../client/dist');
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: 'Unexpected server error.' });
});

mongoose.connect(MONGODB_URI)
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`MyScheduler server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
