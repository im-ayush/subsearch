import type { Account, ChannelSummary, IndexState, LogEntry, Video } from "./types";

/** Requests sent popup/content → background via chrome.runtime.sendMessage. */
export type BackgroundMessage =
  | { type: "START_INDEX" }
  | { type: "GET_CHANNELS" }
  | { type: "SET_PINNED_CHANNELS"; channelIds: string[] }
  | { type: "OPEN_SETTINGS"; section?: "pinned" }
  | { type: "GET_INDEX_STATE" }
  | { type: "GET_VIDEOS" }
  | { type: "GET_QUOTA_STATUS" }
  | { type: "GET_DEBUG_LOG" }
  | { type: "CLEAR_INDEX" }
  | { type: "GET_ACCOUNTS" }
  | { type: "SWITCH_ACCOUNT"; accountId: string }
  | { type: "ADD_ACCOUNT" }
  | { type: "RE_AUTH" }
  | { type: "FORCE_INCREMENTAL_REFRESH" };

/** Responses sent background → popup/content in reply to a BackgroundMessage. */
export type BackgroundResponse =
  | { type: "INDEX_STATE"; state: IndexState; activeAccountId: string | null; pinnedCount: number }
  | { type: "VIDEOS"; videos: Video[]; state: IndexState; pinnedChannelIds: string[] }
  | { type: "CHANNELS"; channels: ChannelSummary[]; accountEmail: string | null; maxPinned: number }
  | { type: "QUOTA_STATUS"; used: number; limit: number; remaining: number }
  | { type: "DEBUG_LOG"; entries: LogEntry[] }
  | { type: "OK" }
  | { type: "ACCOUNTS"; accounts: Account[]; activeAccountId: string | null }
  | { type: "ADD_ACCOUNT_RESULT"; ok: boolean; account?: Account; error?: string }
  | {
      type: "SWITCH_ACCOUNT_RESULT";
      ok: boolean;
      error?: string;
      accountId?: string;
      needsAuth?: boolean;
      account?: Account;
    }
  | { type: "ERROR"; message: string };

/** Fire-and-forget push from background to content scripts via chrome.tabs.sendMessage. */
export type TabMessage = { type: "INDEX_COMPLETE" };
