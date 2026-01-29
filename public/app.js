/* =========================
   CS2Ops Frontend (app.js)
   ========================= */

/* ===== DOM helpers ===== */
const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => {
  const el = $(id);
  if (!el) return false;
  el.addEventListener(ev, fn);
  return true;
};

function escapeQuotes(s) {
  return String(s ?? "").replaceAll('"', '\\"');
}

function softErr(msg, err) {
  console.error("[CS2Ops]", msg, err || "");
  const out = $("out");
  if (out && msg) {
    out.value = (out.value ? out.value + "\n" : "") + `! ${msg}`;
    out.scrollTop = out.scrollHeight;
  }
}

/* ===== Config ===== */
const PAGE_SIZE = 5;
const WS_KEY = "cs2ops_workshop_favs_v2";
const SHOW_RCON_KEY = "cs2ops_show_rcon_logs_v1";

let acTimer = null;

let playersPage = 1;
let playersMax = null;
let lastStatusAt = 0;

let playersCache = [];
let playersInterval = null;

let logEventSource = null;
let logReconnectTimer = null;

let showRconLogs = (() => {
  try {
    const raw = localStorage.getItem(SHOW_RCON_KEY);
    if (raw === null) return false; // default: aus
    return raw === "1";
  } catch {
    return false;
  }
})();

/* =========================
   SteamID from logs (single SSE)
   ========================= */
const steamByUserId = new Map(); // userid(number) -> steamid64(string)
const steamByName = new Map();   // name(lowercase) -> steamid64(string)

function steam64FromAccountId(accountId) {
  return (76561197960265728n + BigInt(accountId)).toString();
}

function parseSteamValidatedLine(line) {
  // L ...: "LilAdi88<65280><[U:1:346518218]><>" STEAM USERID validated
  const s = String(line || "");
  const m = s.match(/"(.+?)<(\d+)><\[U:1:(\d+)\]><.*?>"\s+STEAM USERID validated/i);
  if (!m) return null;

  const name = m[1];
  const userid = Number(m[2]);
  const accountId = m[3];
  const steam64 = steam64FromAccountId(accountId);

  return { name, userid, steam64 };
}

function mergeSteamIntoPlayers() {
  playersCache = playersCache.map((p) => {
    const uid = Number(p.userid);
    const key = String(p.name || "").toLowerCase();
    const steam64 =
      (Number.isFinite(uid) ? steamByUserId.get(uid) : null) ||
      steamByName.get(key) ||
      null;
    return { ...p, steam64 };
  });
}

/* ===== Theme ===== */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);

  const badge = $("themeBadge");
  if (badge) badge.textContent = theme === "dark" ? "Dark" : "Light";

  const icon = document.querySelector("#themeToggle .icon");
  if (icon) icon.textContent = theme === "dark" ? "☀️" : "🌙";
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  localStorage.setItem("cs2ops_theme", next);
  applyTheme(next);
}

function initTheme() {
  const saved = localStorage.getItem("cs2ops_theme");
  const prefersDark =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
}

/* ===== API ===== */
async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

async function apiGet(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

function appendOut(t) {
  const el = $("out");
  if (!el) return;
  el.value = (el.value ? el.value + "\n" : "") + t;
  el.scrollTop = el.scrollHeight;
}

/* ===== Clear inputs on action ===== */
function clearInputs(ids) {
  for (const id of ids) {
    const el = $(id);
    if (el && typeof el.value === "string") el.value = "";
  }
}

/* ===== Autocomplete ===== */
function showAC(items) {
  const box = $("ac");
  if (!box) return;

  box.innerHTML = "";
  if (!items || !items.length) {
    box.style.display = "none";
    return;
  }

  for (const it of items) {
    const row = document.createElement("div");
    row.className = "ac-row";
    row.textContent = it;
    row.addEventListener("click", () => {
      const cmd = $("cmd");
      if (cmd) cmd.value = it + " ";
      box.style.display = "none";
      cmd?.focus();
    });
    box.appendChild(row);
  }
  box.style.display = "block";
}

async function fetchAC(q) {
  const res = await fetch("/api/autocomplete?q=" + encodeURIComponent(q) + "&limit=60");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "autocomplete failed");
  return data.items || [];
}

function scheduleAC(q) {
  clearTimeout(acTimer);
  acTimer = setTimeout(async () => {
    try {
      showAC(await fetchAC(q));
    } catch {
      showAC([]);
    }
  }, 80);
}

/* ===== Map thumbs ===== */
function mapThumbDataUri(mapName) {
  let hash = 0;
  for (let i = 0; i < mapName.length; i++) {
    hash = ((hash << 5) - hash) + mapName.charCodeAt(i);
    hash |= 0;
  }
  const hue1 = Math.abs(hash) % 360;
  const hue2 = (hue1 + 40) % 360;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="84" height="84" viewBox="0 0 84 84">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsla(${hue1},75%,55%,0.35)"/>
      <stop offset="1" stop-color="hsla(${hue2},85%,55%,0.12)"/>
    </linearGradient>
    <radialGradient id="r" cx="30%" cy="30%" r="70%">
      <stop offset="0" stop-color="hsla(${hue2},90%,60%,0.55)"/>
      <stop offset="1" stop-color="hsla(${hue1},90%,40%,0)"/>
    </radialGradient>
  </defs>
  <rect x="6" y="6" width="72" height="72" rx="18" fill="url(#g)"/>
  <circle cx="30" cy="30" r="26" fill="url(#r)"/>
  <path d="M18 58 C30 44, 54 44, 66 58" fill="none" stroke="hsla(${hue1},90%,70%,0.55)" stroke-width="4" stroke-linecap="round"/>
</svg>`;

  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/* ===== Workshop favorites ===== */
function getWorkshopSaved() {
  try {
    const raw = localStorage.getItem(WS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function setWorkshopSaved(arr) {
  localStorage.setItem(WS_KEY, JSON.stringify(arr));
}

function renderWorkshopSaved() {
  const wrap = $("workshopSaved");
  if (!wrap) return;

  const list = getWorkshopSaved();
  wrap.innerHTML = "";

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "Noch keine Workshop Maps gespeichert.";
    wrap.appendChild(empty);
    return;
  }

  for (const item of list) {
    const row = document.createElement("div");
    row.className = "ws-row";

    const left = document.createElement("div");
    left.className = "ws-left";

    const thumb = document.createElement("div");
    thumb.className = "map-thumb";
    thumb.style.backgroundImage = `url("${mapThumbDataUri(item.name || item.id)}")`;

    const title = document.createElement("div");
    title.className = "ws-title";

    const name = document.createElement("div");
    name.className = "ws-name";
    name.textContent = item.name ? item.name : "(ohne Name)";

    const id = document.createElement("div");
    id.className = "ws-id";
    id.textContent = item.id;

    title.appendChild(name);
    title.appendChild(id);

    left.appendChild(thumb);
    left.appendChild(title);

    const actions = document.createElement("div");
    actions.className = "ws-actions";

    const play = document.createElement("button");
    play.className = "mini-btn";
    play.textContent = "Start";
    play.addEventListener("click", async () => {
      const r = await api("/api/map/workshop", { id: item.id });
      appendOut("> host_workshop_map " + item.id + "\n" + (r.out || "OK"));
      clearInputs(["workshopId", "workshopName"]);
    });

    const edit = document.createElement("button");
    edit.className = "mini-btn";
    edit.textContent = "Name";
    edit.addEventListener("click", () => {
      const newName = prompt("Name für Workshop Map:", item.name || "");
      if (newName === null) return;
      const trimmed = String(newName).trim();
      const next = getWorkshopSaved().map((x) => (x.id === item.id ? { ...x, name: trimmed } : x));
      setWorkshopSaved(next);
      renderWorkshopSaved();
    });

    const del = document.createElement("button");
    del.className = "mini-btn mini-danger";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      const next = getWorkshopSaved().filter((x) => x.id !== item.id);
      setWorkshopSaved(next);
      renderWorkshopSaved();
    });

    actions.appendChild(play);
    actions.appendChild(edit);
    actions.appendChild(del);

    row.appendChild(left);
    row.appendChild(actions);
    wrap.appendChild(row);
  }
}

function saveWorkshopFromInput() {
  const wid = $("workshopId");
  const wname = $("workshopName");
  if (!wid || !wname) return;

  const id = wid.value.trim();
  const name = wname.value.trim();

  if (!/^[0-9]{6,}$/.test(id)) {
    appendOut("> Hinweis: Workshop ID muss numerisch sein.\n");
    return;
  }

  const list = getWorkshopSaved();
  if (list.some((x) => x.id === id)) {
    appendOut("> Workshop ID ist schon gespeichert.\n");
    renderWorkshopSaved();
    clearInputs(["workshopId", "workshopName"]);
    return;
  }

  list.unshift({ id, name });
  setWorkshopSaved(list.slice(0, 64));
  renderWorkshopSaved();
  appendOut("> Workshop gespeichert: " + id + (name ? " (" + name + ")" : "") + "\n");

  clearInputs(["workshopId", "workshopName"]);
}

function clearWorkshopSaved() {
  setWorkshopSaved([]);
  renderWorkshopSaved();
  appendOut("> Workshop Favoriten gelöscht.\n");
}

/* ===== Players ===== */
function parsePlayersRaw(raw) {
  const lines = String(raw || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  const out = [];
  for (const line of lines) {
    if (line.startsWith("<slot:") || line.endsWith(" users") || line === "#end") continue;

    const m = line.match(/^(\d+):(\d+):"(.*)"$/);
    if (m) {
      out.push({ slot: Number(m[1]), userid: Number(m[2]), name: m[3] });
      continue;
    }

    const m2 = line.match(/^(\d+).*"(.*)"/);
    if (m2) out.push({ userid: Number(m2[1]), name: m2[2] });
  }
  return out;
}

async function refreshServerStatusIfNeeded() {
  const now = Date.now();
  if (now - lastStatusAt < 15000) return;
  lastStatusAt = now;

  try {
    const r = await api("/api/command", { command: "status" });
    const out = String(r.out || "");
    const m = out.match(/players\s*:.*\((\d+)\s+max\)/i);
    if (m) {
      playersMax = parseInt(m[1], 10);
      if (!Number.isFinite(playersMax)) playersMax = null;
      return;
    }
  } catch {}
}

function renderPlayers() {
  const listEl = $("playersList");
  const search = $("playerSearch");
  const countEl = $("playerCount");
  if (!listEl || !search || !countEl) return;

  const q = search.value.trim().toLowerCase();

  const filtered = q
    ? playersCache.filter((p) => {
        const n = String(p.name || "").toLowerCase();
        const uid = String(p.userid ?? "");
        const s64 = String(p.steam64 ?? "");
        return n.includes(q) || uid.includes(q) || s64.includes(q);
      })
    : playersCache;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  playersPage = Math.min(Math.max(playersPage, 1), totalPages);

  const start = (playersPage - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);

  const maxText = playersMax && playersMax > 0 ? ` / ${playersMax}` : "";
  countEl.textContent = `${playersCache.length}${maxText} online`;

  listEl.innerHTML = "";

  if (!pageItems.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = playersCache.length ? "Keine Treffer." : "Keine Spieler online.";
    listEl.appendChild(empty);
  } else {
    for (const p of pageItems) {
      const row = document.createElement("div");
      row.className = "player-row";

      const left = document.createElement("div");
      left.className = "player-left";

      const av = document.createElement("div");
      av.className = "avatar";

      const meta = document.createElement("div");
      meta.className = "player-meta";

      const name = document.createElement("div");
      name.className = "player-name";
      name.textContent = p.name || "(unknown)";

      const sub = document.createElement("div");
      sub.className = "player-sub";
      sub.textContent = `userid: ${p.userid}` + (p.steam64 ? ` • steam64: ${p.steam64}` : "");

      meta.appendChild(name);
      meta.appendChild(sub);

      left.appendChild(av);
      left.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "player-actions";

      const kickBtn = document.createElement("button");
      kickBtn.className = "mini-btn mini-danger";
      kickBtn.textContent = "Kick";
      kickBtn.addEventListener("click", async () => {
        const reasonEl = $("kickReason");
        const reason = reasonEl?.value?.trim() || "";
        const cmd = `kickid ${p.userid}` + (reason ? ` "${escapeQuotes(reason)}"` : "");

        try {
          const r = await api("/api/command", { command: cmd });
          appendOut("> " + cmd + "\n" + (r.out || "OK"));
        } catch (e) {
          appendOut("> " + cmd + "\nERROR: " + (e?.message || e) + "\n");
        }

        clearInputs(["kickReason"]);
        await loadPlayers().catch(() => {});
      });

      actions.appendChild(kickBtn);

      row.appendChild(left);
      row.appendChild(actions);
      listEl.appendChild(row);
    }
  }

  const pager = document.createElement("div");
  pager.className = "row";
  pager.style.justifyContent = "space-between";
  pager.style.marginTop = "10px";

  const leftPager = document.createElement("div");
  leftPager.className = "row";

  const prev = document.createElement("button");
  prev.className = "btn";
  prev.textContent = "◀ Prev";
  prev.disabled = playersPage <= 1;
  prev.addEventListener("click", () => {
    playersPage--;
    renderPlayers();
  });

  const next = document.createElement("button");
  next.className = "btn";
  next.textContent = "Next ▶";
  next.disabled = playersPage >= totalPages;
  next.addEventListener("click", () => {
    playersPage++;
    renderPlayers();
  });

  const info = document.createElement("span");
  info.className = "badge";
  info.textContent = `Page ${playersPage} / ${totalPages}`;

  leftPager.appendChild(prev);
  leftPager.appendChild(next);

  pager.appendChild(leftPager);
  pager.appendChild(info);
  listEl.appendChild(pager);
}

async function loadPlayers() {
  const res = await fetch("/api/players");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "failed");

  playersCache = parsePlayersRaw(data.raw || "");
  mergeSteamIntoPlayers();

  await refreshServerStatusIfNeeded();
  renderPlayers();
}

function startPlayersAutoSync() {
  if (playersInterval) return;
  playersInterval = setInterval(() => loadPlayers().catch(() => {}), 5000);
}

/* ===== CVAR / Commands / Maps ===== */
async function setCvar() {
  const n = $("cvarName"), v = $("cvarValue");
  if (!n || !v) return;

  const name = n.value.trim();
  const value = v.value.trim();
  if (!name) return;

  const r = await api("/api/cvar", { name, value });
  appendOut("> " + name + " " + value + "\n" + (r.out || "OK"));

  clearInputs(["cvarName", "cvarValue"]);
}

async function sendCmd() {
  const c = $("cmd");
  if (!c) return;

  const command = c.value.trim();
  if (!command) return;

  const r = await api("/api/command", { command });
  appendOut("> " + command + "\n" + (r.out || "OK"));

  // autocomplete schließen + input leeren
  const ac = $("ac");
  if (ac) ac.style.display = "none";
  clearInputs(["cmd"]);
}

async function loadMaps() {
  const wrap = $("maps");
  if (!wrap) return;

  const m = await apiGet("/api/maps");
  wrap.innerHTML = "";

  (m.standard || []).forEach((map) => {
    const tile = document.createElement("div");
    tile.className = "map-tile";

    const thumb = document.createElement("div");
    thumb.className = "map-thumb";
    thumb.style.backgroundImage = `url("${mapThumbDataUri(map)}")`;

    const meta = document.createElement("div");
    meta.className = "map-meta";

    const name = document.createElement("div");
    name.className = "map-name";
    name.textContent = map;

    const sub = document.createElement("div");
    sub.className = "map-sub";
    sub.textContent = "Standard Map";

    meta.appendChild(name);
    meta.appendChild(sub);

    tile.appendChild(thumb);
    tile.appendChild(meta);

    tile.addEventListener("click", async () => {
      const r = await api("/api/map/standard", { map });
      appendOut("> changelevel " + map + "\n" + (r.out || "OK"));
    });

    wrap.appendChild(tile);
  });
}

async function workshopStart() {
  const wid = $("workshopId");
  if (!wid) return;

  const id = wid.value.trim();
  if (!id) return;

  const r = await api("/api/map/workshop", { id });
  appendOut("> host_workshop_map " + id + "\n" + (r.out || "OK"));

  clearInputs(["workshopId", "workshopName"]);
}

/* ===== Logs ===== */
function isRconLine(line) {
  return /:\s*rcon from ".*?": command "/i.test(String(line || ""));
}

function shouldDropLogLine(line) {
  const s = String(line || "");

  // wenn showRconLogs AUS ist -> alle rcon lines weg
  if (!showRconLogs && isRconLine(s)) return true;

  // wenn showRconLogs AN ist -> nur noisy cmds weg
  const m = s.match(/:\s*rcon from ".*?": command "([^"]+)"/i);
  if (m) {
    const cmd = (m[1] || "").trim().toLowerCase();
    const noisy = new Set(["users", "status", "cmdlist", "cvarlist", "sv_visiblemaxplayers"]);
    if (noisy.has(cmd)) return true;
  }

  return false;
}

function addLogLine(line) {
  if (shouldDropLogLine(line)) return;

  const box = $("logbox");
  if (!box) return;

  box.textContent += line + "\n";
  const lines = box.textContent.split("\n");
  if (lines.length > 900) box.textContent = lines.slice(lines.length - 900).join("\n");
  box.scrollTop = box.scrollHeight;
}

/* ===== Log badge + RCON toggle UI wiring (no HTML changes needed) ===== */
function ensureLogBadgeAndControls() {
  // 1) log badge finden (Live Logs card)
  let badge = $("logBadge");
  if (!badge) {
    // suche h2: "Live Logs" und darin span.badge
    const cards = Array.from(document.querySelectorAll(".card"));
    const logCard = cards.find(c => (c.querySelector("h2")?.textContent || "").toLowerCase().includes("live logs"));
    const span = logCard?.querySelector("h2 span.badge") || null;
    if (span) {
      span.id = "logBadge";
      badge = span;
    }
  }

  // 2) badge stylen, dass der Punkt drin ist (rechts), kein externer Punkt
  if (badge) {
    badge.style.display = "inline-flex";
    badge.style.alignItems = "center";
    badge.style.gap = "8px";
    badge.style.padding = "6px 10px";
    badge.style.borderRadius = "999px";
    badge.style.userSelect = "none";

    // Container in der H2 rechts bauen, damit Toggle rechts sitzt
    const h2 = badge.closest("h2");
    if (h2) {
      // make h2 a flex row: title left, controls right
      h2.style.display = "flex";
      h2.style.alignItems = "center";
      h2.style.justifyContent = "space-between";
      h2.style.gap = "12px";

      // rechts controls wrap
      let right = h2.querySelector(".log-controls-right");
      if (!right) {
        right = document.createElement("div");
        right.className = "log-controls-right";
        right.style.display = "inline-flex";
        right.style.alignItems = "center";
        right.style.gap = "10px";
        right.style.marginLeft = "12px";

        // h2 content: wir lassen den Text links, right kommt ans Ende
        h2.appendChild(right);
      }

      // badge in right packen (falls nicht schon)
      if (badge.parentElement !== right) right.appendChild(badge);

      // rcon toggle bauen
      let toggle = $("rconToggle");
      if (!toggle) {
        const wrap = document.createElement("label");
        wrap.id = "rconToggle";
        wrap.title = "RCON Logzeilen anzeigen/ausblenden";
        wrap.style.display = "inline-flex";
        wrap.style.alignItems = "center";
        wrap.style.gap = "8px";
        wrap.style.cursor = "pointer";
        wrap.style.userSelect = "none";
        wrap.style.fontSize = "12px";
        wrap.style.opacity = "0.95";

        const txt = document.createElement("span");
        txt.textContent = "RCON";
        txt.style.opacity = "0.9";

        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!showRconLogs;
        input.style.display = "none";

        const sw = document.createElement("span");
        // switch body
        sw.style.width = "42px";
        sw.style.height = "22px";
        sw.style.borderRadius = "999px";
        sw.style.position = "relative";
        sw.style.display = "inline-block";
        sw.style.boxSizing = "border-box";
        sw.style.border = "1px solid rgba(255,255,255,0.12)";
        sw.style.background = showRconLogs ? "rgba(34,197,94,0.25)" : "rgba(255,255,255,0.08)";
        sw.style.transition = "all .18s ease";

        const knob = document.createElement("span");
        knob.style.width = "18px";
        knob.style.height = "18px";
        knob.style.borderRadius = "999px";
        knob.style.position = "absolute";
        knob.style.top = "1.5px";
        knob.style.left = showRconLogs ? "21px" : "2px";
        knob.style.background = "rgba(255,255,255,0.85)";
        knob.style.boxShadow = "0 2px 10px rgba(0,0,0,0.35)";
        knob.style.transition = "all .18s ease";

        sw.appendChild(knob);

        const setSwitchUI = (on) => {
          sw.style.background = on ? "rgba(34,197,94,0.25)" : "rgba(255,255,255,0.08)";
          knob.style.left = on ? "21px" : "2px";
        };

        wrap.appendChild(txt);
        wrap.appendChild(input);
        wrap.appendChild(sw);

        wrap.addEventListener("click", (e) => {
          e.preventDefault();
          input.checked = !input.checked;
          showRconLogs = !!input.checked;
          try { localStorage.setItem(SHOW_RCON_KEY, showRconLogs ? "1" : "0"); } catch {}
          setSwitchUI(showRconLogs);
          // optional: logs neu "sauber" machen -> wir lassen content wie es ist,
          // ab jetzt wird gefiltert. Du kannst auch clearLogs() hier machen.
        });

        right.insertBefore(wrap, badge); // toggle links von badge, badge bleibt ganz rechts
      }
    }
  }
}

function setLogBadge(state) {
  const b = $("logBadge");
  if (!b) return;

  // Text + Punkt INSIDE badge
  let text = "STREAM";
  if (state === "live") text = "LIVE";
  else if (state === "reconnecting") text = "RECONNECTING…";
  else if (state === "offline") text = "OFFLINE";
  else text = String(state || "STREAM");

  // Punkt element (nur 1!)
  const dotHtml = `<span class="log-dot" style="
    width:10px;height:10px;border-radius:999px;
    display:inline-block;
    background:${state === "live" ? "rgba(34,197,94,0.95)" : state === "reconnecting" ? "rgba(245,158,11,0.95)" : "rgba(239,68,68,0.95)"};
    box-shadow:${state === "live" ? "0 0 0 6px rgba(34,197,94,0.14)" : "none"};
  "></span>`;

  b.innerHTML = `${text}${dotHtml}`;

  // Farben grob (passt zu deinem Dark UI)
  b.style.borderColor = "";
  b.style.color = "";
  b.style.opacity = "1";

  if (state === "live") {
    b.style.borderColor = "rgba(34,197,94,.35)";
    b.style.color = "rgba(34,197,94,.95)";
  } else if (state === "reconnecting") {
    b.style.borderColor = "rgba(245,158,11,.35)";
    b.style.color = "rgba(245,158,11,.95)";
  } else if (state === "offline") {
    b.style.borderColor = "rgba(239,68,68,.35)";
    b.style.color = "rgba(239,68,68,.95)";
    b.style.opacity = ".9";
  }

  // pulse togglen (falls du eine .pulse CSS animation hast)
  b.classList.toggle("pulse", state === "live");
}

function startLogs() {
  stopLogs(); // immer nur 1 Verbindung
  ensureLogBadgeAndControls();
  setLogBadge("reconnecting");

  try {
    logEventSource = new EventSource("/api/logs/stream");
  } catch (e) {
    logEventSource = null;
    setLogBadge("offline");
    softErr("Live Logs konnten nicht gestartet werden (EventSource).", e);
    return;
  }

  logEventSource.onopen = () => {
    setLogBadge("live");
  };

  logEventSource.onmessage = (e) => {
    const line = e.data || "";

    // Steam parsing IMMER
    const hit = parseSteamValidatedLine(line);
    if (hit) {
      if (Number.isFinite(hit.userid)) steamByUserId.set(hit.userid, hit.steam64);
      if (hit.name) steamByName.set(String(hit.name).toLowerCase(), hit.steam64);

      mergeSteamIntoPlayers();
      renderPlayers();
    }

    // Log line ggf. anzeigen
    addLogLine(line);

    setLogBadge("live");
  };

  logEventSource.onerror = () => {
    setLogBadge("reconnecting");

    try { logEventSource?.close(); } catch {}
    logEventSource = null;

    if (logReconnectTimer) return;
    logReconnectTimer = setTimeout(() => {
      logReconnectTimer = null;
      startLogs();
    }, 1500);
  };
}

function stopLogs() {
  if (logReconnectTimer) {
    clearTimeout(logReconnectTimer);
    logReconnectTimer = null;
  }
  if (logEventSource) {
    try { logEventSource.close(); } catch {}
    logEventSource = null;
  }
  setLogBadge("offline");
}

function clearLogs() {
  const box = $("logbox");
  if (box) box.textContent = "";
}

// sauber beenden
function closeStreams() {
  try { logEventSource?.close(); } catch {}
  logEventSource = null;
}
window.addEventListener("beforeunload", closeStreams);
window.addEventListener("pagehide", closeStreams);

/* ===== Bindings ===== */
function bindUI() {
  on("themeToggle", "click", toggleTheme);

  on("cvarSet", "click", () => setCvar().catch((e) => softErr("cvar error", e)));
  document.querySelectorAll(".pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = $("cvarName"), v = $("cvarValue");
      if (!n || !v) return;
      n.value = btn.dataset.cvar || "";
      v.value = btn.dataset.val || "";
      setCvar().catch((e) => softErr("cvar error", e));
    });
  });

  on("wsStart", "click", () => workshopStart().catch((e) => softErr("ws error", e)));
  on("wsSave", "click", () => { saveWorkshopFromInput(); });
  on("wsClear", "click", clearWorkshopSaved);

  on("playersReload", "click", () => loadPlayers().catch(() => {}));
  on("playerSearch", "input", () => {
    playersPage = 1;
    renderPlayers();
  });

  on("cmdSend", "click", () => sendCmd().catch((e) => softErr("cmd error", e)));
  on("cmd", "keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendCmd().catch(() => {});
      const ac = $("ac");
      if (ac) ac.style.display = "none";
    }
  });

  on("cmd", "focus", () => scheduleAC(""));
  on("cmd", "input", (e) => scheduleAC(e.target.value.trim()));
  document.addEventListener("click", (e) => {
    const ac = $("ac");
    const cmd = $("cmd");
    if (!ac || !cmd) return;
    if (!ac.contains(e.target) && e.target !== cmd) ac.style.display = "none";
  });

  on("logClear", "click", clearLogs);
}

/* ===== Init ===== */
document.addEventListener("DOMContentLoaded", async () => {
  try {
    initTheme();
    bindUI();
    renderWorkshopSaved();

    loadMaps().catch((e) => softErr("maps error", e));
    loadPlayers().catch(() => {});
    startPlayersAutoSync();

    // Badge + Toggle bauen + Logs autostarten
    ensureLogBadgeAndControls();
    startLogs();

    appendOut("> CS2Ops ready ✅");
  } catch (e) {
    softErr("Init crashed (check missing IDs in index.html).", e);
  }
});
