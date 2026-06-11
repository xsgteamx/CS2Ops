import { spawn } from 'child_process';

export function startDockerLogSource({
  container,
  lines = 200,
  logHub,
  steamTracker,
} = {}) {
  let proc = null;

  function pushLine(line, source = 'docker') {
    if (!line) return;
    steamTracker?.noteFromLogLine(line);
    logHub.push(line, { source });
  }

  function start() {
    if (proc) return proc;
    if (!container) {
      logHub.push('[docker log source disabled: DOCKER_CONTAINER is empty]', { source: 'system' });
      return null;
    }

    proc = spawn('docker', ['logs', '-f', '--tail', String(lines), container], {
      windowsHide: true,
    });

    proc.stdout.on('data', (buf) => {
      buf.toString('utf8').split(/\r?\n/).forEach((line) => pushLine(line));
    });

    proc.stderr.on('data', (buf) => {
      buf.toString('utf8').split(/\r?\n/).forEach((line) => {
        if (line) pushLine('[stderr] ' + line);
      });
    });

    proc.on('error', (err) => {
      logHub.push(`[docker log source error] ${err?.message || err}`, { source: 'system' });
    });

    proc.on('close', () => {
      proc = null;
      logHub.push('[log stream stopped]', { source: 'system' });
    });

    return proc;
  }

  function stop() {
    if (!proc) return;
    try {
      proc.kill();
    } catch {}
    proc = null;
  }

  return { start, stop, getProcess: () => proc };
}
