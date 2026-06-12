import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import Rcon from 'rcon';

import { LogHub } from './src/logHub.js';
import { startDockerLogSource } from './src/logSources/dockerLogSource.js';
import { getHttpLogConfig, startHttpLogSource } from './src/logSources/httpLogSource.js';
import { boolFromEnv, maskSecretInText, maskUrlSecret } from './src/logSecurity.js';
import { SteamIdTracker, accountIdToSteam64, normalizeTeam } from './src/steamIdTracker.js';

const DOCKER_CONTAINER = process.env.DOCKER_CONTAINER || 'cs2-dedicated';
const LOG_LINES = Number(process.env.LOG_LINES || 200);
const LOG_SOURCE = String(process.env.LOG_SOURCE || 'docker').toLowerCase();
const LOG_TTL_MS = Number(process.env.LOG_TTL_MS || (60 * 60 * 1000));
const LOG_HTTP_RCON_REGISTER = boolFromEnv(process.env.LOG_HTTP_RCON_REGISTER, true);
const STEAM_WEB_API_KEY = String(process.env.STEAM_WEB_API_KEY || '').trim();
const STEAM_AVATAR_TTL_MS = Number(process.env.STEAM_AVATAR_TTL_MS || (12 * 60 * 60 * 1000));
const httpLogConfig = getHttpLogConfig(process.env);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,   // Apache regelt CSP, sonst blockt es dein Inline-JS/onclick
}));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
const PANEL_RATE_LIMIT_WINDOW_MS = Number(process.env.PANEL_RATE_LIMIT_WINDOW_MS || (15 * 60 * 1000));
const PANEL_RATE_LIMIT_MAX = Number(process.env.PANEL_RATE_LIMIT_MAX || 3000);
const LOGIN_CAPTCHA_ENABLED = boolFromEnv(process.env.LOGIN_CAPTCHA_ENABLED, true);
const LOGIN_CAPTCHA_AFTER_FAILURES = Number(process.env.LOGIN_CAPTCHA_AFTER_FAILURES || 2);
const LOGIN_CAPTCHA_TTL_MS = Number(process.env.LOGIN_CAPTCHA_TTL_MS || (5 * 60 * 1000));
const LOGIN_LOCK_AFTER_FAILURES = Number(process.env.LOGIN_LOCK_AFTER_FAILURES || 10);
const LOGIN_LOCK_TTL_MS = Number(process.env.LOGIN_LOCK_TTL_MS || (5 * 60 * 1000));
app.use(rateLimit({
  windowMs: PANEL_RATE_LIMIT_WINDOW_MS,
  limit: PANEL_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (req.path === '/api/logs/stream') return true;
    if (req.method === 'GET' && !req.path.startsWith('/api/')) return true;
    return false;
  },
}));

// ---- Panel auth: login page session cookie + Basic Auth fallback ----
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'admin';
const PANEL_PASS_HASH = bcrypt.hashSync(PANEL_PASS, 10);
const PANEL_SESSION_TTL_MS = Number(process.env.PANEL_SESSION_TTL_MS || (12 * 60 * 60 * 1000));
const PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || crypto
  .createHash('sha256')
  .update(`${PANEL_USER}:${PANEL_PASS}:cs2ops-session`)
  .digest('hex');
const PANEL_BASE_PATH = normalizeBasePath(process.env.PANEL_BASE_PATH || '');
const loginAttempts = new Map();

function normalizeBasePath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

function panelUrl(pathname = '/') {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${PANEL_BASE_PATH}${normalized}`;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function signSession(user, issuedAt) {
  return crypto
    .createHmac('sha256', PANEL_SESSION_SECRET)
    .update(`${user}:${issuedAt}`)
    .digest('hex');
}

function createSessionToken(user) {
  const issuedAt = Date.now();
  const sig = signSession(user, issuedAt);
  return `${Buffer.from(user, 'utf8').toString('base64url')}.${issuedAt}.${sig}`;
}

function verifySessionToken(token) {
  const [user64, issuedAtRaw, sig] = String(token || '').split('.');
  if (!user64 || !issuedAtRaw || !sig) return false;
  const user = Buffer.from(user64, 'base64url').toString('utf8');
  const issuedAt = Number(issuedAtRaw);
  if (user !== PANEL_USER || !Number.isFinite(issuedAt)) return false;
  if (Date.now() - issuedAt > PANEL_SESSION_TTL_MS) return false;
  const expected = signSession(user, issuedAt);
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function acceptsHtml(req) {
  return String(req.headers.accept || '').includes('text/html');
}

function loginKey(req, user) {
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const normalizedUser = String(user || '').trim().toLowerCase();
  return `${ip}:${normalizedUser}`;
}

function getLoginAttempt(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key) || { failures: 0, lockedUntil: 0, captcha: null };
  if (entry.lockedUntil && entry.lockedUntil <= now) {
    entry.lockedUntil = 0;
    entry.failures = 0;
  }
  if (entry.captcha?.expiresAt <= now) entry.captcha = null;
  loginAttempts.set(key, entry);
  return entry;
}

function captchaRequired(entry) {
  return LOGIN_CAPTCHA_ENABLED && entry.failures >= LOGIN_CAPTCHA_AFTER_FAILURES;
}

function createCaptcha(entry) {
  const a = crypto.randomInt(2, 10);
  const b = crypto.randomInt(2, 10);
  entry.captcha = {
    answer: String(a + b),
    text: `${a} + ${b} = ?`,
    expiresAt: Date.now() + LOGIN_CAPTCHA_TTL_MS,
  };
  return entry.captcha;
}

function recordLoginFailure(key) {
  const entry = getLoginAttempt(key);
  entry.failures += 1;
  entry.captcha = null;
  if (LOGIN_LOCK_AFTER_FAILURES > 0 && entry.failures >= LOGIN_LOCK_AFTER_FAILURES) {
    entry.lockedUntil = Date.now() + LOGIN_LOCK_TTL_MS;
  }
  loginAttempts.set(key, entry);
}

function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

function loginFail(res) {
  return res.redirect(panelUrl('/login?login=failed'));
}

function basicAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  if (verifySessionToken(cookies.cs2ops_session)) return next();

  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) {
    if (acceptsHtml(req) && !req.path.startsWith('/api/')) {
      return res.redirect(panelUrl('/login'));
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="CS2 RCON Panel"');
    return res.status(401).format({
      json: () => res.json({ ok: false, error: 'Auth required' }),
      default: () => res.send('Auth required'),
    });
  }
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  const user = idx >= 0 ? decoded.slice(0, idx) : '';
  const pass = idx >= 0 ? decoded.slice(idx + 1) : '';

  if (user !== PANEL_USER || !bcrypt.compareSync(pass, PANEL_PASS_HASH)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CS2 RCON Panel"');
    return res.status(401).send('Invalid credentials');
  }
  next();
}

app.get('/login', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  if (verifySessionToken(cookies.cs2ops_session)) return res.redirect(panelUrl('/'));
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login/captcha-status', (req, res) => {
  const key = loginKey(req, req.query.user);
  const entry = getLoginAttempt(key);
  res.json({
    ok: true,
    required: captchaRequired(entry),
    locked: Boolean(entry.lockedUntil && entry.lockedUntil > Date.now()),
  });
});

app.get('/login/captcha', (req, res) => {
  const key = loginKey(req, req.query.user);
  const entry = getLoginAttempt(key);
  if (!captchaRequired(entry)) return res.status(404).send('Not required');
  const captcha = createCaptcha(entry);
  const noise = Array.from({ length: 4 }, () => {
    const x1 = crypto.randomInt(10, 160);
    const y1 = crypto.randomInt(10, 52);
    const x2 = crypto.randomInt(10, 160);
    const y2 = crypto.randomInt(10, 52);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(148,163,184,.35)" stroke-width="1"/>`;
  }).join('');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="170" height="62" viewBox="0 0 170 62" role="img" aria-label="captcha">
  <rect width="170" height="62" rx="14" fill="#0b1220"/>
  <path d="M10 44 C42 18, 62 52, 95 24 S135 46, 160 18" fill="none" stroke="rgba(96,165,250,.35)" stroke-width="2"/>
  ${noise}
  <text x="85" y="39" text-anchor="middle" fill="#edf5ff" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="24" font-weight="800" letter-spacing="2">${captcha.text}</text>
</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(svg);
});

app.post('/login', (req, res) => {
  const { user, pass, captcha } = req.body || {};
  const key = loginKey(req, user);
  const entry = getLoginAttempt(key);
  if (entry.lockedUntil && entry.lockedUntil > Date.now()) return loginFail(res);

  if (captchaRequired(entry)) {
    const expected = String(entry.captcha?.answer || '');
    const supplied = String(captcha || '').trim();
    const validCaptcha = expected && supplied && expected === supplied;
    if (!validCaptcha) {
      recordLoginFailure(key);
      return loginFail(res);
    }
  }

  if (user !== PANEL_USER || !bcrypt.compareSync(String(pass || ''), PANEL_PASS_HASH)) {
    recordLoginFailure(key);
    return loginFail(res);
  }
  clearLoginFailures(key);
  const token = createSessionToken(PANEL_USER);
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
  res.setHeader(
    'Set-Cookie',
    `cs2ops_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(PANEL_SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`
  );
  res.redirect(panelUrl('/'));
});

app.post('/logout', basicAuth, (req, res) => {
  res.setHeader('Set-Cookie', 'cs2ops_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ================================
// Live Log Hub + SteamID Tracking
// ================================
const logHub = new LogHub({ maxLines: LOG_LINES, sourceMode: LOG_SOURCE });
const steamTracker = new SteamIdTracker({ ttlMs: LOG_TTL_MS });
let httpLogSourceController = null;

setInterval(() => steamTracker.cleanup(), 30_000).unref();

if (LOG_SOURCE === 'docker') {
  startDockerLogSource({
    container: DOCKER_CONTAINER,
    lines: LOG_LINES,
    logHub,
    steamTracker,
  }).start();
} else if (LOG_SOURCE === 'none') {
  logHub.push('Live logs disabled', { source: 'system' });
} else if (LOG_SOURCE === 'http') {
  httpLogSourceController = startHttpLogSource({
    config: httpLogConfig,
    logHub,
    steamTracker,
  });
  httpLogSourceController.start();
} else if (LOG_SOURCE !== 'http') {
  logHub.push(`[unknown LOG_SOURCE=${LOG_SOURCE}; live logs disabled]`, { source: 'system' });
}


// Serve UI
app.use('/', basicAuth, express.static(path.join(__dirname, 'public')));

// ---- RCON helper ----
const CS2_HOST = process.env.CS2_HOST;
const CS2_PORT = Number(process.env.CS2_PORT || 27015);
const CS2_RCON_PASSWORD = process.env.CS2_RCON_PASSWORD;

function rconExec(command, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const rcon = new Rcon(CS2_HOST, CS2_PORT, CS2_RCON_PASSWORD);

    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { rcon.disconnect(); } catch {}
      reject(new Error('RCON timeout'));
    }, timeoutMs);

    let response = '';
    rcon.on('auth', () => {
      rcon.send(command);
    });

    rcon.on('response', (str) => {
      response += str + '\n';
      // some servers send multiple response frames; close shortly after last
      setTimeout(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { rcon.disconnect(); } catch {}
        resolve(response.trim());
      }, 80);
    });

    rcon.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });

    rcon.connect();
  });
}

// SSE endpoint
app.get('/api/logs/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // hilft bei Nginx/Proxies
  });

  // bei manchen Setups wichtig, um Headers sofort rauszuschieben
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const unsubscribe = logHub.subscribe(res);

  req.on('close', () => {
    unsubscribe();
  });
});

function getLogStatusPayload() {
  const receiverEnabled = LOG_SOURCE === 'http';
  return {
    ok: true,
    source: LOG_SOURCE,
    receiver: {
      enabled: receiverEnabled,
      bindHost: receiverEnabled ? httpLogConfig.bindHost : null,
      port: receiverEnabled ? httpLogConfig.port : null,
      path: receiverEnabled ? httpLogConfig.path : null,
      publicUrlMasked: receiverEnabled ? maskUrlSecret(httpLogConfig.publicUrl) : null,
      allowIpsConfigured: receiverEnabled ? httpLogConfig.allowIps.length > 0 : false,
      rconRegisterEnabled: receiverEnabled && LOG_HTTP_RCON_REGISTER,
    },
    stats: logHub.getStatus(),
  };
}

function assertHttpRegisterAllowed(res) {
  if (LOG_SOURCE !== 'http') {
    res.status(409).json({ ok: false, error: 'HTTP remote log mode is not enabled' });
    return false;
  }
  if (!LOG_HTTP_RCON_REGISTER) {
    res.status(403).json({ ok: false, error: 'HTTP log RCON registration is disabled' });
    return false;
  }
  if (!httpLogConfig.publicUrl) {
    res.status(500).json({ ok: false, error: 'LOG_HTTP_PUBLIC_URL is missing' });
    return false;
  }
  if (/["\r\n]/.test(httpLogConfig.publicUrl)) {
    res.status(500).json({ ok: false, error: 'LOG_HTTP_PUBLIC_URL contains invalid characters' });
    return false;
  }
  return true;
}

async function runMaskedRconCommand(command, { warning = false } = {}) {
  try {
    const out = await rconExec(command);
    return {
      command: maskSecretInText(command),
      ok: true,
      ...(warning ? { warning: true } : {}),
      out: maskSecretInText(out),
    };
  } catch (e) {
    return {
      command: maskSecretInText(command),
      ok: false,
      ...(warning ? { warning: true } : {}),
      out: maskSecretInText(e?.message || e),
    };
  }
}

app.get('/api/logs/status', basicAuth, (req, res) => {
  res.json(getLogStatusPayload());
});

app.get('/api/logs/recent', basicAuth, (req, res) => {
  const since = Number(req.query.since || 0);
  res.json({
    ...getLogStatusPayload(),
    lines: logHub.getLinesAfter(Number.isFinite(since) ? since : 0),
  });
});

app.post('/api/logs/register-http', basicAuth, async (req, res) => {
  if (!assertHttpRegisterAllowed(res)) return;

  const commands = [];
  commands.push(await runMaskedRconCommand('log on'));
  commands.push(await runMaskedRconCommand('logaddress_delall_http'));
  commands.push(await runMaskedRconCommand(`logaddress_add_http "${httpLogConfig.publicUrl}"`));
  commands.push(await runMaskedRconCommand('mp_logdetail 3', { warning: true }));
  commands.push(await runMaskedRconCommand('logaddress_list_http'));

  const ok = commands
    .filter((item) => !item.warning)
    .every((item) => item.ok);

  res.status(ok ? 200 : 500).json({ ok, commands });
});

app.post('/api/logs/unregister-http', basicAuth, async (req, res) => {
  if (!assertHttpRegisterAllowed(res)) return;

  const commands = [];
  commands.push(await runMaskedRconCommand('logaddress_delall_http'));
  commands.push(await runMaskedRconCommand('logaddress_list_http'));

  const ok = commands.every((item) => item.ok);
  res.status(ok ? 200 : 500).json({ ok, commands });
});

app.post('/api/logs/test', basicAuth, (req, res) => {
  logHub.push('[CS2Ops test] HTTP log receiver test message', { source: 'test' });
  res.json({ ok: true, stats: logHub.getStatus() });
});

app.post('/api/logs/clear', basicAuth, (req, res) => {
  httpLogSourceController?.resetFlowControl?.();
  res.json({ ok: true, stats: logHub.getStatus() });
});



// ---- Autocomplete cache ----
let AUTO_CACHE = {
  loadedAt: 0,
  cmds: [],
  cvars: [],
  all: [],      // merged list
};

const AUTO_TTL_MS = Number(process.env.AUTO_TTL_MS || (10 * 60 * 1000)); // 10 min
const AUTO_MAX_ITEMS = Number(process.env.AUTO_MAX_ITEMS || 80000);

function unique(arr) {
  return [...new Set(arr)];
}

function parseCmdOrCvarList(raw) {
  // cmdlist/cvarlist output varies; we extract first token per line when it looks like a name
  const lines = (raw || '').split('\n').map(l => l.trim()).filter(Boolean);

  const out = [];
  for (const line of lines) {
    // Examples often start with name, sometimes with quotes, sometimes prefixed
    // Grab a token that looks like a command/cvar name:
    const m = line.match(/^"?([a-zA-Z_][a-zA-Z0-9_]*)"?/);
    if (m) out.push(m[1]);
  }
  return out;
}

async function refreshAutocompleteCache(force = false) {
  const now = Date.now();
  if (!force && AUTO_CACHE.loadedAt && (now - AUTO_CACHE.loadedAt) < AUTO_TTL_MS) {
    return AUTO_CACHE;
  }

  let cmds = [];
  let cvars = [];

  // Try cmdlist
  try {
    const rawCmds = await rconExec('cmdlist');
    cmds = parseCmdOrCvarList(rawCmds);
  } catch {}

  // Try cvarlist (can be huge)
  try {
    const rawCvars = await rconExec('cvarlist');
    cvars = parseCmdOrCvarList(rawCvars);
  } catch {}

  // Merge; limit
  const all = unique([...cmds, ...cvars]).slice(0, AUTO_MAX_ITEMS);

  AUTO_CACHE = {
    loadedAt: now,
    cmds,
    cvars,
    all,
  };

  return AUTO_CACHE;
}


// ---- API ----
app.get('/api/autocomplete', basicAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit || 30), 200);

  try {
    const cache = await refreshAutocompleteCache(false);

    // If empty query -> show "top" items (first N). You can also sort by popularity later.
    if (!q) {
      return res.json({ ok: true, items: cache.all.slice(0, limit), total: cache.all.length });
    }

    // Fast prefix filter. For huge lists, this is fine in JS up to ~100k.
    const items = [];
    for (const name of cache.all) {
      if (name.toLowerCase().startsWith(q)) {
        items.push(name);
        if (items.length >= limit) break;
      }
    }

    res.json({ ok: true, items, total: cache.all.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/autocomplete/refresh', basicAuth, async (req, res) => {
  try {
    const cache = await refreshAutocompleteCache(true);
    res.json({ ok: true, total: cache.all.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


app.post('/api/command', basicAuth, async (req, res) => {
  const { command } = req.body || {};
  if (!command || typeof command !== 'string') return res.status(400).json({ error: 'command missing' });

  // tiny safety: block multi-line / chained commands (you can remove this if you want)
  if (command.includes('\n') || command.includes('\r')) return res.status(400).json({ error: 'invalid command' });

  try {
    const out = await rconExec(command);
    res.json({ ok: true, out: maskSecretInText(out) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/cvar', basicAuth, async (req, res) => {
  const { name, value } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name missing' });
  const v = value === undefined ? '' : String(value);

  // Allow only sane cvar names
  if (!/^[a-zA-Z0-9_]+$/.test(name)) return res.status(400).json({ error: 'invalid cvar name' });

  try {
    const out = await rconExec(`${name} ${v}`.trim());
    res.json({ ok: true, out: maskSecretInText(out) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const STANDARD_MAPS = (process.env.STANDARD_MAPS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.get('/api/maps', basicAuth, (req, res) => {
  res.json({ standard: STANDARD_MAPS });
});

app.post('/api/map/standard', basicAuth, async (req, res) => {
  const { map } = req.body || {};
  if (!STANDARD_MAPS.includes(map)) return res.status(400).json({ error: 'map not allowed' });

  try {
    // typical for source: changelevel <map>
    const out = await rconExec(`changelevel ${map}`);
    res.json({ ok: true, out: maskSecretInText(out) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/map/workshop', basicAuth, async (req, res) => {
  const { id } = req.body || {};
  const wid = String(id || '').trim();
  if (!/^[0-9]{6,}$/.test(wid)) return res.status(400).json({ error: 'invalid workshop id' });

  try {
    // CS2 / CSGO commonly: host_workshop_map <id>
    const out = await rconExec(`host_workshop_map ${wid}`);
    res.json({ ok: true, out: maskSecretInText(out) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Players: parse "users" output (simple)
function parseUsers(text) {
  const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const players = [];

  for (const line of lines) {
    if (line.startsWith('<slot:') || line.endsWith(' users') || line === '#end') continue;

    // Format: slot:userid:"name"
    const m = line.match(/^(\d+):(\d+):"(.*)"$/);
    if (m) {
      const slot = Number(m[1]);
      const userid = Number(m[2]);
      const name = m[3];

      const steam = steamTracker.getByName(name);

      players.push({
        slot,
        userid,
        name,
        steam64: steam?.steam64 || null,
        accountid: steam?.accountid || null,
        lastSeen: steam?.lastSeen || null,
        team: steam?.team || null,
        isBot: false,
        bot: false,
        raw: line,
      });
      continue;
    }

    // fallback: irgendwas mit "name" in quotes
    const m2 = line.match(/^(\d+).*"(.*)"/);
    if (m2) {
      const name = m2[2];
      const steam = steamTracker.getByName(name);
      players.push({
        slot: null,
        userid: Number(m2[1]),
        name,
        steam64: steam?.steam64 || null,
        accountid: steam?.accountid || null,
        lastSeen: steam?.lastSeen || null,
        team: steam?.team || null,
        isBot: false,
        bot: false,
        raw: line,
      });
    }
  }

  return { lines, players };
}

function steam2ToSteam64(value) {
  const m = String(value || '').match(/^STEAM_[0-5]:([01]):(\d+)$/i);
  if (!m) return null;
  const accountid = BigInt(m[2]) * 2n + BigInt(m[1]);
  return accountIdToSteam64(accountid);
}

function parseStatusPlayers(text) {
  const players = [];
  const byName = new Map();
  const byUserid = new Map();
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const maxPlayers = Number(String(text || '').match(/players\s*:.*\((\d+)\s+max\)/i)?.[1] || 0) || null;

  for (const line of lines) {
    const nameMatch = line.match(/['"]([^'"]*)['"]\s*$/);
    if (!nameMatch) continue;

    const name = String(nameMatch[1] || '').trim();
    if (!name) continue;

    const beforeName = line.slice(0, nameMatch.index).trim();
    const parts = beforeName.split(/\s+/).filter(Boolean);
    if (!/^\d+$/.test(parts[0] || '')) continue;

    const userid = Number(parts[0]);
    const timeOrType = parts[1] || '';
    const unique = beforeName.match(/(?:\b(BOT|STEAM_[0-5]:[01]:\d+|7656119\d{10})\b|\[U:1:(\d+)\])/i);
    const uniqueId = unique?.[1] || (unique?.[2] ? `[U:1:${unique[2]}]` : '');
    const team = normalizeTeam(beforeName.match(/\b(CT|TERRORIST|T|SPECTATOR|SPEC)\b/i)?.[1]);
    const isBot = /^BOT$/i.test(timeOrType) || /\bBOT\b/i.test(uniqueId);
    const steam64 =
      String(uniqueId).match(/^7656119\d{10}$/)?.[0] ||
      steam2ToSteam64(uniqueId) ||
      (unique?.[2] ? accountIdToSteam64(unique[2]) : null);

    const item = {
      userid: Number.isFinite(userid) ? userid : null,
      name,
      isBot,
      bot: isBot,
      steam64: isBot ? null : steam64,
      team,
      uniqueId,
      raw: line,
    };
    players.push(item);
    byName.set(String(name).toLowerCase(), item);
    if (Number.isFinite(item.userid)) byUserid.set(item.userid, item);
  }

  return { players, byName, byUserid, maxPlayers };
}

const steamAvatarCache = new Map();

function getCachedSteamAvatar(steam64) {
  const cached = steamAvatarCache.get(String(steam64 || ''));
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return cached.data;
}

function setCachedSteamAvatar(steam64, data) {
  steamAvatarCache.set(String(steam64), {
    data,
    expiresAt: Date.now() + STEAM_AVATAR_TTL_MS,
  });
}

async function enrichPlayerAvatars(players) {
  if (!STEAM_WEB_API_KEY || typeof fetch !== 'function') return players;

  const steamIds = [...new Set(players
    .filter((player) => !player.isBot && /^7656119\d{10}$/.test(String(player.steam64 || '')))
    .map((player) => String(player.steam64)))];
  if (!steamIds.length) return players;

  const missing = steamIds.filter((steam64) => !getCachedSteamAvatar(steam64));
  if (missing.length) {
    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/');
    url.searchParams.set('key', STEAM_WEB_API_KEY);
    url.searchParams.set('steamids', missing.join(','));

    try {
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(2500)
          : undefined;
      const response = await fetch(url, { signal });
      const data = await response.json().catch(() => ({}));
      const summaries = Array.isArray(data.response?.players) ? data.response.players : [];
      for (const summary of summaries) {
        const steam64 = String(summary.steamid || '');
        if (!steam64) continue;
        setCachedSteamAvatar(steam64, {
          avatar: summary.avatarmedium || summary.avatarfull || summary.avatar || null,
          avatarSmall: summary.avatar || null,
          avatarMedium: summary.avatarmedium || null,
          avatarFull: summary.avatarfull || null,
        });
      }
      for (const steam64 of missing) {
        if (!getCachedSteamAvatar(steam64)) setCachedSteamAvatar(steam64, {});
      }
    } catch {}
  }

  return players.map((player) => {
    const avatar = getCachedSteamAvatar(player.steam64);
    return avatar ? { ...player, ...avatar } : player;
  });
}


app.get('/api/players', basicAuth, async (req, res) => {
  try {
    const out = await rconExec('users');
    const parsed = parseUsers(out);
    let status = null;
    try {
      status = parseStatusPlayers(await rconExec('status'));
    } catch {}

    const usersByName = new Map(parsed.players.map((player) => [String(player.name || '').toLowerCase(), player]));
    const usersByUserid = new Map(parsed.players.map((player) => [player.userid, player]));

    const statusPlayers = Array.isArray(status?.players) ? status.players : [];
    const players = statusPlayers.length
      ? statusPlayers.map((statusPlayer) => {
          const userPlayer =
            usersByUserid.get(statusPlayer.userid) ||
            usersByName.get(String(statusPlayer.name || '').toLowerCase()) ||
            {};
          const steam = steamTracker.getByName(statusPlayer.name);
          return {
            ...userPlayer,
            ...statusPlayer,
            slot: userPlayer.slot ?? null,
            steam64: statusPlayer.steam64 || userPlayer.steam64 || steam?.steam64 || null,
            accountid: userPlayer.accountid || steam?.accountid || null,
            lastSeen: userPlayer.lastSeen || steam?.lastSeen || null,
            isBot: Boolean(statusPlayer.isBot),
            bot: Boolean(statusPlayer.isBot),
          };
        })
      : parsed.players.map((player) => ({
          ...player,
          isBot: Boolean(player.isBot),
          bot: Boolean(player.bot),
        }));

    res.json({
      ok: true,
      ...parsed,
      players: await enrichPlayerAvatars(players),
      maxPlayers: status?.maxPlayers || null,
      raw: out,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/player/kick', basicAuth, async (req, res) => {
  const { userid, reason } = req.body || {};
  const id = String(userid || '').trim();
  if (!/^[0-9]{1,3}$/.test(id)) return res.status(400).json({ error: 'invalid userid' });

  const msg = reason ? String(reason).replace(/[\r\n]/g, ' ').slice(0, 120) : '';
  const cmd = msg ? `kick #${id} "${msg}"` : `kick #${id}`;

  try {
    const out = await rconExec(cmd);
    res.json({ ok: true, out: maskSecretInText(out) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const port = Number(process.env.PANEL_PORT || 8080);
app.listen(port, () => console.log(`CS2 RCON Panel listening on http://127.0.0.1:${port}`));
