import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger';

/** One log line per request. Bodies are never logged; auth headers/cookies are redacted by the logger. */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const id = (req.headers['x-request-id'] as string) || randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0], ip: req.socket?.remoteAddress }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
});
