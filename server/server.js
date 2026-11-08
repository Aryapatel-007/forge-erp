import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { env, isProd, isTest, trustProxy } from './config/env.js';
import { apiLimiter, errorHandler } from './middleware/index.js';
import { apiRouter } from './routes/index.js';
import { ensureDefaults } from './services/settingsService.js';
import './models/index.js';
import './doctypes/index.js';
import { startScheduler } from './engine/scheduler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: isTest ? 'silent' : 'info' });

export function createApp({ clientDist = path.join(here, '../client/dist'), serveClient = isProd } = {}) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(compression());
  app.use(pinoHttp({ logger, redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], autoLogging: !isTest }));
  // Only a CSV import may send a large body.
  // A payment webhook is checked against its exact bytes, so those are kept.
  const keepRaw = (req, _res, buffer) => { if (req.originalUrl.includes('/public/webhooks/')) req.rawBody = buffer; };
  const smallJson = express.json({ limit: '1mb', verify: keepRaw });
  const largeJson = express.json({ limit: '10mb' });
  app.use((req, res, next) => (/\/(import|a\/load)$/.test(req.path) ? largeJson(req, res, next) : smallJson(req, res, next)));
  app.use(cookieParser());
  app.use('/api/v1', apiLimiter, apiRouter());

  if (serveClient) {
    app.use('/assets', express.static(path.join(clientDist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(clientDist, { index: false, maxAge: 0 }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}

async function main() {
  mongoose.set('strictQuery', 'throw');
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 10000, autoIndex: true });
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  await ensureDefaults();
  const app = createApp();
  const server = app.listen(env.PORT, env.HOST, () => logger.info(`Forge is listening on port ${env.PORT}`));
  if (process.env.SCHEDULER !== 'off') startScheduler(logger);
  const stop = async () => {
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    logger.error(error);
    process.exit(1);
  });
}
