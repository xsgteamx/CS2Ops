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
const MAX_VISIBLE_LOG_LINES = 180;
const HTTP_LOG_POLL_VISIBLE_MS = 1000;
const HTTP_LOG_POLL_HIDDEN_MS = 5000;

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

function toast(message) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove("show"), 1800);
}

function setupHoverPreview() {
  let active = null;
  let bubble = null;
  const hide = () => {
    active = null;
    if (bubble) bubble.classList.remove("show");
  };
  const move = (event) => {
    if (!active || !bubble) return;
    const pad = 14;
    const rect = bubble.getBoundingClientRect();
    let left = event.clientX + pad;
    let top = event.clientY + pad;
    if (left + rect.width > window.innerWidth - 8) left = event.clientX - rect.width - pad;
    if (top + rect.height > window.innerHeight - 8) top = event.clientY - rect.height - pad;
    bubble.style.left = `${Math.max(8, left)}px`;
    bubble.style.top = `${Math.max(8, top)}px`;
  };
  document.addEventListener("mouseover", (event) => {
    const target = event.target.closest("[data-preview]");
    if (!target) return;
    const text = target.dataset.preview || "";
    if (!text) return;
    bubble ||= (() => {
      const el = document.createElement("div");
      el.className = "hover-preview";
      document.body.appendChild(el);
      return el;
    })();
    active = target;
    bubble.textContent = text;
    bubble.classList.add("show");
    move(event);
  });
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseout", (event) => {
    if (active && !event.relatedTarget?.closest?.("[data-preview]")) hide();
  });
  window.addEventListener("blur", hide);
}

function formatTemplate(text, vars = {}) {
  return String(text ?? "").replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

function t(key, vars = {}) {
  const lookup = (locale) => key.split(".").reduce((obj, part) => obj?.[part], I18N[locale]);
  return formatTemplate(lookup(currentLocale) ?? lookup("en") ?? key, vars);
}

function applyI18n() {
  document.documentElement.lang = currentLocale;

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder));
  });

  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.setAttribute("title", t(el.dataset.i18nTitle));
  });

  const select = $("localeSelect");
  if (select) select.value = currentLocale;

  document.querySelectorAll(".locale-option").forEach((btn) => {
    const active = btn.dataset.locale === currentLocale;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });

  localizeCvarPresets();
}

function setLocale(locale) {
  currentLocale = I18N[locale] ? locale : "zh-CN";
  try { localStorage.setItem(LOCALE_KEY, currentLocale); } catch {}
  applyI18n();
  applyTheme(document.documentElement.getAttribute("data-theme") || "light");
  renderWorkshopSaved();
  renderPlayers();
  renderLogStatus(latestLogStatus);
}

function presetId(btn) {
  return btn.dataset.presetKey || `${btn.dataset.cvar || ""}:${btn.dataset.val || ""}`;
}

function localizeCvarPresets() {
  document.querySelectorAll(".pill").forEach((btn) => {
    const key = presetId(btn);
    const label =
      I18N[currentLocale]?.cvar?.presets?.[key] ||
      I18N.en?.cvar?.presets?.[key] ||
      key;
    const command = btn.dataset.command || `${btn.dataset.cvar || ""} ${btn.dataset.val || ""}`.trim();
    btn.replaceChildren(document.createTextNode(label), document.createElement("span"));
    const span = btn.querySelector("span");
    if (span) span.textContent = btn.dataset.presetKey ? "game_type / game_mode" : (btn.dataset.cvar || "");
    btn.dataset.command = command;
    btn.dataset.preview = command;
    btn.removeAttribute("title");
    btn.setAttribute("aria-label", `${label}: ${command}`);
  });
}

function getCvarPresetOrder() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CVAR_ORDER_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveCvarPresetOrder() {
  const order = {};
  document.querySelectorAll(".preset-group").forEach((group, index) => {
    const key = group.dataset.groupKey || String(index);
    order[key] = Array.from(group.querySelectorAll(".pill")).map(presetId);
  });
  try { localStorage.setItem(CVAR_ORDER_KEY, JSON.stringify(order)); } catch {}
}

function applyCvarPresetOrder() {
  const order = getCvarPresetOrder();
  document.querySelectorAll(".preset-group").forEach((group, index) => {
    const key = group.dataset.groupKey || String(index);
    const ids = order[key];
    const bar = group.querySelector(".pillbar");
    if (!bar || !Array.isArray(ids)) return;
    const lookup = new Map(Array.from(bar.querySelectorAll(".pill")).map((btn) => [presetId(btn), btn]));
    ids.forEach((id) => {
      const btn = lookup.get(id);
      if (btn) bar.appendChild(btn);
    });
  });
}

function setupCvarPresetDrag() {
  let dragged = null;
  document.querySelectorAll(".preset-group").forEach((group, index) => {
    group.dataset.groupKey = group.querySelector(".preset-title")?.dataset.i18n || String(index);
  });
  document.querySelectorAll(".preset-group .pill").forEach((btn) => {
    btn.draggable = true;
    btn.addEventListener("dragstart", (event) => {
      dragged = btn;
      btn.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", presetId(btn));
    });
    btn.addEventListener("dragend", () => {
      btn.classList.remove("is-dragging");
      dragged = null;
      saveCvarPresetOrder();
    });
  });
  document.querySelectorAll(".preset-group .pillbar").forEach((bar) => {
    bar.addEventListener("dragover", (event) => {
      if (!dragged || dragged.parentElement !== bar) return;
      event.preventDefault();
      const target = event.target.closest(".pill");
      if (!target || target === dragged || target.parentElement !== bar) return;
      const rect = target.getBoundingClientRect();
      const sameRow = event.clientY >= rect.top && event.clientY <= rect.bottom;
      const before = sameRow
        ? event.clientX < rect.left + rect.width / 2
        : event.clientY < rect.top + rect.height / 2;
      bar.insertBefore(dragged, before ? target : target.nextSibling);
    });
    bar.addEventListener("drop", (event) => {
      if (!dragged || dragged.parentElement !== bar) return;
      event.preventDefault();
      saveCvarPresetOrder();
    });
  });
}

/* ===== Config ===== */
const PAGE_SIZE = 5;
const WS_KEY = "cs2ops_workshop_favs_v2";
const SHOW_RCON_KEY = "cs2ops_show_rcon_logs_v1";
const LOCALE_KEY = "cs2ops_locale_v1";
const CVAR_ORDER_KEY = "cs2ops_cvar_preset_order_v1";

const I18N = {
  "zh-CN": {
    common: {
      set: "设置",
      clear: "清除",
      reload: "刷新",
      send: "发送",
      logout: "退出",
      ok: "OK",
    },
    theme: {
      light: "浅色",
      dark: "深色",
      toggle: "切换主题",
      toggleTitle: "切换深色 / 浅色模式",
      lightMode: "浅色模式",
      darkMode: "深色模式",
      toLight: "浅色",
      toDark: "深色",
    },
    cvar: {
      title: "配置 / CVAR",
      valuePlaceholder: "例如 16000",
      matchPresets: "比赛",
      modePresets: "模式",
      moneyPresets: "经济",
      practicePresets: "练习",
      presets: {
        "mp_freezetime:15": "冻结 15s",
        "mp_freezetime:0": "无冻结",
        "mp_roundtime_defuse:1.92": "回合 1:55",
        "mp_maxrounds:24": "MR12",
        "mp_overtime_enable:1": "开启加时",
        "mp_restartgame:1": "重开 1s",
        "mp_pause_match:1": "暂停比赛",
        "mp_unpause_match:1": "继续比赛",
        "mp_halftime:1": "开启半场",
        "mp_match_can_clinch:1": "允许提前结束",
        "mode:competitive": "竞技",
        "mode:casual": "休闲",
        "mode:wingman": "搭档",
        "mode:deathmatch": "死亡竞赛",
        "mode:armsrace": "军备竞赛",
        "mode:custom": "自定义",
        "mp_startmoney:800": "$800 开局",
        "mp_startmoney:16000": "$16000 开局",
        "mp_maxmoney:16000": "金钱上限 16000",
        "mp_afterroundmoney:16000": "每回合补满",
        "mp_buytime:9999": "长买枪时间",
        "mp_buy_anywhere:1": "任意地点买枪",
        "mp_buy_anywhere:0": "仅购买区买枪",
        "mp_free_armor:1": "免费护甲",
        "mp_free_armor:0": "关闭免费护甲",
        "mp_weapons_allow_map_placed:1": "允许地图武器",
        "sv_cheats:1": "练习权限",
        "sv_infinite_ammo:1": "无限弹药",
        "ammo_grenade_limit_total:5": "五颗投掷物",
        "sv_grenade_trajectory_prac_pipreview:1": "投掷预览",
        "mp_warmup_end:1": "结束热身",
        "bot_quota:0": "清空 Bot",
        "bot_quota:5": "添加 5 个 Bot",
        "bot_kick:": "踢出 Bot",
        "bot_stop:1": "冻结 Bot",
        "bot_stop:0": "恢复 Bot",
        "mp_limitteams:0": "关闭队伍限制",
        "mp_autoteambalance:0": "关闭自动平衡"
      },
    },
    map: {
      title: "切换地图",
      standard: "官方地图",
    },
    workshop: {
      favorites: "WORKSHOP 收藏",
      clearTitle: "删除所有已保存的 Workshop 地图",
      idPlaceholder: "Workshop 地图 ID，例如 3070689635",
      namePlaceholder: "名称，例如 Aim Map / Mirage Night",
      start: "启动 Workshop",
      save: "保存地图",
      localHint: "Workshop 收藏会保存在当前浏览器的本地存储中。",
      empty: "还没有保存 Workshop 地图。",
      unnamed: "未命名",
      renamePrompt: "Workshop 地图名称：",
      invalidId: "提示：Workshop ID 必须是数字。",
      duplicateId: "这个 Workshop ID 已经保存过了。",
      saved: "已保存 Workshop：",
      cleared: "Workshop 收藏已清空。",
      rename: "命名",
      delete: "删除",
    },
    players: {
      title: "用户 / 玩家",
      searchPlaceholder: "搜索玩家（名称 / UserID）...",
      kickReasonPlaceholder: "踢出原因（可选）",
      online: "在线",
      empty: "暂无在线玩家",
      loading: "正在刷新玩家...",
      noMatch: "没有匹配结果。",
      tableName: "玩家",
      tableUserId: "UserID",
      tableSteam: "SteamID64",
      tableAction: "操作",
      kick: "踢出",
      kickTitle: "踢出玩家",
      kickConfirm: "确认踢出玩家 {name}？",
      bot: "BOT",
      human: "HUMAN",
      copySteam: "复制 SteamID64",
      copiedSteam: "SteamID64 已复制",
      openProfile: "打开 Steam 个人资料",
      prev: "上一页",
      next: "下一页",
      page: "第 {page} / {total} 页",
      unknown: "未知",
      unknownPlayer: "Unknown Player",
      notAvailable: "N/A",
    },
    console: {
      title: "控制台",
      outputPlaceholder: "输出...",
      ready: "CS2Ops 已就绪",
    },
    logs: {
      title: "HTTP 远程日志",
      source: "日志来源",
      receiveState: "接收状态",
      lastReceived: "最近收到",
      sseClients: "SSE 客户端",
      totalLines: "总日志行数",
      receiverUrl: "接收地址",
      enablePush: "启用推送",
      disablePush: "取消推送",
      test: "测试日志",
      refresh: "刷新状态",
      showRcon: "显示 RCON 日志",
      httpRemote: "HTTP 远程日志",
      docker: "Docker 本机日志",
      disabled: "日志已禁用",
      justNow: "刚刚",
      secondsAgo: "{n} 秒前",
      minutesAgo: "{n} 分钟前",
      hoursAgo: "{n} 小时前",
      registerAction: "启用 HTTP 日志推送",
      unregisterAction: "取消 HTTP 日志推送",
      testAction: "发送测试日志",
      eventSourceError: "实时日志无法启动（EventSource）。",
    },
    errors: {
      cvar: "CVAR 错误",
      workshop: "Workshop 错误",
      command: "命令错误",
      maps: "地图加载错误",
      logStatus: "日志状态错误",
      registerLog: "启用 HTTP 日志失败",
      unregisterLog: "取消 HTTP 日志失败",
      testLog: "发送测试日志失败",
      init: "初始化失败，请检查页面元素。",
    },
  },
  en: {
    common: { set: "Set", clear: "Clear", reload: "Reload", send: "Send", logout: "Logout", ok: "OK" },
    theme: {
      light: "Light",
      dark: "Dark",
      toggle: "Dark mode",
      toggleTitle: "Toggle dark / light mode",
      lightMode: "Light mode",
      darkMode: "Dark mode",
      toLight: "Light",
      toDark: "Dark",
    },
    cvar: {
      title: "Configs / CVARs",
      valuePlaceholder: "e.g. 16000",
      matchPresets: "Match",
      modePresets: "Mode",
      moneyPresets: "Money",
      practicePresets: "Practice",
      presets: {
        "mp_freezetime:15": "Freeze 15s",
        "mp_freezetime:0": "No freeze",
        "mp_roundtime_defuse:1.92": "Round 1:55",
        "mp_maxrounds:24": "MR12",
        "mp_overtime_enable:1": "Overtime on",
        "mp_restartgame:1": "Restart 1s",
        "mp_pause_match:1": "Pause match",
        "mp_unpause_match:1": "Unpause match",
        "mp_halftime:1": "Halftime on",
        "mp_match_can_clinch:1": "Allow clinch",
        "mode:competitive": "Competitive",
        "mode:casual": "Casual",
        "mode:wingman": "Wingman",
        "mode:deathmatch": "Deathmatch",
        "mode:armsrace": "Arms Race",
        "mode:custom": "Custom",
        "mp_startmoney:800": "$800 start",
        "mp_startmoney:16000": "$16000 start",
        "mp_maxmoney:16000": "Money cap 16000",
        "mp_afterroundmoney:16000": "Refill after round",
        "mp_buytime:9999": "Long buy time",
        "mp_buy_anywhere:1": "Buy anywhere",
        "mp_buy_anywhere:0": "Buy zone only",
        "mp_free_armor:1": "Free armor",
        "mp_free_armor:0": "No free armor",
        "mp_weapons_allow_map_placed:1": "Map weapons on",
        "sv_cheats:1": "Practice access",
        "sv_infinite_ammo:1": "Infinite ammo",
        "ammo_grenade_limit_total:5": "Five grenades",
        "sv_grenade_trajectory_prac_pipreview:1": "Grenade preview",
        "mp_warmup_end:1": "End warmup",
        "bot_quota:0": "Clear bots",
        "bot_quota:5": "Add 5 bots",
        "bot_kick:": "Kick bots",
        "bot_stop:1": "Freeze bots",
        "bot_stop:0": "Resume bots",
        "mp_limitteams:0": "No team limit",
        "mp_autoteambalance:0": "No auto-balance"
      },
    },
    map: { title: "Change map", standard: "Standard Map" },
    workshop: {
      favorites: "WORKSHOP FAVORITES",
      clearTitle: "Delete all saved workshop maps",
      idPlaceholder: "Workshop Map ID (e.g. 3070689635)",
      namePlaceholder: "Name (e.g. Aim Map / Mirage Night)",
      start: "Start workshop",
      save: "Save map",
      localHint: "Workshop favorites will be saved in the local storage of the browser.",
      empty: "No workshop maps saved yet.",
      unnamed: "unnamed",
      renamePrompt: "Workshop map name:",
      invalidId: "Hint: Workshop ID must be numeric.",
      duplicateId: "This Workshop ID is already saved.",
      saved: "Workshop saved:",
      cleared: "Workshop favorites cleared.",
      rename: "Name",
      delete: "Delete",
    },
    players: {
      title: "Users / Players",
      searchPlaceholder: "Search player (Name/UserID)...",
      kickReasonPlaceholder: "Kick reason (optional)",
      online: "online",
      empty: "No players online",
      loading: "Refreshing players...",
      noMatch: "No matches.",
      tableName: "Player",
      tableUserId: "UserID",
      tableSteam: "SteamID64",
      tableAction: "Action",
      kick: "Kick",
      kickTitle: "Kick player",
      kickConfirm: "Kick player {name}?",
      bot: "BOT",
      human: "HUMAN",
      copySteam: "Copy SteamID64",
      copiedSteam: "SteamID64 copied",
      openProfile: "Open Steam profile",
      prev: "Prev",
      next: "Next",
      page: "Page {page} / {total}",
      unknown: "Unknown",
      unknownPlayer: "Unknown Player",
      notAvailable: "N/A",
    },
    console: { title: "Console", outputPlaceholder: "Output...", ready: "CS2Ops ready" },
    logs: {
      title: "HTTP Remote Logs",
      source: "Log source",
      receiveState: "Receiver state",
      lastReceived: "Last received",
      sseClients: "SSE clients",
      totalLines: "Total lines",
      receiverUrl: "Receiver URL",
      enablePush: "Enable push",
      disablePush: "Disable push",
      test: "Test log",
      refresh: "Refresh status",
      showRcon: "Show RCON logs",
      httpRemote: "HTTP Remote",
      docker: "Docker",
      disabled: "Disabled",
      justNow: "just now",
      secondsAgo: "{n}s ago",
      minutesAgo: "{n}m ago",
      hoursAgo: "{n}h ago",
      registerAction: "Register HTTP log push",
      unregisterAction: "Unregister HTTP log push",
      testAction: "Send test log",
      eventSourceError: "Live Logs could not be started (EventSource).",
    },
    errors: {
      cvar: "cvar error",
      workshop: "workshop error",
      command: "command error",
      maps: "maps error",
      logStatus: "log status error",
      registerLog: "register http log error",
      unregisterLog: "unregister http log error",
      testLog: "test log error",
      init: "Init crashed (check missing IDs in index.html).",
    },
  },
};

let currentLocale = (() => {
  try {
    return localStorage.getItem(LOCALE_KEY) || "zh-CN";
  } catch {
    return "zh-CN";
  }
})();

let acTimer = null;

let playersPage = 1;
let playersMax = null;
let playersLoading = true;
let lastStatusAt = 0;
let playersRequestInFlight = false;
let playersLastSignature = "";

let playersCache = [];
let playersInterval = null;

let logEventSource = null;
let logReconnectTimer = null;
let logPollTimer = null;
let logRefreshInFlight = false;
let latestLogStatus = null;
let lastLogSeq = 0;
let clearedBeforeSeq = 0;
const seenLogSeqs = new Set();
const seenLogFingerprints = new Set();
const logLineBuffer = [];

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
      p.steam64 ||
      null;
    return { ...p, steam64 };
  });
}

function playersSignature(list = playersCache) {
  return JSON.stringify(list.map((p) => [
    p.userid ?? "",
    p.name ?? "",
    p.steam64 ?? "",
    p.isBot ? 1 : 0,
    p.avatar ?? "",
  ]));
}

/* ===== Theme ===== */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);

  const badge = $("themeBadge");
  if (badge) badge.textContent = theme === "dark" ? t("theme.dark") : t("theme.light");

  const icon = document.querySelector("#themeToggle .icon");
  if (icon) icon.textContent = "◐";

  const label = document.querySelector("#themeToggle .btn-label");
  if (label) label.textContent = theme === "dark" ? t("theme.lightMode") : t("theme.darkMode");
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
function appPath(path) {
  const normalized = String(path || "/");
  return normalized.replace(/^\/+/, "");
}

async function api(path, body) {
  const res = await fetch(appPath(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

async function apiGet(path) {
  const res = await fetch(appPath(path));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

function appendRconOutput(t) {
  const el = $("out");
  if (!el) return;
  el.value = (el.value ? el.value + "\n" : "") + t;
  el.scrollTop = el.scrollHeight;
}

function appendOut(t) {
  appendRconOutput(t);
}

function clearRconOutput() {
  const el = $("out");
  if (el) el.value = "";
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
  const res = await fetch(appPath("/api/autocomplete?q=" + encodeURIComponent(q) + "&limit=60"));
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
  const clearBtn = $("wsClear");
  if (clearBtn) {
    clearBtn.hidden = !list.length;
    clearBtn.disabled = !list.length;
  }
  wrap.innerHTML = "";

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = t("workshop.empty");
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
    name.textContent = item.name ? item.name : `(${t("workshop.unnamed")})`;

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
    play.textContent = t("workshop.start");
    play.addEventListener("click", async () => {
      try {
        const r = await api("/api/map/workshop", { id: item.id });
        appendOut("> host_workshop_map " + item.id + "\n" + (r.out || "OK"));
        clearInputs(["workshopId", "workshopName"]);
      } finally {
        refreshHttpLogs({ force: true }).catch(() => {});
      }
    });

    const edit = document.createElement("button");
    edit.className = "mini-btn";
    edit.textContent = t("workshop.rename");
    edit.addEventListener("click", () => {
      const newName = prompt(t("workshop.renamePrompt"), item.name || "");
      if (newName === null) return;
      const trimmed = String(newName).trim();
      const next = getWorkshopSaved().map((x) => (x.id === item.id ? { ...x, name: trimmed } : x));
      setWorkshopSaved(next);
      renderWorkshopSaved();
    });

    const del = document.createElement("button");
    del.className = "mini-btn mini-danger";
    del.textContent = t("workshop.delete");
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
    appendOut("> " + t("workshop.invalidId") + "\n");
    return;
  }

  const list = getWorkshopSaved();
  if (list.some((x) => x.id === id)) {
    appendOut("> " + t("workshop.duplicateId") + "\n");
    renderWorkshopSaved();
    clearInputs(["workshopId", "workshopName"]);
    return;
  }

  list.unshift({ id, name });
  setWorkshopSaved(list.slice(0, 64));
  renderWorkshopSaved();
  appendOut("> " + t("workshop.saved") + " " + id + (name ? " (" + name + ")" : "") + "\n");

  clearInputs(["workshopId", "workshopName"]);
}

function clearWorkshopSaved() {
  setWorkshopSaved([]);
  renderWorkshopSaved();
  appendOut("> " + t("workshop.cleared") + "\n");
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

function normalizePlayer(player = {}) {
  const name = String(player.name || "").trim() || t("players.unknownPlayer");
  const userid = player.userid ?? player.userId ?? null;
  const uniqueId = player.uniqueId || player.uniqueid || "";
  const steam64 = player.steam64 || player.steamid64 || player.steamId64 || null;
  const team = normalizePlayerTeam(player.team);
  const isBot = Boolean(
    player.bot ||
    player.isBot ||
    /^bot$/i.test(String(steam64 || "")) ||
    /\bBOT\b/i.test(String(uniqueId || "")) ||
    /^\s*\d+\s+BOT\b/i.test(String(player.raw || ""))
  );
  return {
    ...player,
    name,
    userid: Number.isFinite(Number(userid)) ? Number(userid) : null,
    steam64: isBot ? null : steam64,
    isBot,
    team,
    avatar: player.avatar || player.avatarUrl || "",
  };
}

function normalizePlayerTeam(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (raw === "CT" || raw === "COUNTERTERRORIST" || raw === "COUNTER-TERRORIST") return "CT";
  if (raw === "T" || raw === "TERRORIST" || raw === "TERRORISTS") return "T";
  if (raw === "SPECTATOR" || raw === "SPEC") return "SPEC";
  return "";
}

function isValidSteam64(value) {
  return /^[0-9]{17}$/.test(String(value || ""));
}

function playerAvatarDataUri(isBot = false) {
  const label = isBot ? "BOT" : "P";
  const hue = isBot ? 205 : 156;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
  <rect width="72" height="72" rx="20" fill="hsl(${hue} 55% 18%)"/>
  <circle cx="36" cy="28" r="13" fill="hsl(${hue} 65% 58%)"/>
  <path d="M16 62c4-14 14-21 20-21s16 7 20 21" fill="hsl(${hue} 58% 42%)"/>
  <text x="36" y="42" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" font-weight="800" fill="#eaf2ff">${label}</text>
</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

async function copyText(value) {
  const text = String(value || "");
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
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
  countEl.textContent = `${playersCache.length}${maxText} ${t("players.online")}`;

  listEl.innerHTML = "";
  const listWrap = document.createElement("div");
  listWrap.className = "players-table-wrap players-card-list";

  if (playersLoading) {
    const empty = document.createElement("div");
    empty.className = "players-empty-state players-loading-row";
    empty.textContent = t("players.loading");
    listWrap.appendChild(empty);
  } else if (!pageItems.length) {
    const empty = document.createElement("div");
    empty.className = "players-empty-state";
    empty.textContent = playersCache.length ? t("players.noMatch") : t("players.empty");
    listWrap.appendChild(empty);
  } else {
    for (const rawPlayer of pageItems) {
      const p = normalizePlayer(rawPlayer);
      const hasSteam = isValidSteam64(p.steam64);
      const useridText = p.userid === null ? t("players.notAvailable") : `#${p.userid}`;
      const steamText = p.isBot ? t("players.bot") : (hasSteam ? p.steam64 : t("players.unknown"));

      const row = document.createElement("div");
      row.className = "player-card-row";

      const main = document.createElement("div");
      main.className = "player-card-main";

      const playerIdentity = document.createElement("div");
      playerIdentity.className = "player-identity";
      const avatar = document.createElement("img");
      avatar.className = "avatar player-avatar";
      avatar.alt = "";
      avatar.src = p.avatar || playerAvatarDataUri(p.isBot);
      avatar.addEventListener("error", () => {
        avatar.src = playerAvatarDataUri(p.isBot);
      }, { once: true });

      const meta = document.createElement("div");
      meta.className = "player-meta";
      const title = document.createElement("div");
      title.className = "player-title-row";

      const name = document.createElement("span");
      name.className = "player-name";
      name.textContent = p.name;
      name.title = p.name;

      const type = document.createElement("span");
      type.className = `player-type-badge ${p.isBot ? "is-bot" : "is-human"}`;
      type.textContent = p.isBot ? t("players.bot") : t("players.human");

      title.appendChild(name);
      title.appendChild(type);

      const steam = document.createElement("div");
      steam.className = "player-sub mono-cell";
      steam.textContent = steamText;
      steam.title = steamText;

      meta.appendChild(title);
      meta.appendChild(steam);
      playerIdentity.appendChild(avatar);
      playerIdentity.appendChild(meta);
      main.appendChild(playerIdentity);

      const userid = document.createElement("span");
      userid.className = "player-userid badge";
      userid.textContent = useridText;
      userid.title = useridText;

      const actions = document.createElement("div");
      actions.className = "player-actions";

      if (hasSteam) {
        const copyBtn = document.createElement("button");
        copyBtn.className = "mini-btn player-icon-action";
        copyBtn.type = "button";
        copyBtn.textContent = "⧉";
        copyBtn.title = t("players.copySteam");
        copyBtn.setAttribute("aria-label", t("players.copySteam"));
        copyBtn.addEventListener("click", async () => {
          await copyText(p.steam64);
          toast(t("players.copiedSteam"));
        });
        actions.appendChild(copyBtn);

        const profile = document.createElement("a");
        profile.className = "mini-btn player-icon-action";
        profile.href = `https://steamcommunity.com/profiles/${p.steam64}`;
        profile.target = "_blank";
        profile.rel = "noopener noreferrer";
        profile.textContent = "↗";
        profile.title = t("players.openProfile");
        profile.setAttribute("aria-label", t("players.openProfile"));
        actions.appendChild(profile);
      }

      const kickBtn = document.createElement("button");
      kickBtn.className = "mini-btn mini-danger";
      kickBtn.type = "button";
      kickBtn.textContent = t("players.kick");
      kickBtn.title = t("players.kickTitle");
      kickBtn.disabled = p.userid === null;
      kickBtn.addEventListener("click", async () => {
        if (p.userid === null) return;
        if (!confirm(t("players.kickConfirm", { name: p.name }))) return;
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
        await refreshHttpLogs({ force: true }).catch(() => {});
        await loadPlayers().catch(() => {});
      });
      actions.appendChild(kickBtn);

      row.appendChild(main);
      row.appendChild(userid);
      row.appendChild(actions);
      listWrap.appendChild(row);
    }
  }

  listEl.appendChild(listWrap);

  const pager = document.createElement("div");
  pager.className = "players-pager";

  const leftPager = document.createElement("div");
  leftPager.className = "players-pager-actions";

  const prev = document.createElement("button");
  prev.className = "btn players-page-btn players-page-prev";
  prev.textContent = "";
  prev.title = t("players.prev");
  prev.setAttribute("aria-label", t("players.prev"));
  prev.disabled = playersPage <= 1 || totalPages <= 1;
  prev.addEventListener("click", () => {
    playersPage--;
    renderPlayers();
  });

  const next = document.createElement("button");
  next.className = "btn players-page-btn players-page-next";
  next.textContent = "";
  next.title = t("players.next");
  next.setAttribute("aria-label", t("players.next"));
  next.disabled = playersPage >= totalPages || totalPages <= 1;
  next.addEventListener("click", () => {
    playersPage++;
    renderPlayers();
  });

  const info = document.createElement("span");
  info.className = "badge";
  info.textContent = t("players.page", { page: playersPage, total: totalPages });

  if (totalPages > 1) {
    leftPager.appendChild(prev);
    leftPager.appendChild(next);
    pager.appendChild(leftPager);
  }

  pager.appendChild(info);
  listEl.appendChild(pager);
}

async function loadPlayers() {
  if (playersRequestInFlight) return;
  playersRequestInFlight = true;
  const hadRows = playersCache.length > 0;
  playersLoading = !hadRows;
  if (!hadRows) renderPlayers();
  let needsRender = !hadRows;

  try {
    const res = await fetch(appPath("/api/players"));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "failed");

    const nextPlayers = Array.isArray(data.players)
      ? data.players.map(normalizePlayer)
      : parsePlayersRaw(data.raw || "").map(normalizePlayer);
    playersCache = nextPlayers;
    mergeSteamIntoPlayers();
    const nextSignature = playersSignature(playersCache);
    needsRender = needsRender || nextSignature !== playersLastSignature;
    playersLastSignature = nextSignature;

    const prevMax = playersMax;
    if (Number.isFinite(Number(data.maxPlayers)) && Number(data.maxPlayers) > 0) {
      playersMax = Number(data.maxPlayers);
    } else {
      await refreshServerStatusIfNeeded();
    }
    needsRender = needsRender || prevMax !== playersMax;
  } finally {
    playersLoading = false;
    playersRequestInFlight = false;
    if (needsRender) renderPlayers();
  }
}

function startPlayersAutoSync() {
  if (playersInterval) return;
  playersInterval = setInterval(() => {
    if (document.hidden) return;
    loadPlayers().catch(() => {});
  }, 5000);
}

/* ===== CVAR / Commands / Maps ===== */
async function setCvar() {
  const n = $("cvarName"), v = $("cvarValue");
  if (!n || !v) return;

  const name = n.value.trim();
  const value = v.value.trim();
  if (!name) return;

  try {
    const r = await api("/api/cvar", { name, value });
    appendOut("> " + name + " " + value + "\n" + (r.out || "OK"));
    clearInputs(["cvarName", "cvarValue"]);
  } finally {
    refreshHttpLogs({ force: true }).catch(() => {});
  }
}

async function runPresetCommand(btn) {
  const command = String(btn?.dataset?.command || "").trim();
  const commands = command
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!commands.length) return;

  if (!btn.dataset.presetKey && commands.length === 1) {
    const n = $("cvarName"), v = $("cvarValue");
    if (!n || !v) return;
    n.value = btn.dataset.cvar || "";
    v.value = btn.dataset.val || "";
    await setCvar();
    return;
  }

  try {
    const output = [];
    for (const item of commands) {
      const r = await api("/api/command", { command: item });
      output.push("> " + item + "\n" + (r.out || "OK"));
    }
    appendOut(output.join("\n"));
  } finally {
    refreshHttpLogs({ force: true }).catch(() => {});
  }
}

async function sendCmd() {
  const c = $("cmd");
  if (!c) return;

  const command = c.value.trim();
  if (!command) return;

  try {
    const r = await api("/api/command", { command });
    appendOut("> " + command + "\n" + (r.out || "OK"));
    clearInputs(["cmd"]);
  } finally {
    const ac = $("ac");
    if (ac) ac.style.display = "none";
    refreshHttpLogs({ force: true }).catch(() => {});
  }
}

async function loadMaps() {
  const wrap = $("maps");
  if (!wrap) return;

  const m = await apiGet("/api/maps");
  wrap.innerHTML = "";

  (m.standard || []).forEach((map) => {
    const tile = document.createElement("div");
    tile.className = "map-tile";
    tile.dataset.fullName = map;
    tile.dataset.preview = map;
    tile.setAttribute("aria-label", map);

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
    sub.textContent = t("map.standard");

    meta.appendChild(name);
    meta.appendChild(sub);

    tile.appendChild(thumb);
    tile.appendChild(meta);

    tile.addEventListener("click", async () => {
      try {
        const r = await api("/api/map/standard", { map });
        appendOut("> changelevel " + map + "\n" + (r.out || "OK"));
      } finally {
        refreshHttpLogs({ force: true }).catch(() => {});
      }
    });

    wrap.appendChild(tile);
  });
}

async function workshopStart() {
  const wid = $("workshopId");
  if (!wid) return;

  const id = wid.value.trim();
  if (!id) return;

  try {
    const r = await api("/api/map/workshop", { id });
    appendOut("> host_workshop_map " + id + "\n" + (r.out || "OK"));
    clearInputs(["workshopId", "workshopName"]);
  } finally {
    refreshHttpLogs({ force: true }).catch(() => {});
  }
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

  logLineBuffer.push(line);
  if (logLineBuffer.length > MAX_VISIBLE_LOG_LINES) {
    logLineBuffer.splice(0, logLineBuffer.length - MAX_VISIBLE_LOG_LINES);
  }
  box.textContent = logLineBuffer.join("\n") + "\n";
  box.scrollTop = box.scrollHeight;
}

function pruneSeenLogs() {
  if (seenLogSeqs.size > 1200) {
    const recent = Array.from(seenLogSeqs).slice(-600);
    seenLogSeqs.clear();
    recent.forEach((seq) => seenLogSeqs.add(seq));
  }
  if (seenLogFingerprints.size > 1200) {
    const recent = Array.from(seenLogFingerprints).slice(-600);
    seenLogFingerprints.clear();
    recent.forEach((fp) => seenLogFingerprints.add(fp));
  }
}

function sourceLabel(source) {
  if (source === "http") return t("logs.httpRemote");
  if (source === "docker") return t("logs.docker");
  if (source === "none") return t("logs.disabled");
  return source || "-";
}

function formatAgo(ts) {
  if (!ts) return "-";
  const diff = Math.max(0, Date.now() - Number(ts));
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return t("logs.justNow");
  if (sec < 60) return t("logs.secondsAgo", { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t("logs.minutesAgo", { n: min });
  const hour = Math.floor(min / 60);
  return t("logs.hoursAgo", { n: hour });
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function receiveStateFromStatus(status) {
  const mode = status?.sourceMode || latestLogStatus?.source || "";
  if (mode === "none") return "OFFLINE";
  if (status?.lastReceivedAt) return "LIVE";
  return "WAITING";
}

function renderLogStatus(payload) {
  if (!payload) return;
  latestLogStatus = payload;
  const stats = payload.stats || payload;
  const source = payload.source || stats.sourceMode;
  const state = receiveStateFromStatus(stats);

  setText("logSourceText", sourceLabel(source));
  setText("logReceiveState", state);
  setText("logLastReceived", formatAgo(stats.lastReceivedAt));
  setText("logClientCount", String(stats.clientCount ?? 0));
  setText("logTotalLines", String(stats.totalLines ?? 0));
  setText("logPublicUrl", payload.receiver?.publicUrlMasked || "-");

  if (source === "none") setLogBadge("offline");
  else if (state === "LIVE") setLogBadge("live");
  else setLogBadge("reconnecting");
}

function handleLogItem(item) {
  const line = typeof item === "string" ? item : item?.line || "";
  if (!line) return;
  const seq = Number(typeof item === "string" ? 0 : item?.seq || 0);

  if (Number.isFinite(seq) && seq > 0) {
    lastLogSeq = Math.max(lastLogSeq, seq);
    if (seq <= clearedBeforeSeq || seenLogSeqs.has(seq)) return;
    seenLogSeqs.add(seq);
  } else {
    const fp = `${typeof item === "string" ? "" : item?.ts || ""}:${line}`;
    if (seenLogFingerprints.has(fp)) return;
    seenLogFingerprints.add(fp);
  }

  const hit = parseSteamValidatedLine(line);
  if (hit) {
    if (Number.isFinite(hit.userid)) steamByUserId.set(hit.userid, hit.steam64);
    if (hit.name) steamByName.set(String(hit.name).toLowerCase(), hit.steam64);

    mergeSteamIntoPlayers();
    renderPlayers();
  }

  addLogLine(line);
  pruneSeenLogs();
}

async function loadLogStatus() {
  const data = await apiGet("/api/logs/status");
  renderLogStatus(data);
  return data;
}

async function refreshHttpLogs({ force = false } = {}) {
  if (logRefreshInFlight && !force) return null;
  logRefreshInFlight = true;
  try {
    const since = Math.max(lastLogSeq, clearedBeforeSeq);
    const data = await apiGet(`/api/logs/recent?since=${encodeURIComponent(String(since))}`);
    renderLogStatus(data);
    const lines = Array.isArray(data.lines) ? data.lines : [];
    for (const item of lines) handleLogItem(item);
    const maxSeq = Number(data.stats?.maxSeq || 0);
    if (Number.isFinite(maxSeq)) lastLogSeq = Math.max(lastLogSeq, maxSeq);
    return data;
  } finally {
    logRefreshInFlight = false;
  }
}

function scheduleHttpLogPoll(delay = document.hidden ? HTTP_LOG_POLL_HIDDEN_MS : HTTP_LOG_POLL_VISIBLE_MS) {
  clearTimeout(logPollTimer);
  logPollTimer = setTimeout(async () => {
    try {
      await refreshHttpLogs();
    } catch {}
    scheduleHttpLogPoll();
  }, delay);
}

function clearHttpLogsView() {
  const maxSeq = Number(latestLogStatus?.stats?.maxSeq || 0);
  clearedBeforeSeq = Math.max(clearedBeforeSeq, lastLogSeq, Number.isFinite(maxSeq) ? maxSeq : 0);
  lastLogSeq = Math.max(lastLogSeq, clearedBeforeSeq);
  seenLogSeqs.clear();
  seenLogFingerprints.clear();
  logLineBuffer.length = 0;
  const box = $("logbox");
  if (box) box.textContent = "";
}

async function postLogAction(path, label) {
  try {
    const data = await api(path, {});
    const lines = [`> ${label}`];
    if (Array.isArray(data.commands)) {
      for (const item of data.commands) {
        const state = item.ok ? "OK" : "ERROR";
        const warning = item.warning ? " warning" : "";
        lines.push(`${state}${warning}: ${item.command}`);
        if (item.out) lines.push(String(item.out));
      }
    } else if (data.stats) {
      lines.push(`OK: total logs ${data.stats.totalLines ?? 0}`);
    } else {
      lines.push(data.ok ? "OK" : "ERROR");
    }
    appendOut(lines.join("\n"));
    await loadLogStatus().catch(() => {});
  } finally {
    await refreshHttpLogs({ force: true }).catch(() => {});
  }
}

async function logout() {
  await fetch(appPath("/logout"), { method: "POST" }).catch(() => {});
  window.location.href = appPath("/login");
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

  const text = state === "live" ? "LIVE" : state === "offline" ? "OFFLINE" : "WAITING";
  const color =
    state === "live" ? "rgba(34,197,94,0.95)" :
    state === "offline" ? "rgba(239,68,68,0.95)" :
    "rgba(245,158,11,0.95)";

  b.innerHTML = `${text}<span class="log-dot" style="width:10px;height:10px;border-radius:999px;display:inline-block;background:${color};"></span>`;
  b.style.display = "inline-flex";
  b.style.alignItems = "center";
  b.style.gap = "8px";
  b.style.borderColor = color;
  b.style.color = color;
  b.classList.toggle("pulse", state === "live");
}

function startLogs() {
  stopLogs(); // immer nur 1 Verbindung
  ensureLogBadgeAndControls();
  setLogBadge("reconnecting");
  scheduleHttpLogPoll(HTTP_LOG_POLL_VISIBLE_MS);

  try {
    logEventSource = new EventSource(appPath("/api/logs/stream"));
  } catch (e) {
    logEventSource = null;
    setLogBadge("offline");
    softErr(t("logs.eventSourceError"), e);
    return;
  }

  logEventSource.onopen = () => {
    setLogBadge("reconnecting");
    loadLogStatus().catch(() => {});
    refreshHttpLogs({ force: true }).catch(() => {});
  };

  logEventSource.onmessage = (e) => {
    handleLogItem(e.data || "");
  };

  logEventSource.addEventListener("log", (e) => {
    const item = JSON.parse(e.data || "{}");
    handleLogItem(item);
  });

  logEventSource.addEventListener("status", (e) => {
    const stats = JSON.parse(e.data || "{}");
    renderLogStatus({ ...(latestLogStatus || {}), source: stats.sourceMode, stats });
  });

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
  if (logPollTimer) {
    clearTimeout(logPollTimer);
    logPollTimer = null;
  }
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

async function clearLogs() {
  clearHttpLogsView();
  try {
    await api("/api/logs/clear", {});
    await loadLogStatus().catch(() => {});
  } catch (e) {
    softErr(t("errors.testLog"), e);
  }
}

// sauber beenden
function closeStreams() {
  if (logPollTimer) clearTimeout(logPollTimer);
  logPollTimer = null;
  try { logEventSource?.close(); } catch {}
  logEventSource = null;
}
window.addEventListener("beforeunload", closeStreams);
window.addEventListener("pagehide", closeStreams);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshHttpLogs({ force: true }).catch(() => {});
    loadPlayers().catch(() => {});
  }
  scheduleHttpLogPoll(document.hidden ? HTTP_LOG_POLL_HIDDEN_MS : 0);
});

/* ===== Bindings ===== */
function bindUI() {
  on("themeToggle", "click", toggleTheme);
  on("localeSelect", "change", (e) => setLocale(e.target.value));
  document.querySelectorAll(".locale-option").forEach((btn) => {
    btn.addEventListener("click", () => setLocale(btn.dataset.locale));
  });
  on("logoutBtn", "click", () => logout());

  on("cvarSet", "click", () => setCvar().catch((e) => softErr(t("errors.cvar"), e)));
  document.querySelectorAll(".pill").forEach((btn) => {
    const commandPreview = btn.dataset.command || `${btn.dataset.cvar || ""} ${btn.dataset.val || ""}`.trim();
    btn.dataset.command = commandPreview;
    btn.dataset.preview = commandPreview;
    btn.removeAttribute("title");
    btn.addEventListener("click", () => {
      runPresetCommand(btn).catch((e) => softErr(t("errors.cvar"), e));
    });
  });

  on("wsStart", "click", () => workshopStart().catch((e) => softErr(t("errors.workshop"), e)));
  on("wsSave", "click", () => { saveWorkshopFromInput(); });
  on("wsClear", "click", clearWorkshopSaved);

  on("playersReload", "click", () => loadPlayers().catch(() => {}));
  on("playerSearch", "input", () => {
    playersPage = 1;
    renderPlayers();
  });

  on("cmdSend", "click", () => sendCmd().catch((e) => softErr(t("errors.command"), e)));
  on("rconClear", "click", clearRconOutput);
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
  const rconToggle = $("rconToggle");
  if (rconToggle) {
    rconToggle.checked = !!showRconLogs;
    rconToggle.addEventListener("change", () => {
      showRconLogs = !!rconToggle.checked;
      try { localStorage.setItem(SHOW_RCON_KEY, showRconLogs ? "1" : "0"); } catch {}
    });
  }
  on("logRegisterHttp", "click", () => postLogAction("/api/logs/register-http", t("logs.registerAction")).catch((e) => softErr(t("errors.registerLog"), e)));
  on("logUnregisterHttp", "click", () => postLogAction("/api/logs/unregister-http", t("logs.unregisterAction")).catch((e) => softErr(t("errors.unregisterLog"), e)));
  on("logTest", "click", () => postLogAction("/api/logs/test", t("logs.testAction")).catch((e) => softErr(t("errors.testLog"), e)));
  on("logRefreshStatus", "click", async () => {
    try {
      await loadLogStatus();
    } catch (e) {
      softErr(t("errors.logStatus"), e);
    } finally {
      refreshHttpLogs({ force: true }).catch(() => {});
    }
  });
}

/* ===== Init ===== */
document.addEventListener("DOMContentLoaded", async () => {
  try {
    setupCvarPresetDrag();
    applyCvarPresetOrder();
    applyI18n();
    initTheme();
    setupHoverPreview();
    bindUI();
    renderWorkshopSaved();

    loadMaps().catch((e) => softErr(t("errors.maps"), e));
    loadPlayers().catch(() => {});
    startPlayersAutoSync();

    // Badge + Toggle bauen + Logs autostarten
    ensureLogBadgeAndControls();
    loadLogStatus().catch(() => {});
    startLogs();

    appendOut("> " + t("console.ready"));
  } catch (e) {
    softErr(t("errors.init"), e);
  }
});
