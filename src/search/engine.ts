import Fuse, { type FuseResult, type IFuseOptions } from "fuse.js";
import {
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_SEARCH_TOP_K,
  FRESHNESS_RECENT_DAYS,
  FRESHNESS_WEIGHT,
  MIN_RELEVANCE_THRESHOLD,
} from "../shared/constants";
import type { SearchResult, Video } from "../shared/types";

const DAY_MS = 86400000;

const FUSE_OPTIONS: IFuseOptions<Video> = {
  keys: [
    { name: "title", weight: 0.7 },
    { name: "channelName", weight: 0.2 },
    { name: "description", weight: 0.1 },
  ],
  threshold: 0.6,
  includeScore: true,
  includeMatches: true,
  ignoreLocation: true,
  minMatchCharLength: 2,
  useExtendedSearch: false,
};

let _fuseInstance: Fuse<Video> | null = null;
let _cachedVideoCount = 0;

/** Call when the underlying video set changes so the next search rebuilds the index. */
export function invalidateSearchIndex(): void {
  _fuseInstance = null;
  _cachedVideoCount = 0;
}

function getFuse(videos: Video[]): Fuse<Video> {
  if (_fuseInstance && _cachedVideoCount === videos.length) {
    return _fuseInstance;
  }
  _fuseInstance = new Fuse(videos, FUSE_OPTIONS);
  _cachedVideoCount = videos.length;
  return _fuseInstance;
}

export function freshnessScore(publishedAt: string, maxAgeDays = DEFAULT_MAX_AGE_DAYS): number {
  const ageDays = (Date.now() - new Date(publishedAt).getTime()) / DAY_MS;
  if (ageDays <= FRESHNESS_RECENT_DAYS) return 1;
  if (ageDays >= maxAgeDays) return 0;
  return 1 - (ageDays - FRESHNESS_RECENT_DAYS) / (maxAgeDays - FRESHNESS_RECENT_DAYS);
}

function applyRecencyBoost(fuseScore: number, publishedAt: string): number {
  return (1 - fuseScore) + FRESHNESS_WEIGHT * freshnessScore(publishedAt);
}

function determineMatchReason(result: FuseResult<Video>): "title" | "channel" | "description" {
  const matchedKeys = result.matches?.map((m) => m.key) ?? [];
  if (matchedKeys.includes("title")) return "title";
  if (matchedKeys.includes("channelName")) return "channel";
  return "description";
}

function getFreshnessCutoff(freshnessMonths: number): Date {
  // 0 means "All time", which is still capped at 5 years internally.
  if (freshnessMonths <= 0) {
    return new Date(Date.now() - DEFAULT_MAX_AGE_DAYS * DAY_MS);
  }
  const cappedMonths = Math.min(freshnessMonths, 60);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - cappedMonths);
  return cutoff;
}

export function searchVideos(
  videos: Video[],
  opts: { query: string; freshnessMonths: number; topK?: number }
): SearchResult[] {
  const cutoff = getFreshnessCutoff(opts.freshnessMonths);
  const filtered = videos.filter((v) => new Date(v.publishedAt) >= cutoff);

  const fuse = getFuse(filtered);
  const fuseResults = fuse.search(opts.query);

  return fuseResults
    .map((r) => ({
      video: r.item,
      score: applyRecencyBoost(r.score ?? 1, r.item.publishedAt),
      matchReason: determineMatchReason(r),
    }))
    .filter((r) => r.score >= MIN_RELEVANCE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topK ?? DEFAULT_SEARCH_TOP_K);
}
