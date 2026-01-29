import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';

import Rcon from 'rcon';

import { spawn } from 'child_process';

const DOCKER_CONTAINER = process.env.DOCKER_CONTAINER || 'cs2-dedicated';
const LOG_LINES = Number(process.env.LOG_LINES || 200);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,   // Apache regelt CSP, sonst blockt es dein Inline-JS/onclick
}));
app.use(express.json({ limit: '256kb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300 }));

// ---- Simple basic auth middleware (panel) ----
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'admin';
const PANEL_PASS_HASH = bcrypt.hashSync(PANEL_PASS, 10);

function basicAuth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CS2 RCON Panel"');
    return res.status(401).send('Auth required');
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

// ================================
// Live Log Hub + SteamID Tracking
// ================================
const LOG_TTL_MS = Number(process.env.LOG_TTL_MS || (60 * 60 * 1000)); // 1h
const steamByName = new Map(); // nameLower -> { steam64, accountid, lastSeen }
const sseClients = new Set();  // Set<ServerResponse>

let dockerLogProc = null;

// Regex für: "LilAdi88<65280><[U:1:346518218]><>" STEAM USERID validated
const STEAM_VALID_RE = /"(.+?)<(\d+)><\[U:1:(\d+)\]><.*?>"\s+STEAM USERID validated/i;

function accountIdToSteam64(accountid) {
  // steam64 = 76561197960265728 + accountid
  const base = 76561197960265728n;
  return (base + BigInt(accountid)).toString();
}

function noteSteamFromLogLine(line) {
  const m = String(line).match(STEAM_VALID_RE);
  if (!m) return;

  const name = m[1];
  const accountid = m[3];
  const steam64 = accountIdToSteam64(accountid);

  const key = String(name).toLowerCase();
  steamByName.set(key, {
    name,
    accountid,
    steam64,
    lastSeen: Date.now(),
  });
}

function cleanupSteamCache() {
  const now = Date.now();
  for (const [k, v] of steamByName.entries()) {
    if (!v?.lastSeen || now - v.lastSeen > LOG_TTL_MS) {
      steamByName.delete(k);
    }
  }
}

function broadcastSSE(line) {
  const msg = `data: ${String(line).replace(/\r?\n/g, ' ')}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch {}
  }
}

function ensureDockerLogsFollower() {
  if (dockerLogProc) return;

  // EIN Prozess für alle: docker logs -f --tail N <container>
  dockerLogProc = spawn('docker', ['logs', '-f', '--tail', String(LOG_LINES), DOCKER_CONTAINER], {
    windowsHide: true,
  });

  const onLine = (l) => {
    if (!l) return;
    noteSteamFromLogLine(l);
    broadcastSSE(l);
  };

  dockerLogProc.stdout.on('data', (buf) => {
    buf.toString('utf8').split('\n').forEach(onLine);
  });

  dockerLogProc.stderr.on('data', (buf) => {
    buf.toString('utf8').split('\n').forEach((l) => onLine(l ? '[stderr] ' + l : l));
  });

  dockerLogProc.on('close', () => {
    dockerLogProc = null;
    broadcastSSE('[log stream stopped]');
  });

  // Cache cleanup
  setInterval(cleanupSteamCache, 30_000).unref();
}

// Start follower IMMER (damit SteamIDs sofort verfügbar sind)
ensureDockerLogsFollower();


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

  // Heartbeat alle 15s, damit Proxies die Verbindung nicht killen
  const hb = setInterval(() => {
    try { res.write(`: hb ${Date.now()}\n\n`); } catch {}
  }, 15000);

  // docker logs -f --tail N <container>
  const p = spawn('docker', ['logs', '-f', '--tail', String(LOG_LINES), DOCKER_CONTAINER], {
    windowsHide: true,
  });

  const send = (line) => {
    // SSE: one message
    res.write(`data: ${String(line).replace(/\r?\n/g, ' ')}\n\n`);
  };

  p.stdout.on('data', (buf) => {
    buf.toString('utf8').split('\n').forEach(l => l && send(l));
  });

  p.stderr.on('data', (buf) => {
    buf.toString('utf8').split('\n').forEach(l => l && send('[stderr] ' + l));
  });

  req.on('close', () => {
    clearInterval(hb);
    try { p.kill(); } catch {}
  });
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
    res.json({ ok: true, out });
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
    res.json({ ok: true, out });
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
    res.json({ ok: true, out });
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
    res.json({ ok: true, out });
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

      const steam = steamByName.get(String(name).toLowerCase()) || null;

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
      const steam = steamByName.get(String(name).toLowerCase()) || null;
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
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const port = Number(process.env.PANEL_PORT || 8080);
app.listen(port, () => console.log(`CS2 RCON Panel listening on http://127.0.0.1:${port}`));
