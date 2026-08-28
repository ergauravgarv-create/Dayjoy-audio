const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

function emit(level, scope, message, fields) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString().slice(11, 23);
  let line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (fields && Object.keys(fields).length) {
    line += ' ' + Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
  }
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

/** A logger bound to one subsystem, so every line says where it came from. */
export function logger(scope) {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
  };
}
