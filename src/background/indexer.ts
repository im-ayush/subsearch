import type Dexie from "dexie";
import { logger } from "../shared/logger";
import { getUserPreferences } from "../shared/preferences";
import {
  CONCURRENT_FETCHES,
  DAILY_QUOTA_LIMIT,
  DEEP_MAX_VIDEOS_PER_CHANNEL,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_VIDEOS_PER_CHANNEL,
  FRESHNESS_RECENT_DAYS,
  MAX_VIDEOS_PER_CHANNEL,
  MIN_VIDEOS_PER_CHANNEL,
  QUOTA_ABORT_THRESHOLD,
  QUOTA_WARN_THRESHOLD,
} from "../shared/constants";
import {
  getActiveAccountId,
  getActiveDb,
  getIndexState,
  getPinnedChannelIds,
  getQuotaUsedToday,
  setActiveAccountId,
  updateIndexState,
  upsertAccount,
} from "../storage/db";
import { fetchAccountInfo, getAuthToken, getTokenForAccount } from "./auth";
import { fetchSubscriptions, fetchUploadsPlaylistIds, fetchVideosForChannel, makeTokenRefresher } from "./api";
import type { Channel, IndexState, Video } from "../shared/types";
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

function deepWindowStart(): string {
  return new Date(Date.now() - DEFAULT_MAX_AGE_DAYS * DAY_MS).toISOString();
}

/** Pinned channels get the full time window; everything else gets the baseline count. */
function fetchOptionsFor(channelId: string, pinned: Set<string>, videosPerChannel: number) {
  return pinned.has(channelId)
    ? { maxVideos: DEEP_MAX_VIDEOS_PER_CHANNEL, publishedAfter: deepWindowStart() }
    : { maxVideos: videosPerChannel };
}

async function runSinglePhase(
  channels: Channel[],
  token: string,
  onTokenExpired: (token: string) => Promise<string | null>,
  videosPerChannel: number,
  pinned: Set<string>,
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

    const result = await fetchVideosForChannel(
      token,
      channel,
      fetchOptionsFor(channel.id, pinned, videosPerChannel),
      onTokenExpired
    );
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
async function acquireToken(accountId: string | undefined, context: string): Promise<string | null> {
  if (accountId) {
    const silent = await getTokenForAccount(accountId, context);
    if (silent.ok) return silent.value.token;
  }
  const interactive = await getAuthToken(true);
  if (!interactive.ok) {
    logger.error(SOURCE, `${context}: auth failed`, { error: interactive.error });
    return null;
  }
  return interactive.value.token;
}

export async function runFullIndex(targetAccountId?: string): Promise<void> {
  try {
    const token = await acquireToken(targetAccountId, "runFullIndex");
    if (!token) {
      await updateIndexState({ status: "error" });
      return;
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
    const videosPerChannel = Math.max(
      MIN_VIDEOS_PER_CHANNEL,
      Math.min(MAX_VIDEOS_PER_CHANNEL, prefs.videosPerChannel || DEFAULT_VIDEOS_PER_CHANNEL)
    );

    const state = await getIndexState();
    if (state.status === "completed" && state.lastProcessedChannelId === null) {
      return;
    }

    const pinned = new Set(await getPinnedChannelIds(accountInfo.id));
    await runSinglePhase(channels, token, onTokenExpired, videosPerChannel, pinned, state);
  } catch (err) {
    logger.error(SOURCE, "runFullIndex threw", { err: String(err) });
    await updateIndexState({ status: "error" });
  }
}

async function trimChannelToBaseline(db: Dexie, channelId: string, keep: number): Promise<void> {
  const videos = (await db.table("videos").where("channelId").equals(channelId).toArray()) as Video[];
  if (videos.length <= keep) return;
  videos.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  await db.table("videos").bulkDelete(videos.slice(keep).map((v) => v.id));
}

/**
 * Backfills full history for newly pinned channels and trims newly unpinned
 * ones back to the baseline count. Progress goes to the `deep*` state fields
 * so the baseline counters and lastFullIndexAt are never disturbed.
 */
export async function applyPinChanges(added: string[], removed: string[]): Promise<void> {
  const accountId = await getActiveAccountId();
  const db = await getActiveDb();
  if (!accountId || !db) return;

  const prefs = await getUserPreferences();
  const videosPerChannel = Math.max(
    MIN_VIDEOS_PER_CHANNEL,
    Math.min(MAX_VIDEOS_PER_CHANNEL, prefs.videosPerChannel || DEFAULT_VIDEOS_PER_CHANNEL)
  );

  const state = await getIndexState();
  const startDeep = added.length > 0 && state.deepStatus !== "indexing";
  if (added.length > 0 && !startDeep) {
    logger.warn(SOURCE, "deep index already running; new pins will be picked up on the next rebuild", { added });
  }
  // Flip status before anything slow (trims, possibly an interactive sign-in) so
  // a watcher polling for progress never sees a gap and declares us finished early.
  if (startDeep) {
    await updateIndexState({ deepStatus: "indexing", deepProcessedChannels: 0, deepTotalChannels: added.length });
  }

  for (const channelId of removed) {
    await trimChannelToBaseline(db, channelId, videosPerChannel);
  }

  if (!startDeep) {
    await updateIndexState({ totalVideos: await db.table("videos").count() });
    return;
  }

  try {
    const token = await acquireToken(accountId, "applyPinChanges");
    if (!token) {
      await updateIndexState({ deepStatus: "error" });
      return;
    }
    const onTokenExpired = makeTokenRefresher(accountId);

    const channels = ((await db.table("channels").bulkGet(added)) as (Channel | undefined)[]).filter(
      (c): c is Channel => c !== undefined
    );
    await updateIndexState({ deepTotalChannels: channels.length });

    let processed = 0;
    let failed = false;
    await withConcurrency(channels, CONCURRENT_FETCHES, async (channel, abort) => {
      if ((await checkQuota()) === "abort") {
        logger.warn(SOURCE, "quota abort threshold reached, stopping deep index", { channelId: channel.id });
        failed = true;
        abort();
        return;
      }

      const result = await fetchVideosForChannel(
        token,
        channel,
        { maxVideos: DEEP_MAX_VIDEOS_PER_CHANNEL, publishedAfter: deepWindowStart() },
        onTokenExpired
      );
      if (!result.ok) {
        logger.warn(SOURCE, "deep index failed for channel", { channelId: channel.id, error: result.error });
        failed = true;
      } else {
        await db.table("videos").bulkPut(result.value.videos);
        await db.table("channels").put(channel);
      }

      processed += 1;
      await updateIndexState({ deepProcessedChannels: processed, totalVideos: await db.table("videos").count() });
    });

    await updateIndexState({
      deepStatus: failed ? "error" : "completed",
      lastDeepIndexAt: new Date().toISOString(),
      totalVideos: await db.table("videos").count(),
    });
    await broadcastIndexComplete();
  } catch (err) {
    logger.error(SOURCE, "applyPinChanges threw", { err: String(err) });
    await updateIndexState({ deepStatus: "error" });
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

    const pinned = new Set(await getPinnedChannelIds(activeAccountId));
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

      // Same "since last sync" boundary for everyone; pinned channels just get a higher cap.
      const result = await fetchVideosForChannel(
        token,
        channel,
        { maxVideos: pinned.has(channel.id) ? DEEP_MAX_VIDEOS_PER_CHANNEL : videosPerChannel, publishedAfter },
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
