# SubSearch — Search Within Your YouTube Subscriptions

A Chrome extension (Manifest V3) that lets you search videos from your subscribed YouTube channels — no trending, no recommendations, just your subscriptions.

---

## Architecture

| Layer | Technology |
|---|---|
| Extension API | Chrome MV3 — background service worker |
| Storage | IndexedDB via Dexie.js (extension origin only), one database per Google account |
| Search | Fuse.js fuzzy search, in-memory |
| Auth | Chrome Identity API — no raw keys, no token files |
| Build | esbuild (TypeScript → JS bundle) |

### Key architectural notes

**IndexedDB origin isolation.** The background service worker writes to IndexedDB under the extension's own origin (`chrome-extension://…`). Content scripts run under `youtube.com` and cannot directly share that database. All video data flows from the background to the content script via `chrome.runtime.sendMessage` (`GET_VIDEOS` message type).

**Single-phase indexing.** All channels are indexed in one pass using `DEFAULT_VIDEOS_PER_CHANNEL` (configurable 5–50). There are no Phase 1 / Phase 2 splits — one constant, consistent behaviour everywhere.

**Freshness filter replaces maxAgeDays.** There is no separate `maxAgeDays` setting in effect. The freshness filter in the search overlay controls what is searched. "All time" is capped at 5 years (1825 days) internally. The indexer always fetches the most recent N videos per channel regardless of age.

---

## Setup

### Prerequisites

- Node.js LTS
- A Google Cloud project with YouTube Data API v3 enabled
- An OAuth 2.0 Client ID (type: Chrome Extension)

### Installation

```bash
git clone <repo>
cd subsearch
npm install
cp .env.example .env   # then fill in your OAUTH_CLIENT_ID
```

### Configuration — `.env`

All tunable values live in `.env`. This file is gitignored and never committed.

| Variable | Default | Description |
|---|---|---|
| `OAUTH_CLIENT_ID` | (required) | Your Google Cloud OAuth 2.0 Client ID |
| `DEFAULT_VIDEOS_PER_CHANNEL` | `15` | Videos indexed per channel (clamped 5–50 in settings) |
| `DAILY_QUOTA_LIMIT` | `10000` | Your project's daily API quota |
| `QUOTA_WARN_THRESHOLD` | `0.80` | Warn at this fraction of daily quota |
| `QUOTA_ABORT_THRESHOLD` | `0.95` | Abort indexing at this fraction |
| `SYNC_INTERVAL_MINUTES` | `480` | Background sync interval (8 hours) |
| `CONCURRENT_FETCHES` | `3` | Parallel channel fetches during indexing |
| `DEFAULT_SEARCH_TOP_K` | `10` | Search results shown per query |
| `FRESHNESS_WEIGHT` | `0.3` | Recency weight in result ranking |
| `KOFI_USERNAME` | (empty) | Ko-fi handle — leave blank to hide button |
| `GUMROAD_URL` | (empty) | Gumroad product URL — leave blank to hide |
| `SPONSOR_TEXT` | (empty) | Sponsor label — leave blank to hide slot |
| `SPONSOR_URL` | (empty) | Sponsor link |

### Build

```bash
npm run build         # development build (sourcemaps on)
npm run build:prod    # production build (minified)
npm run typecheck     # tsc --noEmit
```

### Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the project root
4. Copy the Extension ID shown on the card
5. Add it to your Google Cloud Console OAuth Client ID's "Application IDs" field

---

## Accounts

SubSearch supports multiple Google accounts. Each account gets its own IndexedDB database (`SubSearchDB_<accountId>`) that is never deleted automatically — switching accounts only moves which one is active.

- **Switch accounts**: open the extension popup → the accounts dropdown in the header lists every account you've indexed. Clicking one makes it active immediately; its existing index is reused as-is, no re-indexing and no data loss. If Chrome's cached OAuth token doesn't match the account you switched to, the popup shows a "sign in required" banner — click **Build Index** to re-authenticate.
- **Add an account**: click **Add account** in the dropdown. This revokes Chrome's currently cached token so the next **Build Index** click brings up Chrome's account picker; choosing a new Google account there indexes it and adds it to the dropdown.

This works around a real limitation of the Chrome Identity API: `chrome.identity.getAuthToken` only ever returns a token for whichever Google account Chrome currently considers primary for this extension — there's no built-in per-account token isolation without `launchWebAuthFlow`. SubSearch's account switching is a workaround, not a true multi-token system: only one account's token can be "hot" at a time, but every account's *data* persists locally regardless of which one is active.

---

## Quota

The 10,000 unit/day quota is shared across **all users** of your extension (it is per Google Cloud project, not per user). Approximate costs:

| Operation | Units |
|---|---|
| Initial index — 500 channels × 15 videos | ~530 |
| Incremental refresh (active channels only) | ~50–100 |
| Search | 0 (local only) |

Apply for a quota increase at `console.cloud.google.com/apis/api/youtube.googleapis.com/quotas` before you exceed ~90 daily active users doing fresh indexes.

The quota tracker in the popup shows **per-device** estimated usage only — there is no cross-user sync (no server). This is a known limitation; a backend would be required for accurate aggregate quota tracking.

---

## Settings

| Setting | Range | Description |
|---|---|---|
| Videos per channel | 5–50 | Higher = more coverage, more quota |
| Default freshness filter | 1 month – All time | Starting filter when overlay opens; changeable per search |
| Show overlay on search pages | on/off | Auto-show overlay on `youtube.com/results` |

"All time" is capped at 5 years internally.

---

## Freshness filter

The search overlay shows a pill-bar filter (1 month / 6 months / 1 year / 18 months / All time). Selecting a window pre-filters videos before Fuse.js scores them — excluded videos are never processed, so narrower filters are faster.

The default filter (shown on overlay open) is set in **Settings → Default freshness filter** and persists in `chrome.storage.sync` across devices.

---

## Privacy

- All data is stored locally on the user's device (IndexedDB, `chrome.storage.sync` for preferences).
- No data is sent to any server operated by this extension.
- YouTube subscription data is fetched via the official YouTube Data API v3 using `youtube.readonly` scope only.
- Uninstalling the extension removes all locally stored data.

---

## Development notes

- `.env` must never be committed — it's gitignored. Commit `.env.example` instead.
- Run `npm run typecheck` before committing to catch type errors.
- Content scripts log to the YouTube page console; filter by `[SubSearch`. Background logs appear in the service worker DevTools panel (`chrome://extensions` → SubSearch → Service Worker link).
