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
import { SteamIdTracker } from './src/steamIdTracker.js';

const DOCKER_CONTAINER = process.env.DOCKER_CONTAINER || 'cs2-dedicated';
const LOG_LINES = Number(process.env.LOG_LINES || 200);
const LOG_SOURCE = String(process.env.LOG_SOURCE || 'docker').toLowerCase();
const LOG_TTL_MS = Number(process.env.LOG_TTL_MS || (60 * 60 * 1000));
const LOG_HTTP_RCON_REGISTER = boolFromEnv(process.env.LOG_HTTP_RCON_REGISTER, true);
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

function basicAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  if (verifySessionToken(cookies.cs2ops_session)) return next();

  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) {
    if (acceptsHtml(req) && !req.path.startsWith('/api/')) {
      return res.redirect('/login');
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
  if (verifySessionToken(cookies.cs2ops_session)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (user !== PANEL_USER || !bcrypt.compareSync(String(pass || ''), PANEL_PASS_HASH)) {
    return res.status(401).sendFile(path.join(__dirname, 'public', 'login.html'));
  }
  const token = createSessionToken(PANEL_USER);
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
  res.setHeader(
    'Set-Cookie',
    `cs2ops_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(PANEL_SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`
  );
  res.redirect('/');
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
  startHttpLogSource({
    config: httpLogConfig,
    logHub,
    steamTracker,
  }).start();
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
        raw: line,
      });
    }
  }

  return { lines, players };
}


app.get('/api/players', basicAuth, async (req, res) => {
  try {
    const out = await rconExec('users');
    res.json({ ok: true, ...parseUsers(out), raw: out });
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
