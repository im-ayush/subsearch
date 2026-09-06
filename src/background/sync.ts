import { logger } from "../shared/logger";
import { getUserPreferences } from "../shared/preferences";
import { ALARM_SYNC, SYNC_INTERVAL_MINUTES } from "../shared/constants";
import { getActiveAccountId, getIndexState } from "../storage/db";
import { runIncrementalRefresh } from "./indexer";

const SOURCE = "sync";

export function registerSyncAlarm(): void {
  chrome.alarms.get(ALARM_SYNC, (existing) => {
    if (existing) return;
    chrome.alarms.create(ALARM_SYNC, {
      delayInMinutes: SYNC_INTERVAL_MINUTES,
      periodInMinutes: SYNC_INTERVAL_MINUTES,
    });
  });
}

export async function handleSyncAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  if (alarm.name !== ALARM_SYNC) return;

  const activeAccountId = await getActiveAccountId();
  if (!activeAccountId) return;

  const state = await getIndexState();
  if (state.status === "indexing") return;
  if (!state.lastFullIndexAt) return;

  try {
    const prefs = await getUserPreferences();
    await runIncrementalRefresh(prefs.videosPerChannel);
  } catch (err) {
    logger.error(SOURCE, "handleSyncAlarm failed", { err: String(err) });
  }
}
