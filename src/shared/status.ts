import type { IndexState } from "./types";

/** One sentence describing the index, shared by the popup and the Options setup card. */
export function formatIndexStatus(state: IndexState, pinnedCount: number): string {
  if (state.status === "idle" && !state.lastFullIndexAt) {
    return "Not indexed yet";
  }
  if (state.status === "indexing") {
    const pct = state.totalChannels > 0 ? Math.round((state.processedChannels / state.totalChannels) * 100) : 0;
    return `Indexing… ${state.processedChannels}/${state.totalChannels} channels (${pct}%)`;
  }
  if (state.deepStatus === "indexing") {
    return `Deep-indexing pinned channels… ${state.deepProcessedChannels}/${state.deepTotalChannels}`;
  }
  if (state.status === "error") {
    return "Index error — retry or check the debug log";
  }
  const last = state.lastFullIndexAt ? new Date(state.lastFullIndexAt).toLocaleString() : "never";
  const pinned = pinnedCount > 0 ? ` · ${pinnedCount} pinned` : "";
  return `${state.totalVideos.toLocaleString()} videos · ${state.totalChannels} channels${pinned} · last synced ${last}`;
}

export function isBusy(state: IndexState): boolean {
  return state.status === "indexing" || state.deepStatus === "indexing";
}
