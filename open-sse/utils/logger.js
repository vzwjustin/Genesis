// Structured logger module — zero external dependencies
// Reads LOG_LEVEL once at module load; defaults to "info" for unrecognized/missing values.
// Format: [<ISO-8601-UTC>] [<LEVEL>:<tag>] <message>
// debug/info → process.stdout, warn/error → process.stderr
// Never throws, never emits partial output.

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const MAX_TAG_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 4096;

function resolveLevel() {
  try {
    const raw = (process.env.LOG_LEVEL || "").toLowerCase().trim();
    return LEVELS[raw] !== undefined ? LEVELS[raw] : LEVELS.info;
  } catch {
    return LEVELS.info;
  }
}

/**
 * Creates a logger instance respecting LOG_LEVEL env var.
 * @returns {{ debug: (tag: string, message: string) => void, info: (tag: string, message: string) => void, warn: (tag: string, message: string) => void, error: (tag: string, message: string) => void }}
 */
export function createLogger() {
  const threshold = resolveLevel();

  function write(level, levelIndex, stream, tag, message) {
    try {
      if (levelIndex < threshold) return;

      const ts = new Date().toISOString();
      const safeTag = String(tag).slice(0, MAX_TAG_LENGTH);
      const safeMessage = String(message).slice(0, MAX_MESSAGE_LENGTH);
      const line = `[${ts}] [${level}:${safeTag}] ${safeMessage}\n`;

      stream.write(line);
    } catch {
      // Never throw, never emit partial output
    }
  }

  return {
    debug(tag, message) { write("DEBUG", LEVELS.debug, process.stdout, tag, message); },
    info(tag, message) { write("INFO", LEVELS.info, process.stdout, tag, message); },
    warn(tag, message) { write("WARN", LEVELS.warn, process.stderr, tag, message); },
    error(tag, message) { write("ERROR", LEVELS.error, process.stderr, tag, message); },
  };
}

/** Singleton default logger */
export const logger = createLogger();
