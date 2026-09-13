import { CSS_PREFIX, SEARCH_DEBOUNCE_MS, STORAGE_KEY_FRESHNESS } from "../shared/constants";
import { DEFAULT_PREFERENCES } from "../shared/types";
import type { IndexState, SearchResult } from "../shared/types";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  classes: string[] = [],
  attrs: Record<string, string> = {}
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const cls of classes) element.classList.add(cls);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function prefixed(...names: string[]): string[] {
  return names.map((n) => `${CSS_PREFIX}${n}`);
}

export async function loadFreshnessPreference(): Promise<number> {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(STORAGE_KEY_FRESHNESS, (result) => {
        const stored = result[STORAGE_KEY_FRESHNESS];
        resolve(typeof stored === "number" ? stored : DEFAULT_PREFERENCES.freshnessMonths);
      });
    } catch {
      resolve(DEFAULT_PREFERENCES.freshnessMonths);
    }
  });
}

export async function saveFreshnessPreference(months: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.set({ [STORAGE_KEY_FRESHNESS]: months }, () => resolve());
    } catch {
      resolve();
    }
  });
}

function formatRelativeDate(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

const FRESHNESS_OPTIONS = [
  { label: "1 month", months: 1 },
  { label: "6 months", months: 6 },
  { label: "1 year", months: 12 },
  { label: "18 months", months: 18 },
  { label: "All time", months: 0 },
];

interface OverlayCallbacks {
  onSearch: (query: string, freshnessMonths: number) => void;
  onClose: () => void;
  onAutoOpenChange: (enabled: boolean) => void;
}

export class SearchOverlay {
  root: HTMLElement | null = null;
  input: HTMLInputElement | null = null;
  resultsList: HTMLElement | null = null;
  statusEl: HTMLElement | null = null;
  filterBtns: HTMLButtonElement[] = [];
  activeFreshnessMonths = DEFAULT_PREFERENCES.freshnessMonths;
  private autoOpen = DEFAULT_PREFERENCES.overlayEnabled;
  private pinnedChannels = new Set<string>();
  private debounceTimer: number | null = null;
  private styleEl: HTMLElement | null = null;
  private callbacks: OverlayCallbacks;

  constructor(callbacks: OverlayCallbacks) {
    this.callbacks = callbacks;
  }

  async mount(autoOpen: boolean): Promise<void> {
    this.autoOpen = autoOpen;
    this.activeFreshnessMonths = await loadFreshnessPreference();
    this.injectStyles();
    this.buildDOM();
    this.attachEvents();
    document.body.appendChild(this.root!);
    this.input?.focus();
  }

  unmount(): void {
    this.root?.remove();
    this.styleEl?.remove();
    document.removeEventListener("keydown", this.handleKeydown);
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.root = null;
    this.input = null;
    this.resultsList = null;
    this.statusEl = null;
    this.filterBtns = [];
    this.styleEl = null;
  }

  isOpen(): boolean {
    return this.root !== null;
  }

  private injectStyles(): void {
    if (document.getElementById("ss-styles")) return;
    const link = el("link", [], {
      id: "ss-styles",
      rel: "stylesheet",
      href: chrome.runtime.getURL("content.css"),
    });
    document.head.appendChild(link);
    this.styleEl = link;
  }

  private buildDOM(): void {
    const [
      rootCls,
      panelCls,
      headerCls,
      titleCls,
      closeCls,
      inputRowCls,
      inputCls,
      filterBarCls,
      pillCls,
      statusCls,
      resultsCls,
      footerCls,
      autoOpenCls,
    ] = prefixed(
      "overlay",
      "panel",
      "header",
      "logo",
      "close-btn",
      "input-row",
      "input",
      "filter-bar",
      "filter-btn",
      "status",
      "results",
      "footer",
      "auto-open"
    );

    const root = el("div", [rootCls]);
    const panel = el("div", [panelCls], { role: "dialog", "aria-modal": "true", "aria-label": "Search your subscriptions" });

    const header = el("div", [headerCls]);

    const inputRow = el("div", [inputRowCls]);
    const title = el("span", [titleCls]);
    title.textContent = "SubSearch";
    const input = el("input", [inputCls], { type: "text", placeholder: "Search your subscriptions…" });
    const closeBtn = el("button", [closeCls], { type: "button", "aria-label": "Close" });
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => this.callbacks.onClose());
    inputRow.append(title, input, closeBtn);

    const filterBar = el("div", [filterBarCls]);
    const filterBtns: HTMLButtonElement[] = [];
    for (const opt of FRESHNESS_OPTIONS) {
      const btn = el("button", [pillCls], { type: "button" });
      btn.textContent = opt.label;
      btn.dataset.months = String(opt.months);
      if (opt.months === this.activeFreshnessMonths) btn.classList.add(`${CSS_PREFIX}active`);
      btn.addEventListener("click", () => void this.handleFilterChange(opt.months));
      filterBar.appendChild(btn);
      filterBtns.push(btn);
    }

    header.append(inputRow, filterBar);

    const status = el("div", [statusCls]);
    const results = el("ul", [resultsCls]);

    const footer = el("div", [footerCls]);
    const autoOpenLabel = el("label", [autoOpenCls]);
    const autoOpenToggle = el("input", [], { type: "checkbox" });
    autoOpenToggle.checked = this.autoOpen;
    autoOpenToggle.addEventListener("change", () => this.callbacks.onAutoOpenChange(autoOpenToggle.checked));
    const autoOpenText = el("span");
    autoOpenText.textContent = "Open automatically when I search YouTube";
    autoOpenLabel.append(autoOpenToggle, autoOpenText);
    footer.appendChild(autoOpenLabel);

    panel.append(header, status, results, footer);
    root.appendChild(panel);

    this.root = root;
    this.input = input;
    this.resultsList = results;
    this.statusEl = status;
    this.filterBtns = filterBtns;
  }

  private attachEvents(): void {
    this.root?.addEventListener("click", (e) => {
      if (e.target === this.root) this.callbacks.onClose();
    });
    document.addEventListener("keydown", this.handleKeydown);
    this.input?.addEventListener("input", () => {
      if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
      this.debounceTimer = window.setTimeout(() => {
        this.callbacks.onSearch(this.input?.value.trim() ?? "", this.activeFreshnessMonths);
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  /** Prefills the box and searches at once — no debounce, since the query is already known. */
  setQuery(query: string): void {
    if (!this.input) return;
    this.input.value = query;
    this.callbacks.onSearch(query.trim(), this.activeFreshnessMonths);
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.isOpen()) this.callbacks.onClose();
  };

  private async handleFilterChange(months: number): Promise<void> {
    this.activeFreshnessMonths = months;
    const activeCls = `${CSS_PREFIX}active`;
    for (const btn of this.filterBtns) {
      btn.classList.toggle(activeCls, Number(btn.dataset.months) === months);
    }
    await saveFreshnessPreference(months);
    this.callbacks.onSearch(this.input?.value.trim() ?? "", months);
  }

  setPinnedChannels(channelIds: Iterable<string>): void {
    this.pinnedChannels = new Set(channelIds);
  }

  updateStatus(state: IndexState, videoCount: number): void {
    if (!this.statusEl) return;
    if (state.status === "idle" && !state.lastFullIndexAt) {
      this.showNotIndexed();
    } else if (state.status === "indexing") {
      this.showIndexing(state);
    } else if (state.deepStatus === "indexing") {
      this.statusEl.textContent = `Deep-indexing pinned channels… ${state.deepProcessedChannels}/${state.deepTotalChannels}`;
    } else {
      const pinned = this.pinnedChannels.size > 0 ? ` · ${this.pinnedChannels.size} pinned` : "";
      this.statusEl.textContent = `${videoCount.toLocaleString()} videos indexed${pinned}`;
    }
  }

  showLoading(): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = "Loading…";
  }

  showIndexing(state: IndexState): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = `Indexing… ${state.processedChannels}/${state.totalChannels} channels`;
  }

  showEmpty(query: string): void {
    if (!this.resultsList || !this.statusEl) return;
    this.resultsList.textContent = "";
    this.statusEl.textContent = query ? `No results for "${query}"` : "";
  }

  showNotIndexed(): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = "Not indexed yet — open the extension popup to build your index.";
  }

  showNotice(text: string): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
  }

  renderResults(results: SearchResult[]): void {
    if (!this.resultsList) return;
    this.resultsList.textContent = "";
    if (results.length === 0) {
      this.showEmpty(this.input?.value.trim() ?? "");
      return;
    }
    if (this.statusEl) this.statusEl.textContent = `${results.length} result${results.length === 1 ? "" : "s"}`;
    for (const result of results) {
      this.resultsList.appendChild(this.buildResultItem(result));
    }
  }

  private buildResultItem(result: SearchResult): HTMLAnchorElement {
    const [itemCls, thumbWrapCls, thumbCls, infoCls, metaCls, titleCls, channelCls, dateCls, badgeCls, pinCls] = prefixed(
      "result-item",
      "thumb-wrap",
      "thumb",
      "result-info",
      "result-meta",
      "result-title",
      "result-channel",
      "result-date",
      "result-badge",
      "result-pin"
    );

    const item = el("a", [itemCls], {
      href: `https://www.youtube.com/watch?v=${encodeURIComponent(result.video.id)}`,
    });

    const thumbWrap = el("div", [thumbWrapCls]);
    const img = el("img", [thumbCls], { loading: "lazy", decoding: "async", alt: "" });
    img.src = result.video.thumbnailUrl;
    img.addEventListener("error", () => img.replaceWith(this.buildThumbPlaceholder()), { once: true });
    thumbWrap.appendChild(img);

    const info = el("div", [infoCls]);
    const title = el("span", [titleCls]);
    title.textContent = result.video.title;
    const meta = el("div", [metaCls]);
    const channel = el("span", [channelCls]);
    channel.textContent = result.video.channelName;
    const date = el("span", [dateCls]);
    date.textContent = formatRelativeDate(result.video.publishedAt);
    const badge = el("span", [badgeCls]);
    badge.textContent = result.matchReason;
    meta.append(channel, date, badge);
    if (this.pinnedChannels.has(result.video.channelId)) {
      const pin = el("span", [pinCls]);
      pin.textContent = "Pinned";
      meta.appendChild(pin);
    }
    info.append(title, meta);

    item.append(thumbWrap, info);
    return item;
  }

  private buildThumbPlaceholder(): HTMLElement {
    const placeholder = el("div", prefixed("thumb-placeholder"));
    placeholder.textContent = "▶";
    return placeholder;
  }
}
