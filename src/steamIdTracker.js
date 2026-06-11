const STEAM_VALID_RE = /"(.+?)<(\d+)><\[U:1:(\d+)\]><.*?>"\s+STEAM USERID validated/i;

export function accountIdToSteam64(accountid) {
  const base = 76561197960265728n;
  return (base + BigInt(accountid)).toString();
}

export class SteamIdTracker {
  constructor({ ttlMs = 60 * 60 * 1000 } = {}) {
    this.ttlMs = Number(ttlMs || 60 * 60 * 1000);
    this.byName = new Map();
  }

  noteFromLogLine(line) {
    const m = String(line).match(STEAM_VALID_RE);
    if (!m) return null;

    const name = m[1];
    const accountid = m[3];
    const steam64 = accountIdToSteam64(accountid);

    const item = {
      name,
      accountid,
      steam64,
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
