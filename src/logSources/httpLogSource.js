import express from 'express';
import { normalizeRemoteAddress } from '../logSecurity.js';

function normalizePath(value) {
  const raw = String(value || '/cs2log').trim() || '/cs2log';
  return raw.startsWith('/') ? raw.replace(/\/+$/, '') || '/' : '/' + raw.replace(/\/+$/, '');
}

function getAllowedIps(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getHttpLogConfig(env = process.env) {
  return {
    bindHost: env.LOG_HTTP_BIND_HOST || '0.0.0.0',
    port: Number(env.LOG_HTTP_PORT || 27500),
    path: normalizePath(env.LOG_HTTP_PATH || '/cs2log'),
    secret: env.LOG_HTTP_SECRET || '',
    publicUrl: env.LOG_HTTP_PUBLIC_URL || '',
    maxBody: env.LOG_HTTP_MAX_BODY || '64kb',
    allowIps: getAllowedIps(env.LOG_HTTP_ALLOW_IPS),
  };
}

export function startHttpLogSource({ config, logHub, steamTracker } = {}) {
  const cfg = config || getHttpLogConfig();
  const app = express();
  let server = null;

  app.use(express.raw({ type: '*/*', limit: cfg.maxBody }));

  app.get('/healthz', (req, res) => {
    res.json({ ok: true });
  });

  app.all(`${cfg.path}/:secret`, (req, res) => {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    if (!cfg.secret || req.params.secret !== cfg.secret) return res.status(404).send('Not Found');

    const remoteAddress = normalizeRemoteAddress(req.ip || req.socket?.remoteAddress);
    if (cfg.allowIps.length && !cfg.allowIps.includes(remoteAddress)) {
      return res.status(403).send('Forbidden');
    }

    const raw = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : String(req.body || '');

    raw
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        steamTracker?.noteFromLogLine(line);
        logHub.push(line, { source: 'http', remoteAddress });
      });

    return res.status(204).end();
  });

  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).send('Payload Too Large');
    return next(err);
  });

  function start() {
    if (server) return server;
    server = app.listen(cfg.port, cfg.bindHost, () => {
      logHub.push(`[http log receiver listening on ${cfg.bindHost}:${cfg.port}${cfg.path}/********]`, {
        source: 'system',
      });
    });
    return server;
  }

  function stop() {
    if (!server) return;
    server.close();
    server = null;
  }

  return { app, start, stop, getServer: () => server, config: cfg };
}
