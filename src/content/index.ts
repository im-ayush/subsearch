import { logger } from "../shared/logger";
import { CSS_PREFIX } from "../shared/constants";
import { getUserPreferences } from "../shared/preferences";
import { invalidateSearchIndex, searchVideos } from "../search/engine";
import { SearchOverlay } from "./overlay";
import { YouTubeRouter } from "./router";
import type { BackgroundMessage, BackgroundResponse, TabMessage } from "../shared/messages";
import type { IndexState, Video } from "../shared/types";

const SOURCE = "content";

let allVideos: Video[] = [];
let indexState: IndexState | null = null;
let overlay: SearchOverlay | null = null;
let statePollingTimer: number | null = null;
let fab: HTMLButtonElement | null = null;

function sendToBackground<T extends BackgroundResponse = BackgroundResponse>(msg: BackgroundMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response: T | undefined) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error("No response from background"));
        return;
      }
      resolve(response);
    });
  });
}

async function loadVideoIndex(): Promise<void> {
  const response = await sendToBackground<Extract<BackgroundResponse, { type: "VIDEOS" }>>({ type: "GET_VIDEOS" });
  allVideos = response.videos;
  indexState = response.state;
  invalidateSearchIndex();
}

function startStatePolling(): void {
  if (statePollingTimer !== null) return;
  statePollingTimer = window.setInterval(async () => {
    if (!isExtensionContextValid()) {
      stopStatePolling();
      return;
    }
    try {
      const response = await sendToBackground<Extract<BackgroundResponse, { type: "VIDEOS" }>>({ type: "GET_VIDEOS" });
      if (response.videos.length !== allVideos.length) {
        allVideos = response.videos;
        invalidateSearchIndex();
      }
      indexState = response.state;
      if (overlay?.isOpen()) overlay.updateStatus(indexState, allVideos.length);
      if (indexState.status !== "indexing") stopStatePolling();
    } catch (err) {
      logger.warn(SOURCE, "state polling failed, likely stale extension context", { err: String(err) });
      stopStatePolling();
    }
  }, 2000);
}

function stopStatePolling(): void {
  if (statePollingTimer === null) return;
  window.clearInterval(statePollingTimer);
  statePollingTimer = null;
}

function handleSearch(query: string, freshnessMonths: number): void {
  if (!overlay) return;
  if (!indexState || (indexState.status === "idle" && !indexState.lastFullIndexAt)) {
    overlay.showNotIndexed();
    return;
  }
  if (indexState.status === "indexing") {
    overlay.showIndexing(indexState);
    return;
  }
  if (!query) {
    overlay.showEmpty("");
    return;
  }
  const results = searchVideos(allVideos, { query, freshnessMonths });
  overlay.renderResults(results);
}

function buildFab(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = `${CSS_PREFIX}fab`;
  btn.setAttribute("aria-label", "Search your subscriptions");
  btn.title = "Search your subscriptions (Ctrl+Shift+F)";
  // SECURITY: the only innerHTML use in this codebase — static markup, no external/user data.
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
  btn.addEventListener("click", () => void openOverlay());
  document.body.appendChild(btn);
  return btn;
}

function showFab(): void {
  if (!fab) fab = buildFab();
  fab.style.display = "";
}

function hideFab(): void {
  if (fab) fab.style.display = "none";
}

function isExtensionContextValid(): boolean {
  try {
    return typeof chrome.runtime?.id === "string";
  } catch {
    return false;
  }
}

function currentYouTubeQuery(): string {
  try {
    return new URL(location.href).searchParams.get("search_query")?.trim() ?? "";
  } catch {
    return "";
  }
}

async function openOverlay(): Promise<void> {
  if (!isExtensionContextValid()) {
    logger.warn(SOURCE, "openOverlay: extension context invalidated, skipping (page needs a refresh)");
    return;
  }
  const query = currentYouTubeQuery();
  if (overlay?.isOpen()) {
    // Already open (e.g. browser back/forward changed the results URL underneath it) — just re-run.
    if (query) overlay.setQuery(query);
    return;
  }
  if (!overlay) {
    overlay = new SearchOverlay({ onSearch: handleSearch, onClose: closeOverlay });
  }
  try {
    hideFab();
    await overlay.mount();
    overlay.showLoading();
    await loadVideoIndex();
    if (indexState) overlay.updateStatus(indexState, allVideos.length);
    if (indexState?.status === "indexing") startStatePolling();
    if (query) overlay.setQuery(query);
  } catch (err) {
    logger.warn(SOURCE, "openOverlay failed, likely stale extension context", { err: String(err) });
  }
}

function closeOverlay(): void {
  overlay?.unmount();
  stopStatePolling();
  showFab();
}

const router = new YouTubeRouter((isSearchPage) => {
  if (isSearchPage) {
    void (async () => {
      const prefs = await getUserPreferences();
      if (prefs.overlayEnabled) await openOverlay();
      else showFab();
    })();
  } else {
    closeOverlay();
    hideFab();
  }
});

async function init(): Promise<void> {
  try {
    router.start();
  } catch (err) {
    logger.error(SOURCE, "init failed", { err: String(err) });
  }
}

chrome.runtime.onMessage.addListener((message: TabMessage) => {
  if (message.type === "INDEX_COMPLETE") {
    void loadVideoIndex();
    stopStatePolling();
  }
  return false;
});

void init();

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    if (overlay?.isOpen()) closeOverlay();
    else void openOverlay();
  }
});

// Debug/console hook.
(globalThis as Record<string, unknown>).ssOpenOverlay = openOverlay;
