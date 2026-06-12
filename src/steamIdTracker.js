const STEAM_VALID_RE = /"(.+?)<(\d+)><\[U:1:(\d+)\]><.*?>"\s+STEAM USERID validated/i;
const TEAM_JOIN_RE = /"(.+?)<(\d+)><([^>]*)><([^>]*)>"\s+joined team\s+"([^"]+)"/i;
const PLAYER_TOKEN_RE = /"(.+?)<(\d+)><([^>]*)><([^>]*)>"/;

export function accountIdToSteam64(accountid) {
  const base = 76561197960265728n;
  return (base + BigInt(accountid)).toString();
}

export function normalizeTeam(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'CT' || raw === 'COUNTERTERRORIST' || raw === 'COUNTER-TERRORIST') return 'CT';
  if (raw === 'T' || raw === 'TERRORIST' || raw === 'TERRORISTS') return 'T';
  if (raw === 'SPECTATOR' || raw === 'SPEC') return 'SPEC';
  return null;
}

export class SteamIdTracker {
  constructor({ ttlMs = 60 * 60 * 1000 } = {}) {
    this.ttlMs = Number(ttlMs || 60 * 60 * 1000);
    this.byName = new Map();
  }

  noteFromLogLine(line) {
    const text = String(line || '');
    const teamJoin = text.match(TEAM_JOIN_RE);
    if (teamJoin) {
      const item = this.notePlayer({
        name: teamJoin[1],
        userid: Number(teamJoin[2]),
        uniqueId: teamJoin[3],
        team: normalizeTeam(teamJoin[5] || teamJoin[4]),
      });
      if (item) return item;
    }

    const token = text.match(PLAYER_TOKEN_RE);
    if (token) {
      this.notePlayer({
        name: token[1],
        userid: Number(token[2]),
        uniqueId: token[3],
        team: normalizeTeam(token[4]),
      });
    }

    const m = text.match(STEAM_VALID_RE);
    if (!m) return null;

    const name = m[1];
    const accountid = m[3];
    const steam64 = accountIdToSteam64(accountid);

    return this.notePlayer({
      name,
      accountid,
      steam64,
    });
  }

  notePlayer(update = {}) {
    const name = String(update.name || '').trim();
    if (!name) return null;
    const key = name.toLowerCase();
    const prev = this.byName.get(key) || {};
    const uniqueId = update.uniqueId || prev.uniqueId || null;
    const item = {
      ...prev,
      name,
      userid: Number.isFinite(update.userid) ? update.userid : prev.userid,
      uniqueId,
      accountid: update.accountid || prev.accountid || null,
      steam64: update.steam64 || prev.steam64 || null,
      team: update.team || prev.team || null,
      isBot: Boolean(prev.isBot || /^BOT$/i.test(String(uniqueId || ''))),
      lastSeen: Date.now(),
    };
    this.byName.set(String(name).toLowerCase(), item);
    return item;
  }

  getByName(name) {
    return this.byName.get(String(name || '').toLowerCase()) || null;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, value] of this.byName.entries()) {
      if (!value?.lastSeen || now - value.lastSeen > this.ttlMs) {
        this.byName.delete(key);
      }
    }
  }
}
