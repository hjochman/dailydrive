/**
 * logger.js — Central log-level utility for DailyDrive
 *
 * Usage:
 *   const { createLogger } = require('./logger');
 *   const logger = createLogger(logLineFn, 'info');
 *   logger.debug('...'); // suppressed at info level
 *   logger.warn('...');  // emitted
 *
 * Levels (ascending verbosity): error(0) warn(1) info(2) debug(3)
 * Default level: 'info'
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const TAGS   = { error: '[ERROR]', warn: '[WARN] ', info: '[INFO] ', debug: '[DEBUG]' };

/**
 * Create a level-aware logger.
 *
 * @param {Function} logLineFn  - Function that accepts a string and writes it (stdout + file).
 *                                Receives messages at *error* level too (errors are always shown).
 * @param {Function} errorLineFn - Optional separate function for error output. Defaults to logLineFn.
 * @param {string}   levelStr   - Minimum level to emit ('error'|'warn'|'info'|'debug'). Default 'info'.
 * @returns {{ error: Function, warn: Function, info: Function, debug: Function }}
 */
function createLogger(logLineFn, errorLineFn, levelStr) {
  // Allow calling as createLogger(fn, levelStr) with no separate error fn
  if (typeof errorLineFn === 'string') {
    levelStr    = errorLineFn;
    errorLineFn = logLineFn;
  }
  if (typeof errorLineFn !== 'function') errorLineFn = logLineFn;

  const normalized = (levelStr || 'info').toLowerCase().trim();
  const threshold  = LEVELS[normalized];

  if (threshold === undefined) {
    logLineFn(`[WARN]  [logger] Unknown log level "${levelStr}", falling back to "info"`);
  }
  const effective = threshold !== undefined ? threshold : LEVELS.info;

  function emit(level, args) {
    if (LEVELS[level] > effective) return;
    const raw = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    // Strip leading/trailing newlines — logLine adds a timestamp prefix, so embedded
    // newlines would break the line format. Blank separator lines aren't meaningful in log files.
    const msg  = raw.replace(/^\n+/, '').replace(/\n+$/, '');
    if (!msg) return; // skip purely whitespace messages
    const line = `${TAGS[level]} ${msg}`;
    if (level === 'error') {
      errorLineFn(line);
    } else {
      logLineFn(line);
    }
  }

  return {
    error: (...args) => emit('error', args),
    warn:  (...args) => emit('warn',  args),
    info:  (...args) => emit('info',  args),
    debug: (...args) => emit('debug', args),
  };
}

/**
 * Resolve the effective log level string from ENV and config.
 * Priority: process.env.LOG_LEVEL > config.log_level > 'info'
 *
 * @param {object} config - Parsed config.yaml object (may be empty/undefined)
 * @returns {string}
 */
function resolveLogLevel(config) {
  return (process.env.LOG_LEVEL || (config && config.log_level) || 'info').toLowerCase().trim();
}

module.exports = { createLogger, resolveLogLevel, LEVELS };
