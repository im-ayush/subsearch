import { YT_SEARCH_PATTERN } from "../shared/constants";

/** YouTube is an SPA that doesn't fire real page loads — this polls location.href via MutationObserver. */
export class YouTubeRouter {
  private lastUrl = location.href;
  private observer: MutationObserver | null = null;
  private handler: (isSearchPage: boolean, url: string) => void;

  constructor(handler: (isSearchPage: boolean, url: string) => void) {
    this.handler = handler;
  }

  start(): void {
    this.observer = new MutationObserver(() => {
      if (location.href === this.lastUrl) return;
      this.lastUrl = location.href;
      this.handler(this.isSearchPage(this.lastUrl), this.lastUrl);
    });
    this.observer.observe(document, { subtree: true, childList: true });
    this.handler(this.isSearchPage(this.lastUrl), this.lastUrl);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  private isSearchPage(url: string): boolean {
    return url.includes(YT_SEARCH_PATTERN);
  }
}
