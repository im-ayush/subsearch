import { logger } from "../shared/logger";
import { getUserPreferences } from "../shared/preferences";
import {
  CONCURRENT_FETCHES,
  DAILY_QUOTA_LIMIT,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_VIDEOS_PER_CHANNEL,
  FRESHNESS_RECENT_DAYS,
  QUOTA_ABORT_THRESHOLD,
  QUOTA_WARN_THRESHOLD,
} from "../shared/constants";
import {
  getActiveAccountId,
  getActiveDb,
  getIndexState,
  getQuotaUsedToday,
  setActiveAccountId,
  updateIndexState,
  upsertAccount,
} from "../storage/db";
import { fetchAccountInfo, getAuthToken, getTokenForAccount } from "./auth";
import { fetchSubscriptions, fetchUploadsPlaylistIds, fetchVideosForChannel, makeTokenRefresher } from "./api";
import type { Channel, IndexState } from "../shared/types";
import type { TabMessage } from "../shared/messages";

const SOURCE = "indexer";
const DAY_MS = 86400000;

async function broadcastIndexComplete(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  const message: TabMessage = { type: "INDEX_COMPLETE" };
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

export async function checkQuota(): Promise<"ok" | "warn" | "abort"> {
  const used = await getQuotaUsedToday();
  const fraction = used / DAILY_QUOTA_LIMIT;
  if (fraction >= QUOTA_ABORT_THRESHOLD) return "abort";
  if (fraction >= QUOTA_WARN_THRESHOLD) return "warn";
  return "ok";
}

/**
 * Bounded-concurrency work queue. `fn` receives an `abort()` callback — call
 * it to stop remaining queued items from starting (in-flight items still
 * finish). Without this, hitting the quota-abort threshold only skipped the
 * one channel that noticed it, leaving the rest of the queue to run anyway.
 */
async function withConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, abort: () => void) => Promise<void>
): Promise<void> {
  const queue = [...items];
  let aborted = false;
  const abort = () => {
    aborted = true;
  };
  const workerCount = Math.min(concurrency, queue.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!aborted) {
      const item = queue.shift();
      if (item === undefined) break;
      await fn(item, abort);
    }
  });
  await Promise.all(workers);
}

async function runSinglePhase(
  channels: Channel[],
  token: string,
  onTokenExpired: (token: string) => Promise<string | null>,
  videosPerChannel: number,
  state: IndexState
): Promise<void> {
  const db = await getActiveDb();
  if (!db) return;

  const resumeIndex = state.lastProcessedChannelId
    ? channels.findIndex((c) => c.id === state.lastProcessedChannelId) + 1
    : 0;
  const remaining = channels.slice(resumeIndex);

  let processedChannels = state.processedChannels;
  const failedChannelIds = [...state.failedChannelIds];

  await withConcurrency(remaining, CONCURRENT_FETCHES, async (channel, abort) => {
    const quota = await checkQuota();
    if (quota === "abort") {
      logger.warn(SOURCE, "quota abort threshold reached, stopping indexing", { channelId: channel.id });
      abort();
      return;
    }

    const result = await fetchVideosForChannel(token, channel, { maxVideos: videosPerChannel }, onTokenExpired);
    if (!result.ok) {
      logger.warn(SOURCE, "failed to fetch videos for channel", { channelId: channel.id, error: result.error });
      failedChannelIds.push(channel.id);
    } else {
      await db.table("videos").bulkPut(result.value.videos);
    }

    await db.table("channels").put(channel);
    processedChannels += 1;

    await updateIndexState({
      processedChannels,
      totalVideos: await db.table("videos").count(),
      failedChannelIds,
      lastProcessedChannelId: channel.id,
    });
  });

  await updateIndexState({
    status: "completed",
    totalVideos: await db.table("videos").count(),
    lastFullIndexAt: new Date().toISOString(),
    lastProcessedChannelId: null,
  });
  await broadcastIndexComplete();
}

/**
 * `targetAccountId`, if given, is tried silently first so rebuilding a known
 * account's index doesn't prompt when a valid grant already exists for it.
 * The fallback interactive call is deliberately never pinned: pinning an
 * interactive request makes Chrome hard-fail if the user authenticates as a
 * different account than requested — exactly what happens when they're
 * trying to add a second account. Whichever account comes back is accepted;
 * `fetchAccountInfo` below is what actually identifies it.
 */
export async function runFullIndex(targetAccountId?: string): Promise<void> {
  try {
    let token: string | null = null;
    if (targetAccountId) {
      const pinned = await getTokenForAccount(targetAccountId, "runFullIndex");
      if (pinned.ok) token = pinned.value.token;
    }
    if (!token) {
      const interactive = await getAuthToken(true);
      if (!interactive.ok) {
        logger.error(SOURCE, "runFullIndex: auth failed", { error: interactive.error });
        await updateIndexState({ status: "error" });
        return;
      }
      token = interactive.value.token;
    }

    const accountInfo = await fetchAccountInfo(token);
    if (!accountInfo) {
      logger.error(SOURCE, "runFullIndex: could not identify account");
      await updateIndexState({ status: "error" });
      return;
    }

    await upsertAccount({ ...accountInfo, addedAt: Date.now() });
    await setActiveAccountId(accountInfo.id);
    await updateIndexState({ status: "indexing" });

    const onTokenExpired = makeTokenRefresher(accountInfo.id);

    const subsResult = await fetchSubscriptions(token, onTokenExpired);
    if (!subsResult.ok) {
      logger.error(SOURCE, "runFullIndex: fetchSubscriptions failed", { error: subsResult.error });
      await updateIndexState({ status: "error" });
      return;
    }

    const playlistsResult = await fetchUploadsPlaylistIds(token, subsResult.value, onTokenExpired);
    if (!playlistsResult.ok) {
      logger.error(SOURCE, "runFullIndex: fetchUploadsPlaylistIds failed", { error: playlistsResult.error });
      await updateIndexState({ status: "error" });
      return;
    }

    const channels = playlistsResult.value;
    const db = await getActiveDb();
    if (!db) return;
    await db.table("channels").bulkPut(channels);
    await updateIndexState({ totalChannels: channels.length });

    const prefs = await getUserPreferences();
    const videosPerChannel = Math.max(5, Math.min(50, prefs.videosPerChannel || DEFAULT_VIDEOS_PER_CHANNEL));

    const state = await getIndexState();
    if (state.status === "completed" && state.lastProcessedChannelId === null) {
      return;
    }

    await runSinglePhase(channels, token, onTokenExpired, videosPerChannel, state);
  } catch (err) {
    logger.error(SOURCE, "runFullIndex threw", { err: String(err) });
    await updateIndexState({ status: "error" });
  }
}

export async function runIncrementalRefresh(videosPerChannel = DEFAULT_VIDEOS_PER_CHANNEL): Promise<void> {
  const state = await getIndexState();
  if (state.status === "indexing") return;
  if (state.status === "idle" && !state.lastFullIndexAt) {
    await runFullIndex();
    return;
  }

  const activeAccountId = await getActiveAccountId();
  if (!activeAccountId) return;

  try {
    const tokenResult = await getTokenForAccount(activeAccountId, "runIncrementalRefresh");
    if (!tokenResult.ok) {
      logger.warn(SOURCE, "runIncrementalRefresh: auth failed", { error: tokenResult.error });
      return;
    }
    const token = tokenResult.value.token;
    const onTokenExpired = makeTokenRefresher(activeAccountId);

    const db = await getActiveDb();
    if (!db) return;
    const allChannels = (await db.table("channels").toArray()) as Channel[];

    const publishedAfter =
      state.lastIncrementalAt ?? state.lastFullIndexAt ?? new Date(Date.now() - DEFAULT_MAX_AGE_DAYS * DAY_MS).toISOString();

    const activeCutoff = Date.now() - FRESHNESS_RECENT_DAYS * DAY_MS;
    const activeChannels = allChannels.filter(
      (c) => !c.lastVideoAt || new Date(c.lastVideoAt).getTime() >= activeCutoff
    );

    const failedChannelIds = [...state.failedChannelIds];

    await withConcurrency(activeChannels, CONCURRENT_FETCHES, async (channel, abort) => {
      const quota = await checkQuota();
      if (quota === "abort") {
        logger.warn(SOURCE, "quota abort threshold reached, stopping incremental refresh", {
          channelId: channel.id,
        });
        abort();
        return;
      }

      const result = await fetchVideosForChannel(
        token,
        channel,
        { maxVideos: videosPerChannel, publishedAfter },
        onTokenExpired
      );
      if (!result.ok) {
        logger.warn(SOURCE, "incremental refresh failed for channel", {
          channelId: channel.id,
          error: result.error,
        });
        failedChannelIds.push(channel.id);
        return;
      }
      if (result.value.videos.length > 0) {
        await db.table("videos").bulkPut(result.value.videos);
        await db.table("channels").put(channel);
      }
    });

    await updateIndexState({
      lastIncrementalAt: new Date().toISOString(),
      totalVideos: await db.table("videos").count(),
      failedChannelIds,
    });
    await broadcastIndexComplete();
  } catch (err) {
    logger.error(SOURCE, "runIncrementalRefresh threw", { err: String(err) });
  }
}
