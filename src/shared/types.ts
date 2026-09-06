export interface Preferences {
  freshnessMonths: number;
  videosPerChannel: number;
  /** Vestigial — superseded by the freshness filter. Not read by any consumer. */
  maxAgeDays?: number;
  overlayEnabled: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  freshnessMonths: 6,
  videosPerChannel: 15,
  maxAgeDays: 1825,
  overlayEnabled: true,
};

export interface Account {
  id: string;
  email: string;
  displayName: string;
  picture: string;
  addedAt: number;
}

export interface Channel {
  id: string;
  title: string;
  uploadsPlaylistId: string;
  lastVideoAt: string;
}

export interface Video {
  id: string;
  title: string;
  channelId: string;
  channelName: string;
  publishedAt: string;
  thumbnailUrl: string;
  description: string;
}

export type IndexStatus = "idle" | "indexing" | "completed" | "error";

export interface IndexState {
  id: 1;
  status: IndexStatus;
  totalChannels: number;
  processedChannels: number;
  totalVideos: number;
  failedChannelIds: string[];
  lastFullIndexAt: string | null;
  lastIncrementalAt: string | null;
  quotaUsedToday: number;
  quotaResetDate: string;
  lastProcessedChannelId: string | null;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  source: string;
  message: string;
  context?: unknown;
  timestamp: number;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; retryable?: boolean };

export interface SearchResult {
  video: Video;
  score: number;
  matchReason: "title" | "channel" | "description";
}
