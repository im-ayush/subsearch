import { LOG_KEEP_ERROR, LOG_KEEP_INFO, LOG_KEEP_WARN } from "./constants";
import type { LogEntry, LogLevel } from "./types";

export const IS_DEV = (() => {
  try {
    return !("update_url" in chrome.runtime.getManifest());
  } catch {
    return true;
  }
})();

type PersistFn = (entry: LogEntry) => Promise<void>;
type PruneLogsFn = (level: LogLevel) => Promise<void>;

let _persistFn: PersistFn | null = null;
let _pruneLogsFn: PruneLogsFn | null = null;

/** Wires the logger to IndexedDB persistence. Called once at background module load. */
export function initLogger(persist: PersistFn, pruneLogs: PruneLogsFn): void {
  _persistFn = persist;
  _pruneLogsFn = pruneLogs;
}

async function persistLog(entry: LogEntry): Promise<void> {
  if (!_persistFn) return;
  try {
    await _persistFn(entry);
    if (_pruneLogsFn) await _pruneLogsFn(entry.level);
  } catch {
    // Logging must never throw.
  }
}

function makeEntry(level: LogLevel, source: string, message: string, context?: unknown): LogEntry {
  return { level, source, message, context, timestamp: Date.now() };
}

export const logger = {
  debug(source: string, msg: string, ctx?: unknown): void {
    if (!IS_DEV) return;
    console.debug(`[SubSearch:${source}]`, msg, ctx ?? "");
  },
  info(source: string, msg: string, ctx?: unknown): void {
    console.info(`[SubSearch:${source}]`, msg, ctx ?? "");
    void persistLog(makeEntry("info", source, msg, ctx));
  },
  warn(source: string, msg: string, ctx?: unknown): void {
    console.warn(`[SubSearch:${source}]`, msg, ctx ?? "");
    void persistLog(makeEntry("warn", source, msg, ctx));
  },
  error(source: string, msg: string, ctx?: unknown): void {
    console.error(`[SubSearch:${source}]`, msg, ctx ?? "");
    void persistLog(makeEntry("error", source, msg, ctx));
  },
};

export const LOG_LIMITS: Record<LogLevel, number> = {
  debug: 0,
  info: LOG_KEEP_INFO,
  warn: LOG_KEEP_WARN,
  error: LOG_KEEP_ERROR,
};
