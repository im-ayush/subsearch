import Dexie from "dexie";
import { STORAGE_KEY_ACCOUNTS, STORAGE_KEY_ACTIVE_ACCOUNT, STORAGE_KEY_PINNED_PREFIX } from "../shared/constants";
import { LOG_LIMITS, initLogger } from "../shared/logger";
import type { Account, IndexState, LogEntry, LogLevel } from "../shared/types";

function sanitizeAccountId(accountId: string): string {
  return accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

const dbCache = new Map<string, Dexie>();

export function getAccountDb(accountId: string): Dexie {
  const cached = dbCache.get(accountId);
  if (cached) return cached;

  const db = new Dexie(`SubSearchDB_${sanitizeAccountId(accountId)}`);
  db.version(1).stores({
    channels: "id, title",
    videos: "id, channelId, publishedAt, channelName",
    indexState: "id",
  });
  dbCache.set(accountId, db);
  return db;
}

export const logsDb = new Dexie("SubSearchDB_logs");
logsDb.version(1).stores({
  logs: "++id, level, timestamp, source",
});

let _activeAccountId: string | null = null;

export async function getActiveAccountId(): Promise<string | null> {
  if (_activeAccountId !== null) return _activeAccountId;
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY_ACTIVE_ACCOUNT, (result) => {
      _activeAccountId = (result[STORAGE_KEY_ACTIVE_ACCOUNT] as string | undefined) ?? null;
      resolve(_activeAccountId);
    });
  });
}

export async function setActiveAccountId(accountId: string): Promise<void> {
  _activeAccountId = accountId;
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_ACTIVE_ACCOUNT]: accountId }, () => resolve());
  });
}

export async function getActiveDb(): Promise<Dexie | null> {
  const accountId = await getActiveAccountId();
  if (!accountId) return null;
  return getAccountDb(accountId);
}

export async function getAccountRegistry(): Promise<Record<string, Account>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY_ACCOUNTS, (result) => {
      resolve((result[STORAGE_KEY_ACCOUNTS] as Record<string, Account> | undefined) ?? {});
    });
  });
}

export async function saveAccountRegistry(registry: Record<string, Account>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_ACCOUNTS]: registry }, () => resolve());
  });
}

export async function upsertAccount(account: Account): Promise<void> {
  const registry = await getAccountRegistry();
  registry[account.id] = account;
  await saveAccountRegistry(registry);
}

export async function getAccountList(): Promise<Account[]> {
  const registry = await getAccountRegistry();
  return Object.values(registry);
}

// Pins live in chrome.storage.local rather than on the Channel rows so that a
// rebuild or "Clear index" never wipes what the user chose to pin.
export async function getPinnedChannelIds(accountId: string): Promise<string[]> {
  const key = STORAGE_KEY_PINNED_PREFIX + accountId;
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      const stored = result[key];
      resolve(Array.isArray(stored) ? (stored as string[]) : []);
    });
  });
}

export async function setPinnedChannelIds(accountId: string, channelIds: string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_PINNED_PREFIX + accountId]: channelIds }, () => resolve());
  });
}

export async function persistLogEntry(entry: LogEntry): Promise<void> {
  await logsDb.table("logs").add(entry);
}

export async function pruneLogs(level: LogLevel): Promise<void> {
  const limit = LOG_LIMITS[level];
  if (!limit) return;
  const table = logsDb.table("logs");
  const count = await table.where("level").equals(level).count();
  const overflow = count - limit;
  if (overflow <= 0) return;
  const stale = await table.where("level").equals(level).sortBy("timestamp");
  const staleIds = stale.slice(0, overflow).map((e: LogEntry & { id: number }) => e.id);
  await table.bulkDelete(staleIds);
}

// Wire the logger to this module's persistence — must run once at background module load.
initLogger(persistLogEntry, pruneLogs);

export const DEFAULT_INDEX_STATE: IndexState = {
  id: 1,
  status: "idle",
  totalChannels: 0,
  processedChannels: 0,
  totalVideos: 0,
  failedChannelIds: [],
  lastFullIndexAt: null,
  lastIncrementalAt: null,
  quotaUsedToday: 0,
  quotaResetDate: todayString(),
  lastProcessedChannelId: null,
  deepStatus: "idle",
  deepProcessedChannels: 0,
  deepTotalChannels: 0,
  lastDeepIndexAt: null,
};

async function readIndexState(db: Dexie): Promise<IndexState> {
  const stored = (await db.table("indexState").get(1)) as Partial<IndexState> | undefined;
  if (!stored) return { ...DEFAULT_INDEX_STATE };
  // Spread over defaults so states written before a field existed still read as complete.
  const state: IndexState = { ...DEFAULT_INDEX_STATE, ...stored };
  if (state.quotaResetDate !== todayString()) {
    const reset = { ...state, quotaUsedToday: 0, quotaResetDate: todayString() };
    await db.table("indexState").put(reset);
    return reset;
  }
  return state;
}

export async function getIndexState(): Promise<IndexState> {
  const db = await getActiveDb();
  if (!db) return { ...DEFAULT_INDEX_STATE };
  return readIndexState(db);
}

export async function updateIndexState(patch: Partial<IndexState>): Promise<void> {
  const db = await getActiveDb();
  if (!db) return;
  const current = await readIndexState(db);
  await db.table("indexState").put({ ...current, ...patch });
}

export async function recordQuotaUsage(units: number): Promise<void> {
  const db = await getActiveDb();
  if (!db) return;
  const current = await readIndexState(db);
  await db.table("indexState").put({ ...current, quotaUsedToday: current.quotaUsedToday + units });
}

export async function getQuotaUsedToday(): Promise<number> {
  const state = await getIndexState();
  return state.quotaUsedToday;
}

export async function getRecentLogs(limit = 100): Promise<LogEntry[]> {
  const entries = await logsDb.table("logs").orderBy("timestamp").reverse().limit(limit).toArray();
  return (entries as LogEntry[]).reverse();
}

export async function clearAllData(): Promise<void> {
  const db = await getActiveDb();
  if (!db) return;
  await db.table("channels").clear();
  await db.table("videos").clear();
  await db.table("indexState").put({ ...DEFAULT_INDEX_STATE, quotaResetDate: todayString() });
}
