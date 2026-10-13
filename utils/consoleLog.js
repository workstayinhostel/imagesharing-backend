const COLORS = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
};

function consoleLog(level, scope, message) {
  const color = level === 'error' ? COLORS.red : level === 'warn' ? COLORS.yellow : COLORS.green;
  const label = level === 'error' ? 'ERR' : level === 'warn' ? 'WARN' : 'OK';
  const output = `${color}[${label}]${COLORS.reset} ${COLORS.cyan}[${scope}]${COLORS.reset} ${message}`;
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

module.exports = consoleLog;
