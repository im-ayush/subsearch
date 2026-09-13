import { DEFAULT_PREFERENCES, type ChannelSummary } from "../shared/types";
import { API_PAGE_SIZE, DEEP_MAX_VIDEOS_PER_CHANNEL, MAX_VIDEOS_PER_CHANNEL, MIN_VIDEOS_PER_CHANNEL } from "../shared/constants";
import { getUserPreferences, setUserPreferences } from "../shared/preferences";
import type { BackgroundMessage, BackgroundResponse } from "../shared/messages";

function getEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function sendMessage<T extends BackgroundResponse = BackgroundResponse>(msg: BackgroundMessage): Promise<T> {
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

// ── Pinned channels ──────────────────────────────────────────────────────

let allChannels: ChannelSummary[] = [];
let savedPinned = new Set<string>();
let draftPinned = new Set<string>();
let maxPinned = 10;
let pinPollTimer: number | null = null;

function estimateUnits(channel: ChannelSummary): number {
  const videos = Math.min(channel.videoCount ?? DEEP_MAX_VIDEOS_PER_CHANNEL, DEEP_MAX_VIDEOS_PER_CHANNEL);
  return Math.max(1, Math.ceil(videos / API_PAGE_SIZE));
}

function renderPinCost(): void {
  const newlyPinned = allChannels.filter((c) => draftPinned.has(c.id) && !savedPinned.has(c.id));
  const el = getEl("pin-cost");
  if (newlyPinned.length === 0) {
    el.textContent = "";
    return;
  }
  const units = newlyPinned.reduce((sum, c) => sum + estimateUnits(c), 0);
  const anyUnknown = newlyPinned.some((c) => c.videoCount === undefined);
  el.textContent = `Deep-indexing ${newlyPinned.length} newly pinned channel${newlyPinned.length === 1 ? "" : "s"} ≈ ${anyUnknown ? "up to " : ""}${units} quota units`;
}

function renderPinCount(): void {
  const countEl = getEl("pin-count");
  countEl.textContent = String(draftPinned.size);
  countEl.parentElement?.classList.toggle("at-limit", draftPinned.size >= maxPinned);
}

function pinsDirty(): boolean {
  if (draftPinned.size !== savedPinned.size) return true;
  for (const id of draftPinned) if (!savedPinned.has(id)) return true;
  return false;
}

function renderPinList(): void {
  const list = getEl("pin-list");
  list.textContent = "";

  if (allChannels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pin-empty";
    empty.textContent = "Build your index first — pinned channels are chosen from your subscriptions.";
    list.appendChild(empty);
    return;
  }

  const filter = getEl<HTMLInputElement>("pin-search").value.trim().toLowerCase();
  const atLimit = draftPinned.size >= maxPinned;
  let shown = 0;

  for (const channel of allChannels) {
    if (filter && !channel.title.toLowerCase().includes(filter)) continue;
    shown += 1;
    const isPinned = draftPinned.has(channel.id);

    const row = document.createElement("label");
    row.className = isPinned ? "pin-row pinned" : "pin-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isPinned;
    checkbox.disabled = !isPinned && atLimit;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) draftPinned.add(channel.id);
      else draftPinned.delete(channel.id);
      renderPinList();
      renderPinCount();
      renderPinCost();
      getEl<HTMLButtonElement>("pin-save-btn").disabled = !pinsDirty();
    });

    const title = document.createElement("span");
    title.className = "pin-title";
    title.textContent = channel.title;

    const meta = document.createElement("span");
    meta.className = "pin-meta";
    meta.textContent = channel.videoCount !== undefined ? `${channel.videoCount.toLocaleString()} videos` : "";

    row.append(checkbox, title, meta);
    list.appendChild(row);
  }

  if (shown === 0) {
    const empty = document.createElement("div");
    empty.className = "pin-empty";
    empty.textContent = "No channels match that filter.";
    list.appendChild(empty);
  }
}

function setPinStatus(text: string, tone: "" | "ok" | "err" = ""): void {
  const el = getEl("pin-status");
  el.textContent = text;
  el.className = tone ? `pin-status ${tone}` : "pin-status";
}

function stopPinPolling(): void {
  if (pinPollTimer !== null) window.clearInterval(pinPollTimer);
  pinPollTimer = null;
}

function pollDeepIndexProgress(): void {
  stopPinPolling();
  pinPollTimer = window.setInterval(async () => {
    try {
      const { state } = await sendMessage<Extract<BackgroundResponse, { type: "INDEX_STATE" }>>({ type: "GET_INDEX_STATE" });
      if (state.deepStatus === "indexing") {
        setPinStatus(`Deep-indexing… ${state.deepProcessedChannels}/${state.deepTotalChannels} channels`);
        return;
      }
      stopPinPolling();
      if (state.deepStatus === "error") {
        setPinStatus("Deep index hit an error — check the popup's debug log. Pins are saved; it will retry on next rebuild.", "err");
      } else {
        setPinStatus(`Done — ${state.totalVideos.toLocaleString()} videos in your index.`, "ok");
      }
    } catch {
      stopPinPolling();
    }
  }, 1500);
}

async function loadChannels(): Promise<void> {
  try {
    const response = await sendMessage<Extract<BackgroundResponse, { type: "CHANNELS" }>>({ type: "GET_CHANNELS" });
    allChannels = response.channels;
    maxPinned = response.maxPinned;
    savedPinned = new Set(allChannels.filter((c) => c.pinned).map((c) => c.id));
    draftPinned = new Set(savedPinned);
    getEl("pin-max").textContent = String(maxPinned);
    const accountEl = getEl("pin-account");
    accountEl.textContent = "";
    if (response.accountEmail) {
      accountEl.append("For ");
      const b = document.createElement("b");
      b.textContent = response.accountEmail;
      accountEl.appendChild(b);
    }
  } catch (err) {
    allChannels = [];
    setPinStatus(`Couldn't load channels: ${String(err)}`, "err");
  }
  renderPinList();
  renderPinCount();
  renderPinCost();
  getEl<HTMLButtonElement>("pin-save-btn").disabled = true;
}

async function savePins(): Promise<void> {
  const saveBtn = getEl<HTMLButtonElement>("pin-save-btn");
  saveBtn.disabled = true;
  const hadNew = allChannels.some((c) => draftPinned.has(c.id) && !savedPinned.has(c.id));
  try {
    const response = await sendMessage({ type: "SET_PINNED_CHANNELS", channelIds: [...draftPinned] });
    if (response.type === "ERROR") {
      setPinStatus(response.message, "err");
      saveBtn.disabled = false;
      return;
    }
    savedPinned = new Set(draftPinned);
    renderPinCost();
    if (hadNew) {
      setPinStatus("Pins saved — starting deep index…");
      pollDeepIndexProgress();
    } else {
      setPinStatus("Pins saved.", "ok");
    }
  } catch (err) {
    setPinStatus(`Couldn't save pins: ${String(err)}`, "err");
    saveBtn.disabled = false;
  }
}

let savedMsgTimer: number | null = null;
function showSaved(): void {
  const el = getEl("saved-msg");
  el.textContent = "Preferences saved ✓";
  el.style.display = "block";
  if (savedMsgTimer !== null) window.clearTimeout(savedMsgTimer);
  savedMsgTimer = window.setTimeout(() => {
    el.style.display = "none";
  }, 2500);
}

async function init(): Promise<void> {
  const videosPerChannelInput = getEl<HTMLInputElement>("videos-per-channel");
  const freshnessSelect = getEl<HTMLSelectElement>("freshness-months");
  const overlayEnabledInput = getEl<HTMLInputElement>("overlay-enabled");
  const saveBtn = getEl<HTMLButtonElement>("save-btn");
  const resetBtn = getEl<HTMLButtonElement>("reset-btn");

  function populate(prefs: typeof DEFAULT_PREFERENCES): void {
    videosPerChannelInput.value = String(prefs.videosPerChannel);
    freshnessSelect.value = String(prefs.freshnessMonths);
    overlayEnabledInput.checked = prefs.overlayEnabled;
  }

  populate(await getUserPreferences());

  saveBtn.addEventListener("click", async () => {
    const videosPerChannel = Math.max(
      MIN_VIDEOS_PER_CHANNEL,
      Math.min(MAX_VIDEOS_PER_CHANNEL, parseInt(videosPerChannelInput.value, 10) || DEFAULT_PREFERENCES.videosPerChannel)
    );
    await setUserPreferences({
      videosPerChannel,
      freshnessMonths: Number(freshnessSelect.value),
      overlayEnabled: overlayEnabledInput.checked,
    });
    videosPerChannelInput.value = String(videosPerChannel);
    showSaved();
  });

  resetBtn.addEventListener("click", async () => {
    await setUserPreferences(DEFAULT_PREFERENCES);
    populate(DEFAULT_PREFERENCES);
    showSaved();
  });

  getEl("pin-search").addEventListener("input", renderPinList);
  getEl("pin-save-btn").addEventListener("click", () => void savePins());
  await loadChannels();

  // If a deep index is already running (e.g. page reopened mid-run), pick up its progress.
  const { state } = await sendMessage<Extract<BackgroundResponse, { type: "INDEX_STATE" }>>({ type: "GET_INDEX_STATE" });
  if (state.deepStatus === "indexing") pollDeepIndexProgress();
}

void init();
