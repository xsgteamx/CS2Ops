export class LogHub {
  constructor({ maxLines = 200, sourceMode = 'docker' } = {}) {
    this.maxLines = Math.max(0, Number(maxLines || 200));
    this.sourceMode = sourceMode;
    this.lines = [];
    this.clients = new Set();
    this.totalLines = 0;
    this.lastReceivedAt = null;
    this.heartbeat = setInterval(() => this.sendHeartbeat(), 15000);
    this.heartbeat.unref?.();
  }

  push(line, meta = {}) {
    const cleanLine = String(line || '').replace(/\r?\n/g, ' ').trim();
    if (!cleanLine) return null;

    const item = {
      ts: Date.now(),
      line: cleanLine,
      source: meta.source || this.sourceMode || 'system',
    };
    if (meta.remoteAddress) item.remoteAddress = meta.remoteAddress;

    this.totalLines += 1;
    this.lastReceivedAt = item.ts;
    this.lines.push(item);
    if (this.maxLines && this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(this.lines.length - this.maxLines);
    }

    this.broadcast('log', item);
    this.broadcast('status', this.getStatus());
    return item;
  }

  getRecentLines() {
    return [...this.lines];
  }

  subscribe(res) {
    this.clients.add(res);

    for (const line of this.lines) {
      this.send(res, 'log', line);
    }
    this.send(res, 'status', this.getStatus());

    return () => {
      this.clients.delete(res);
    };
  }

  getStatus() {
    return {
      sourceMode: this.sourceMode,
      totalLines: this.totalLines,
      lastReceivedAt: this.lastReceivedAt,
      clientCount: this.clients.size,
      recentLines: this.lines.length,
    };
  }

  broadcast(event, data) {
    for (const client of this.clients) {
      this.send(client, event, data);
    }
  }

  send(res, event, data) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {}
  }

  sendHeartbeat() {
    for (const client of this.clients) {
      try {
        client.write(`: hb ${Date.now()}\n\n`);
      } catch {}
    }
  }
}
