import { logger } from "../shared/logger";
import { recordQuotaUsage } from "../storage/db";
import {
  API_PAGE_SIZE,
  MAX_DESCRIPTION_CHARS,
  MAX_RETRY_ATTEMPTS,
  QUOTA_UNITS_CHANNELS_BATCH,
  QUOTA_UNITS_PLAYLIST_ITEMS,
  QUOTA_UNITS_SUBSCRIPTIONS_PAGE,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
} from "../shared/constants";
import { refreshToken } from "./auth";
import type { Channel, Result, Video } from "../shared/types";

const SOURCE = "api";
const YT_BASE = "https://www.googleapis.com/youtube/v3";

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

interface RawSubscriptionItem {
  snippet: { resourceId: { channelId: string }; title: string };
}
function isRawSubscriptionItem(item: unknown): item is RawSubscriptionItem {
  if (!isRecord(item) || !isRecord(item.snippet)) return false;
  const snippet = item.snippet;
  return (
    isRecord(snippet.resourceId) &&
    typeof (snippet.resourceId as Record<string, unknown>).channelId === "string" &&
    typeof snippet.title === "string"
  );
}

interface RawChannelItem {
  id: string;
  contentDetails: { relatedPlaylists: { uploads: string } };
}
function isRawChannelItem(item: unknown): item is RawChannelItem {
  if (!isRecord(item) || typeof item.id !== "string" || !isRecord(item.contentDetails)) return false;
  const relatedPlaylists = (item.contentDetails as Record<string, unknown>).relatedPlaylists;
  return isRecord(relatedPlaylists) && typeof relatedPlaylists.uploads === "string";
}

interface RawPlaylistItem {
  snippet: {
    resourceId: { videoId: string };
    title: string;
    publishedAt: string;
    description: string;
    thumbnails?: { medium?: { url: string }; default?: { url: string } };
    channelId: string;
    channelTitle: string;
  };
}
function isRawPlaylistItem(item: unknown): item is RawPlaylistItem {
  if (!isRecord(item) || !isRecord(item.snippet)) return false;
  const snippet = item.snippet;
  return isRecord(snippet.resourceId) && typeof (snippet.resourceId as Record<string, unknown>).videoId === "string";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientError(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export async function apiFetch<T>(
  url: string,
  opts: { token: string; onTokenExpired?: (token: string) => Promise<string | null> }
): Promise<Result<T>> {
  let token = opts.token;
  let tokenRefreshedOnce = false;

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      logger.warn(SOURCE, "network error", { url, attempt, err: String(err) });
      if (attempt === MAX_RETRY_ATTEMPTS) {
        return { ok: false, error: String(err), retryable: true };
      }
      await delay(Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS));
      continue;
    }

    if (res.ok) {
      return { ok: true, value: (await res.json()) as T };
    }

    if (res.status === 401 && !tokenRefreshedOnce && opts.onTokenExpired) {
      tokenRefreshedOnce = true;
      const newToken = await opts.onTokenExpired(token);
      if (newToken) {
        token = newToken;
        continue;
      }
      return { ok: false, error: "Auth token expired and refresh failed", retryable: false };
    }

    if (res.status === 403) {
      const body = await res.text();
      logger.error(SOURCE, "quota or permission error", { url, body: body.slice(0, 300) });
      return { ok: false, error: `403: ${body.slice(0, 300)}`, retryable: false };
    }

    if (isTransientError(res.status) && attempt < MAX_RETRY_ATTEMPTS) {
      const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
      logger.warn(SOURCE, `transient ${res.status}, retrying`, { url, attempt, backoff });
      await delay(backoff);
      continue;
    }

    const body = await res.text();
    return { ok: false, error: `${res.status}: ${body.slice(0, 300)}`, retryable: isTransientError(res.status) };
  }

  return { ok: false, error: "Max retry attempts exceeded", retryable: true };
}

export async function fetchSubscriptions(
  token: string,
  onTokenExpired?: (token: string) => Promise<string | null>
): Promise<Result<Channel[]>> {
  const channels: Channel[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${YT_BASE}/subscriptions`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", String(API_PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const result = await apiFetch<{ items: unknown[]; nextPageToken?: string }>(url.toString(), {
      token,
      onTokenExpired,
    });
    if (!result.ok) return result;

    await recordQuotaUsage(QUOTA_UNITS_SUBSCRIPTIONS_PAGE);

    for (const item of result.value.items) {
      if (!isRawSubscriptionItem(item)) continue;
      channels.push({
        id: item.snippet.resourceId.channelId,
        title: item.snippet.title,
        uploadsPlaylistId: "",
        lastVideoAt: "",
      });
    }
    pageToken = result.value.nextPageToken;
  } while (pageToken);

  return { ok: true, value: channels };
}

export async function fetchUploadsPlaylistIds(
  token: string,
  channels: Channel[],
  onTokenExpired?: (token: string) => Promise<string | null>
): Promise<Result<Channel[]>> {
  const byId = new Map(channels.map((c) => [c.id, c]));

  for (let i = 0; i < channels.length; i += API_PAGE_SIZE) {
    const batch = channels.slice(i, i + API_PAGE_SIZE);
    const url = new URL(`${YT_BASE}/channels`);
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("id", batch.map((c) => c.id).join(","));

    const result = await apiFetch<{ items: unknown[] }>(url.toString(), { token, onTokenExpired });
    if (!result.ok) return result;

    await recordQuotaUsage(QUOTA_UNITS_CHANNELS_BATCH);

    for (const item of result.value.items) {
      if (!isRawChannelItem(item)) continue;
      const channel = byId.get(item.id);
      if (channel) channel.uploadsPlaylistId = item.contentDetails.relatedPlaylists.uploads;
    }
  }

  return { ok: true, value: channels };
}

export async function fetchVideosForChannel(
  token: string,
  channel: Channel,
  opts: { maxVideos: number; afterPageToken?: string; publishedAfter?: string },
  onTokenExpired?: (token: string) => Promise<string | null>
): Promise<Result<{ videos: Video[]; nextPageToken?: string }>> {
  const videos: Video[] = [];
  let pageToken = opts.afterPageToken;
  let newestPublishedAt = channel.lastVideoAt;

  do {
    const url = new URL(`${YT_BASE}/playlistItems`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("playlistId", channel.uploadsPlaylistId);
    url.searchParams.set("maxResults", String(Math.min(API_PAGE_SIZE, opts.maxVideos - videos.length)));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const result = await apiFetch<{ items: unknown[]; nextPageToken?: string }>(url.toString(), {
      token,
      onTokenExpired,
    });

    if (!result.ok) {
      if (result.error.startsWith("404")) {
        return { ok: true, value: { videos: [] } };
      }
      return result;
    }

    await recordQuotaUsage(QUOTA_UNITS_PLAYLIST_ITEMS);

    for (const item of result.value.items) {
      if (!isRawPlaylistItem(item)) continue;
      const snippet = item.snippet;
      if (opts.publishedAfter && snippet.publishedAt <= opts.publishedAfter) continue;
      videos.push({
        id: snippet.resourceId.videoId,
        title: snippet.title,
        channelId: snippet.channelId || channel.id,
        channelName: snippet.channelTitle || channel.title,
        publishedAt: snippet.publishedAt,
        thumbnailUrl: snippet.thumbnails?.medium?.url ?? snippet.thumbnails?.default?.url ?? "",
        description: snippet.description.slice(0, MAX_DESCRIPTION_CHARS),
      });
      if (!newestPublishedAt || snippet.publishedAt > newestPublishedAt) {
        newestPublishedAt = snippet.publishedAt;
      }
      if (videos.length >= opts.maxVideos) break;
    }

    pageToken = result.value.nextPageToken;
  } while (pageToken && videos.length < opts.maxVideos);

  channel.lastVideoAt = newestPublishedAt;
  return { ok: true, value: { videos, nextPageToken: pageToken } };
}

export function makeTokenRefresher(): (staleToken: string) => Promise<string | null> {
  return async (staleToken: string) => {
    const result = await refreshToken(staleToken);
    return result.ok ? result.value.token : null;
  };
}
