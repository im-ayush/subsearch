// Build-time config, inlined via esbuild `define` from `.env`. See env.d.ts.
export const OAUTH_CLIENT_ID = __OAUTH_CLIENT_ID__;
/** "Web application" client — only this type can register a redirect URI, which launchWebAuthFlow requires. */
export const OAUTH_WEB_CLIENT_ID = __OAUTH_WEB_CLIENT_ID__;
export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
export const DEFAULT_VIDEOS_PER_CHANNEL = __DEFAULT_VIDEOS_PER_CHANNEL__;
export const DAILY_QUOTA_LIMIT = __DAILY_QUOTA_LIMIT__;
export const QUOTA_WARN_THRESHOLD = __QUOTA_WARN_THRESHOLD__;
export const QUOTA_ABORT_THRESHOLD = __QUOTA_ABORT_THRESHOLD__;
export const SYNC_INTERVAL_MINUTES = __SYNC_INTERVAL_MINUTES__;
export const CONCURRENT_FETCHES = __CONCURRENT_FETCHES__;
export const DEFAULT_SEARCH_TOP_K = __DEFAULT_SEARCH_TOP_K__;
export const FRESHNESS_WEIGHT = __FRESHNESS_WEIGHT__;

// YouTube Data API v3 quota costs.
export const QUOTA_UNITS_SUBSCRIPTIONS_PAGE = 3;
export const QUOTA_UNITS_CHANNELS_BATCH = 3;
export const QUOTA_UNITS_PLAYLIST_ITEMS = 1;
export const API_PAGE_SIZE = 50;

export const MAX_DESCRIPTION_CHARS = 300;
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1000;
export const RETRY_MAX_DELAY_MS = 30000;

export const STORAGE_KEY_PREFERENCES = "subsearch_prefs";
export const STORAGE_KEY_ACCOUNTS = "subsearch_accounts";
export const STORAGE_KEY_ACTIVE_ACCOUNT = "subsearch_active_account";
export const STORAGE_KEY_FRESHNESS = "subsearch_freshness_months";

export const LOG_KEEP_INFO = 500;
export const LOG_KEEP_WARN = 200;
export const LOG_KEEP_ERROR = 100;

export const ALARM_SYNC = "subsearch_sync";

// Search / freshness.
export const DEFAULT_MAX_AGE_DAYS = 1825;
export const FRESHNESS_RECENT_DAYS = 30;
export const MIN_RELEVANCE_THRESHOLD = 0.4;
export const SEARCH_DEBOUNCE_MS = 200;

// Content overlay.
export const CSS_PREFIX = "ss-";
export const YT_SEARCH_PATTERN = "youtube.com/results";
