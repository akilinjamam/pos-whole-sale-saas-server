import { randomUUID } from 'node:crypto';

import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import type { StdSerializedResults } from 'pino-http';

import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { authenticateUnlessPublic } from './middleware/authenticate.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requireFeature } from './middleware/requireFeature.js';
import { allRoutes, publicPaths } from './routes/index.js';
import rootRouter from './routes/root.js';

export function createApp(): Express {
  const app = express();

  // Behind nginx in production, so req.ip and rate limiting see the real client address.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string) || randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Health polls every few seconds from the client Home page; do not flood the log.
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false },

      /**
       * Log every request, but only the part anyone reads.
       *
       * pino-http's defaults serialise the whole header block, which for a browser hit means
       * ~40 lines: Chrome's `sec-ch-ua` / `sec-fetch-*` / `accept-language`, every header helmet
       * sets (CSP, HSTS, `x-frame-options`, …), `etag`, `vary`. One page refresh buries whatever
       * you were actually looking at. Method, url, status and timing answer the question; the
       * headers almost never do.
       *
       * `wrapSerializers` defaults to true in pino-http, so these receive the **already
       * serialised** request and response — hence `r.remoteAddress`, not `r.socket.remoteAddress`.
       *
       * The `err` serializer is deliberately left at its default: it is what makes a 500
       * debuggable, and nothing here should touch it.
       */
      serializers: {
        req: (r: StdSerializedResults['req']) => ({
          // Keep `id`. errorHandler puts this same value into the failure envelope as
          // `requestId`, and that correlation is the only way to tie an error a user reports
          // back to its line in the log.
          id: r.id,
          method: r.method,
          url: r.url,
          remoteAddress: r.remoteAddress,
          // Opt back in with LOG_HTTP_HEADERS=true when debugging CORS or an auth failure.
          // The logger's `redact` paths cover authorization and cookie on this route again
          // the moment the headers reappear.
          ...(config.logHttpHeaders ? { headers: r.headers } : {}),
        }),
        res: (r: StdSerializedResults['res']) => ({
          statusCode: r.statusCode,
          ...(config.logHttpHeaders ? { headers: r.headers } : {}),
        }),
      },
    }),
  );

  app.use(helmet());
  app.use(
    cors({
      origin: config.http.corsOrigins,
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.use(
    '/api/v1',
    rateLimit({
      windowMs: config.http.rateLimitWindowMs,
      max: config.http.rateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path.startsWith('/health'),
    }),
  );

  // The service banner, before the auth guard so the base URL answers without a token. The
  // router defines only `/`, so `/api/v1/users` does not match it and falls straight through
  // to the guard below — mounting it here widens nothing.
  app.use('/', rootRouter);
  app.use('/api/v1', rootRouter);

  // Defence in depth. Every route also declares `authenticate` itself — and Day 3's coverage
  // test fails the build if one does not — but this blanket guard means that in the window
  // between writing a route and running that test, an unguarded endpoint is still not
  // anonymous. `publicPaths` is the explicit, deliberately tiny exemption list.
  app.use('/api/v1', authenticateUnlessPublic(publicPaths));

  for (const { path, route, feature } of allRoutes) {
    if (feature) app.use(`/api/v1/${path}`, requireFeature(feature), route);
    else app.use(`/api/v1/${path}`, route);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
