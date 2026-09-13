import { MONETIZATION } from "../monetization/config";
import type { BackgroundMessage, BackgroundResponse } from "../shared/messages";
import type { Account, IndexState, LogEntry } from "../shared/types";

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

function getEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function setText(id: string, text: string): void {
  getEl(id).textContent = text;
}

function setVisible(id: string, visible: boolean): void {
  getEl(id).style.display = visible ? "block" : "none";
}

// ── Avatars ──────────────────────────────────────────────────────────────

function initials(account: Account | null): string {
  const source = account?.displayName || account?.email || "";
  const parts = source.split(/[\s@]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase() || "?";
}

function buildAvatar(account: Account | null, size = 20): HTMLElement {
  if (account?.picture) {
    const img = document.createElement("img");
    img.src = account.picture;
    img.alt = "";
    img.width = size;
    img.height = size;
    return img;
  }
  const span = document.createElement("span");
  span.textContent = initials(account);
  return span;
}

// ── Accounts dropdown ────────────────────────────────────────────────────

let dropdownOpen = false;
let cachedAccounts: Account[] = [];
let cachedActiveId: string | null = null;
let cachedLogEntries: LogEntry[] = [];
let lastStatus: string | null = null;
/** Suppresses the 3s poll's status-text overwrite so a message the user needs to act on stays put. */
let holdStatusText = false;

function openDropdown(): void {
  dropdownOpen = true;
  getEl("accounts-dropdown").classList.add("open");
}

function closeDropdown(): void {
  dropdownOpen = false;
  getEl("accounts-dropdown").classList.remove("open");
}

function toggleDropdown(): void {
  if (dropdownOpen) closeDropdown();
  else openDropdown();
}

function updateHeaderAccount(accounts: Account[], activeId: string | null): void {
  const active = accounts.find((a) => a.id === activeId) ?? null;
  const avatarEl = getEl("header-avatar");
  avatarEl.textContent = "";
  avatarEl.appendChild(buildAvatar(active, 20));
  setText("header-label", active ? active.displayName || active.email : "Accounts");
}

function renderAccountsList(accounts: Account[], activeId: string | null): void {
  const container = getEl("accounts-list");
  container.textContent = "";

  const sorted = [...accounts].sort((a, b) => {
    if (a.id === activeId) return -1;
    if (b.id === activeId) return 1;
    return a.email.localeCompare(b.email);
  });

  for (const account of sorted) {
    const isActive = account.id === activeId;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = isActive ? "account-item active-account" : "account-item";

    const avatar = document.createElement("div");
    avatar.className = "item-avatar";
    avatar.appendChild(buildAvatar(account, 32));

    const info = document.createElement("div");
    info.className = "item-info";
    const name = document.createElement("div");
    name.className = "item-name";
    name.textContent = account.displayName || account.email;
    const email = document.createElement("div");
    email.className = "item-email";
    email.textContent = account.email;
    info.append(name, email);

    btn.append(avatar, info);

    if (isActive) {
      const badge = document.createElement("span");
      badge.className = "item-badge";
      badge.textContent = "Active";
      btn.appendChild(badge);
    }

    btn.addEventListener("click", () => void handleAccountSwitch(account.id));
    container.appendChild(btn);
  }
}

async function loadAccounts(): Promise<void> {
  const response = await sendMessage<Extract<BackgroundResponse, { type: "ACCOUNTS" }>>({ type: "GET_ACCOUNTS" });
  cachedAccounts = response.accounts;
  cachedActiveId = response.activeAccountId;
  updateHeaderAccount(cachedAccounts, cachedActiveId);
  renderAccountsList(cachedAccounts, cachedActiveId);
}

async function handleAccountSwitch(accountId: string): Promise<void> {
  if (accountId === cachedActiveId) {
    closeDropdown();
    return;
  }
  const response = await sendMessage<Extract<BackgroundResponse, { type: "SWITCH_ACCOUNT_RESULT" }>>({
    type: "SWITCH_ACCOUNT",
    accountId,
  });
  closeDropdown();
  await loadAccounts();

  holdStatusText = response.needsAuth === true;
  if (response.needsAuth) {
    setText("status-text", "Account switched — sign in required.");
    setVisible("needs-auth-notice", true);
  } else {
    setVisible("needs-auth-notice", false);
    await refreshStatus();
  }
}

// ── Status / progress / quota ───────────────────────────────────────────

function formatStatus(state: IndexState): string {
  if (state.status === "idle" && !state.lastFullIndexAt) {
    return 'Not indexed yet — click "Build Index"';
  }
  if (state.status === "indexing") {
    const pct = state.totalChannels > 0 ? Math.round((state.processedChannels / state.totalChannels) * 100) : 0;
    return `Indexing… ${state.processedChannels}/${state.totalChannels} channels (${pct}%)`;
  }
  if (state.status === "error") {
    return "Index error — retry or check console for details";
  }
  const last = state.lastFullIndexAt ? new Date(state.lastFullIndexAt).toLocaleString() : "never";
  return `${state.totalVideos.toLocaleString()} videos · ${state.totalChannels} channels · last synced ${last}`;
}

function renderProgressBar(state: IndexState): void {
  const bar = getEl("progress-bar");
  const fill = getEl("progress-fill");
  if (state.status === "indexing" && state.totalChannels > 0) {
    bar.style.display = "block";
    fill.style.width = `${Math.round((state.processedChannels / state.totalChannels) * 100)}%`;
  } else {
    bar.style.display = "none";
  }
}

function renderQuota(used: number, limit: number): void {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  setText("quota-text", `${used.toLocaleString()} / ${limit.toLocaleString()} units used today`);
  const fill = getEl("quota-fill");
  fill.style.width = `${pct}%`;
  fill.classList.toggle("quota-warn", pct >= 80);
}

async function refreshStatus(): Promise<void> {
  const stateResp = await sendMessage<Extract<BackgroundResponse, { type: "INDEX_STATE" }>>({
    type: "GET_INDEX_STATE",
  });
  const state = stateResp.state;

  if (!holdStatusText) setText("status-text", formatStatus(state));
  renderProgressBar(state);

  const indexBtn = getEl<HTMLButtonElement>("index-btn");
  const refreshBtn = getEl<HTMLButtonElement>("refresh-btn");
  const indexing = state.status === "indexing";
  indexBtn.disabled = indexing;
  indexBtn.textContent = indexing ? "▶ Indexing…" : state.lastFullIndexAt ? "▶ Rebuild Index" : "▶ Build Index";
  refreshBtn.style.display = state.lastFullIndexAt ? "inline-flex" : "none";
  refreshBtn.disabled = indexing;

  if (lastStatus === "indexing" && state.status === "completed") {
    await loadAccounts();
  }
  lastStatus = state.status;

  const quotaResp = await sendMessage<Extract<BackgroundResponse, { type: "QUOTA_STATUS" }>>({
    type: "GET_QUOTA_STATUS",
  });
  renderQuota(quotaResp.used, quotaResp.limit);
}

// ── Debug log ────────────────────────────────────────────────────────────

function renderDebugLog(entries: LogEntry[]): void {
  const container = getEl("debug-entries");
  container.textContent = "";
  for (const entry of entries.slice(-50)) {
    const row = document.createElement("div");
    row.className = `log-entry log-${entry.level}`;

    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = new Date(entry.timestamp).toLocaleTimeString();

    const level = document.createElement("span");
    level.className = "log-level";
    level.textContent = entry.level.toUpperCase();

    const source = document.createElement("span");
    source.className = "log-source";
    source.textContent = `[${entry.source}]`;

    const msg = document.createElement("span");
    msg.className = "log-msg";
    msg.textContent = entry.message;

    row.append(time, level, source, msg);
    container.appendChild(row);
  }
}

async function copyDebugLog(entries: LogEntry[]): Promise<void> {
  await navigator.clipboard.writeText(JSON.stringify(entries, null, 2));
}

// ── Monetization ─────────────────────────────────────────────────────────

function renderMonetization(): void {
  if (MONETIZATION.KOFI_ENABLED) {
    const btn = getEl<HTMLAnchorElement>("kofi-btn");
    btn.href = `https://ko-fi.com/${MONETIZATION.KOFI_USERNAME}`;
    btn.style.display = "inline-flex";
  }
  if (MONETIZATION.GUMROAD_ENABLED) {
    const btn = getEl<HTMLAnchorElement>("gumroad-btn");
    btn.href = MONETIZATION.GUMROAD_URL;
    btn.style.display = "inline-flex";
  }
  if (MONETIZATION.SPONSOR_ENABLED) {
    getEl("sponsor-slot").style.display = "block";
    const link = getEl<HTMLAnchorElement>("sponsor-link");
    link.href = MONETIZATION.SPONSOR_URL;
    link.textContent = MONETIZATION.SPONSOR_TEXT;
  }
}

// ── Init ─────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  getEl("accounts-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDropdown();
  });
  document.addEventListener("click", (e) => {
    const dropdown = getEl("accounts-dropdown");
    if (dropdownOpen && !dropdown.contains(e.target as Node)) closeDropdown();
  });

  getEl("add-account-btn").addEventListener("click", async () => {
    closeDropdown();
    const priorIds = new Set(cachedAccounts.map((a) => a.id));
    const response = await sendMessage<Extract<BackgroundResponse, { type: "ADD_ACCOUNT_RESULT" }>>({
      type: "ADD_ACCOUNT",
    });
    await loadAccounts();
    await refreshStatus();

    holdStatusText = true;
    if (!response.ok || !response.account) {
      setText("status-text", response.error ?? "Sign-in was cancelled or failed.");
    } else if (priorIds.has(response.account.id)) {
      setText(
        "status-text",
        `Google signed you back into ${response.account.email}, which is already added. Switch accounts at google.com in this browser, then try again.`
      );
    } else {
      setText("status-text", `Added ${response.account.email} — click "Build Index" to index it.`);
    }
  });

  getEl("index-btn").addEventListener("click", async () => {
    holdStatusText = false;
    await sendMessage({ type: "START_INDEX" });
    lastStatus = "indexing";
    await refreshStatus();
  });

  getEl("refresh-btn").addEventListener("click", async () => {
    await sendMessage({ type: "FORCE_INCREMENTAL_REFRESH" });
    await refreshStatus();
  });

  getEl("clear-btn").addEventListener("click", async () => {
    if (!confirm("Clear the index for the current account? You will need to re-index.")) return;
    await sendMessage({ type: "CLEAR_INDEX" });
    await refreshStatus();
  });

  getEl("options-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());

  const debugToggle = getEl<HTMLButtonElement>("debug-toggle");
  let debugOpen = false;
  debugToggle.addEventListener("click", async () => {
    debugOpen = !debugOpen;
    getEl("debug-panel").style.display = debugOpen ? "block" : "none";
    debugToggle.textContent = debugOpen ? "▼ Debug" : "▶ Debug";
    if (debugOpen) {
      const response = await sendMessage<Extract<BackgroundResponse, { type: "DEBUG_LOG" }>>({
        type: "GET_DEBUG_LOG",
      });
      cachedLogEntries = response.entries;
      renderDebugLog(cachedLogEntries);
    }
  });

  getEl("copy-log-btn").addEventListener("click", () => void copyDebugLog(cachedLogEntries));

  renderMonetization();
  await loadAccounts();
  await refreshStatus();
}

setInterval(() => void refreshStatus(), 3000);

void init();
