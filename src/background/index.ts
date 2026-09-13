import { logger } from "../shared/logger";
import { DAILY_QUOTA_LIMIT } from "../shared/constants";
import { getUserPreferences } from "../shared/preferences";
import type { BackgroundMessage, BackgroundResponse } from "../shared/messages";
import type { Video } from "../shared/types";
import {
  clearAllData,
  getAccountList,
  getActiveAccountId,
  getActiveDb,
  getIndexState,
  getQuotaUsedToday,
  getRecentLogs,
} from "../storage/db";
import { addNewAccount, switchToAccount } from "./account-switcher";
import { runFullIndex, runIncrementalRefresh } from "./indexer";
import { handleSyncAlarm, registerSyncAlarm } from "./sync";

const SOURCE = "background";

chrome.runtime.onInstalled.addListener((details) => {
  registerSyncAlarm();
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
  }
});
registerSyncAlarm();

chrome.alarms.onAlarm.addListener((alarm) => void handleSyncAlarm(alarm));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (!isBackgroundMessage(message)) return false;
  void handleMessage(message, sendResponse);
  return true; // keep the sendResponse channel open for the async response
});

function isBackgroundMessage(msg: unknown): msg is BackgroundMessage {
  return typeof msg === "object" && msg !== null && typeof (msg as { type?: unknown }).type === "string";
}

async function handleMessage(
  message: BackgroundMessage,
  sendResponse: (response: BackgroundResponse) => void
): Promise<void> {
  try {
    switch (message.type) {
      case "START_INDEX": {
        const current = await getIndexState();
        if (current.status !== "indexing") {
          const activeAccountId = await getActiveAccountId();
          void runFullIndex(activeAccountId ?? undefined);
        }
        const state = await getIndexState();
        sendResponse({ type: "INDEX_STATE", state, activeAccountId: await getActiveAccountId() });
        return;
      }

      case "GET_INDEX_STATE": {
        const state = await getIndexState();
        sendResponse({ type: "INDEX_STATE", state, activeAccountId: await getActiveAccountId() });
        return;
      }

      case "GET_VIDEOS": {
        const db = await getActiveDb();
        const videos = db ? ((await db.table("videos").toArray()) as Video[]) : [];
        const state = await getIndexState();
        sendResponse({ type: "VIDEOS", videos, state });
        return;
      }

      case "GET_QUOTA_STATUS": {
        const used = await getQuotaUsedToday();
        sendResponse({
          type: "QUOTA_STATUS",
          used,
          limit: DAILY_QUOTA_LIMIT,
          remaining: Math.max(0, DAILY_QUOTA_LIMIT - used),
        });
        return;
      }

      case "GET_DEBUG_LOG": {
        const entries = await getRecentLogs(100);
        sendResponse({ type: "DEBUG_LOG", entries });
        return;
      }

      case "CLEAR_INDEX": {
        await clearAllData();
        sendResponse({ type: "OK" });
        return;
      }

      case "GET_ACCOUNTS": {
        const accounts = await getAccountList();
        sendResponse({ type: "ACCOUNTS", accounts, activeAccountId: await getActiveAccountId() });
        return;
      }

      case "SWITCH_ACCOUNT": {
        const result = await switchToAccount(message.accountId);
        sendResponse({ type: "SWITCH_ACCOUNT_RESULT", ...result });
        return;
      }

      case "ADD_ACCOUNT":
      case "RE_AUTH": {
        const result = await addNewAccount();
        sendResponse(
          result.ok
            ? { type: "ADD_ACCOUNT_RESULT", ok: true, account: result.value }
            : { type: "ADD_ACCOUNT_RESULT", ok: false, error: result.error }
        );
        return;
      }

      case "FORCE_INCREMENTAL_REFRESH": {
        const prefs = await getUserPreferences();
        void runIncrementalRefresh(prefs.videosPerChannel);
        sendResponse({ type: "OK" });
        return;
      }

      default:
        sendResponse({ type: "ERROR", message: "Unknown message type" });
    }
  } catch (err) {
    logger.error(SOURCE, "handleMessage threw", { type: message.type, err: String(err) });
    sendResponse({ type: "ERROR", message: String(err) });
  }
}
