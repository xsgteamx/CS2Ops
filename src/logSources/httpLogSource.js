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
    maxBody: env.LOG_HTTP_MAX_BODY || '1mb',
    maxLinesPerRequest: Number(env.LOG_HTTP_MAX_LINES_PER_REQUEST || 200),
    maxLinesPerWindow: Number(env.LOG_HTTP_MAX_LINES_PER_WINDOW || 200),
    maxLinesWindowMs: Number(env.LOG_HTTP_MAX_LINES_WINDOW_MS || 10000),
    dropOlderThanMs: Number(env.LOG_HTTP_DROP_OLDER_THAN_MS || 300000),
    allowIps: getAllowedIps(env.LOG_HTTP_ALLOW_IPS),
  };
}

function isSensitiveLogLine(line) {
  return /(?:password|passwd|secret|token|rcon)/i.test(String(line || ''));
}

function parseLogTimestamp(line) {
  const m = String(line || '').match(/(?:^L\s+)?(\d{2})\/(\d{2})\/(\d{4})\s+-\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!m) return null;
  const [, month, day, year, hour, minute, second, millis = '0'] = m;
  const ts = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millis.padEnd(3, '0')),
  ).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function isStaleLogLine(line, maxAgeMs) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return false;
  const ts = parseLogTimestamp(line);
  if (!ts) return false;
  return Date.now() - ts > maxAgeMs;
}

export function startHttpLogSource({ config, logHub, steamTracker } = {}) {
  const cfg = config || getHttpLogConfig();
  const app = express();
  let server = null;
  let windowStartedAt = Date.now();
  let windowLineCount = 0;

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

    const lines = [];
    let droppingCvarDump = false;

    raw
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        const lower = line.toLowerCase();
        if (lower.includes('server cvars start')) {
          droppingCvarDump = true;
          return;
        }
        if (lower.includes('server cvars end')) {
          droppingCvarDump = false;
          return;
        }
        if (
          droppingCvarDump ||
          /\bserver_cvar:/i.test(line) ||
          isSensitiveLogLine(line) ||
          isStaleLogLine(line, cfg.dropOlderThanMs)
        ) {
          return;
        }
        lines.push(line);
      });

    const maxLines = Number.isFinite(cfg.maxLinesPerRequest) && cfg.maxLinesPerRequest > 0
      ? cfg.maxLinesPerRequest
      : lines.length;

    lines
      .slice(-maxLines)
      .forEach((line) => {
        const now = Date.now();
        const windowMs = Number.isFinite(cfg.maxLinesWindowMs) && cfg.maxLinesWindowMs > 0
          ? cfg.maxLinesWindowMs
          : 10000;
        if (now - windowStartedAt >= windowMs) {
          windowStartedAt = now;
          windowLineCount = 0;
        }
        const windowMax = Number.isFinite(cfg.maxLinesPerWindow) && cfg.maxLinesPerWindow > 0
          ? cfg.maxLinesPerWindow
          : Infinity;
        if (windowLineCount >= windowMax) return;
        windowLineCount += 1;
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

  function resetFlowControl() {
    windowStartedAt = Date.now();
    windowLineCount = 0;
  }

  return { app, start, stop, resetFlowControl, getServer: () => server, config: cfg };
}
