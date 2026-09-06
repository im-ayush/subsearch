# CLAUDE.md — SubSearch

## What it is

**SubSearch** is a Chrome extension (Manifest V3) that lets a user search *within their own YouTube subscriptions* — solving "I know I watched this on a channel I follow, but YouTube search won't find it." Solo-developer, local-first, no backend.

**Stack:** TypeScript (compiled away in shipped bundles) → Vanilla JS/Preact, IndexedDB via Dexie.js, Fuse.js fuzzy search, Chrome Identity API for OAuth, esbuild for bundling.

**Canonical current version:** `new_on_claude/v3-1/subsearch_out/` (per user; see "Version sprawl" below for a caveat on this).

---

## Original plan (`SubSearch_Complete_Playbook.docx`)

- **Phase 0–1:** YouTube API compliance (30-day data TTL, `youtube.readonly` scope only, no scraping), Google Cloud Console setup, privacy policy.
- **Phase 2:** 24-day build sequence. Python prototype first (days 1–2) to validate the API, then port to the TypeScript extension.
- **Phase 3–4:** Windows dev setup, Chrome Web Store submission process, monetization via Ko-fi / Gumroad / optional sponsorship.
- **Phase 5–6:** Grassroots launch (Reddit, YouTube comments, Hacker News) with explicit kill criteria: **under 200 installs + under 15% week-1 retention → stop.**
- **Original indexing default:** 100 channels cap, 10 videos each (~106 quota units).

---

## Production review (`SubSearch_Production_Review*.docx`) — pre-mortem on the Python prototype

The review caught one architectural flaw plus a set of prototype→production gaps, before the TS port:

1. **Indexing strategy reversed (biggest change).** The 100-channel cap was the single highest-impact flaw — users with 300–500 subs got arbitrary, unexplained partial coverage. Fix: **index all channels, cap videos-per-channel instead** (15–25). Channel discovery is cheap (~30 units/500 channels); cost scales with videos × channels, so this only raises quota cost ~15–25% while giving complete coverage. A v2 "tiered indexing" (fast pass all channels, then deep pass on top 200) was proposed but not required for v1.
2. **Error handling was too loose.** Prototype silently swallowed non-404 HTTP errors (403 quota, 401 expired token, 429 rate-limit), no retries. Mandated: a `Result<T>` type pattern + exponential-backoff retries before porting to TypeScript.
3. **Security gaps flagged pre-build:** a 0-byte `credentials.json` committed to the repo (critical — remove/rotate even though empty); `token.json` stored unencrypted (moot post-port, `chrome.identity` replaces it, but still fixed in the prototype); pre-emptive requirements for code not yet written — CSP in manifest, `textContent` over `innerHTML`, sender-origin validation on message passing.
4. **Hardcoded values → named constants** (`MIN_RELEVANCE_THRESHOLD`, `FRESHNESS_WEIGHT`, `MAX_DESCRIPTION_CHARS`, etc.) — config hygiene before the TS port.
5. **New feature: freshness filter.** Segmented control (6mo/1yr/18mo/all-time) as a pre-search gate before Fuse.js scoring, persisted via `chrome.storage.sync`. Explicitly noted as meaningless until fix #1 (all-channels indexing) ships — a freshness filter over incomplete coverage is misleading.
6. **Performance additions not in the original playbook:** batch IndexedDB writes (`bulkPut` vs per-item `put`), controlled concurrency (3–5 parallel channel fetches instead of sequential), cached Fuse instance invalidation, full logging/observability layer (DEBUG/INFO/WARN/ERROR persisted to an IndexedDB `logs` table, "Copy debug log" button in popup for support).
7. **Build sequence revised** to front-load these fixes — CSP + strict TypeScript moved to days 3–4; logger wired in at days 7–8 "before any other module."

**Net effect:** the playbook was the build/launch plan; the review is a pre-mortem that caught one architectural flaw (arbitrary channel cutoff) that would've undermined the core value prop, plus typical prototype→production security/reliability gaps. Growth/monetization/launch strategy from the playbook is **unchanged**.

---

## Verified current state of `v3-1/subsearch_out`

Checked directly against the shipped bundle (`background.js`, `content.js`, `popup.js`, `manifest.json`) — not just against docs, which are stale/conflicting (see below).

| Review requirement | Status | Evidence |
|---|---|---|
| All-channels indexing (no 100-cap) | ✅ Implemented | Subscriptions fetched via paginated `nextPageToken` loop; `videosPerChannel` (not a channel count) is the clamped setting (5–50) |
| Videos-per-channel cap replacing channel cap | ✅ Implemented | `DEFAULT_VIDEOS_PER_CHANNEL = 15`, clamped `Math.max(5, Math.min(50, ...))` before indexing |
| `Result<T>` pattern + exponential backoff | ✅ Implemented | `{ok, value/error, retryable}` returns; `RETRY_BASE_DELAY_MS * 2^attempt` backoff, `MAX_RETRY_ATTEMPTS`, distinct handling for 403/401/429 vs transient errors |
| CSP in manifest | ✅ Implemented | `"script-src 'self'; object-src 'none'; style-src 'self' 'unsafe-inline'"` |
| `textContent` over `innerHTML` | ✅ Implemented | All dynamic UI (titles, channel names, status text) uses `textContent`; the one `innerHTML` use in `content.js` is a static inline SVG icon with no external/user data |
| Sender-origin validation on messages | ✅ Implemented | `sender.id !== chrome.runtime.id` check rejects unknown senders in the background message handler |
| Named constants (not hardcoded) | ✅ Implemented | `MAX_DESCRIPTION_CHARS`, `CONCURRENT_FETCHES`, `FRESHNESS_WEIGHT`, etc. all top-level consts, `.env`-driven at build time |
| Freshness filter | ✅ Implemented | Pill-bar filter (1mo/6mo/1yr/18mo/all-time), pre-filters before Fuse scoring, persisted via `chrome.storage.sync` under `subsearch_freshness_months` |
| Batched IndexedDB writes | ✅ Implemented | `db.table("videos").bulkPut(...)`, `db.table("channels").bulkPut(...)` |
| Controlled concurrency | ✅ Implemented | `withConcurrency(channels, CONCURRENT_FETCHES, ...)`, default 3 parallel |
| Logging/observability layer | ✅ Implemented | `initLogger`, `logger.debug/info/warn/error`, persisted to IndexedDB `logs` table, `GET_DEBUG_LOG` message for popup's copy-log button |
| `credentials.json`/`token.json` removed | ✅ N/A in this branch | Auth is `chrome.identity` only; no such files present in `subsearch_out` |
| `manifest.json` present | ✅ Present | Earlier docs (`new_on_claude/CLAUDE.md`, `v3-1/CLAUDE.md`) claim it's missing — **stale**, it exists in `subsearch_out` |

### What is *not* as required (gaps against the review / stated design)

- **Monetization constants hardcoded, not `.env`-driven.** `popup.js` has `KOFI_ENABLED: true`, `KOFI_USERNAME: "yourhandle"`, `GUMROAD_ENABLED: true`, `GUMROAD_URL: "https://gumroad.com/l/subsearch"` as literal placeholder values, even though `.env` has `KOFI_USERNAME=`, `GUMROAD_URL=` blank (meant to hide the buttons when empty). The build did not pick up `.env` for this block — same defect flagged in the earlier `new_on_claude/CLAUDE.md` review, **still unfixed** in v3-1.
- **`phase1Complete`/`phase2Complete` legacy fields** still present in `indexState` schema, always set together, dead weight from a pre-review two-phase design. Cosmetic, safe to remove.
- **No build tooling in the shipped snapshot.** `subsearch_out` is bundle output only — no `package.json`, `esbuild.config.js`, `node_modules/`, or `src/` TypeScript source. Anyone picking this up has to reconstruct the build pipeline from `// src/...` comments inside the bundles, or use the source elsewhere (see below).
- **`README.md` inside `subsearch_out` is stale/wrong for this branch.** It describes the *single-account* v2 design (`⇄ Switch Account` button revokes token + clears index) but the code in the same folder implements the *multi-account* design (`background.js`/`popup.js` have an "Accounts" dropdown, per-account Dexie DBs, `SWITCH_ACCOUNT`/`ADD_ACCOUNT` messages — DB is never cleared on switch). Docs and code disagree; **trust the code**, not this README.
- **Chrome Identity API single-token constraint** (architectural, not a bug): `chrome.identity.getAuthToken` returns the token for whichever Google account Chrome considers primary for the extension origin. True per-account token isolation would need `launchWebAuthFlow`. Current workaround: on mismatch, revoke + return `needsAuth: true`, popup shows a re-auth banner. This is a known, accepted limitation, not something the review asked to fix.
- **Quota tracking is per-device only**, no server-side aggregate — matches the original design (no backend), not a defect, but still a real limitation the review didn't ask to solve.

---

## Architecture (as implemented in `v3-1/subsearch_out`)

| Layer | Technology | File |
|---|---|---|
| Service worker | Chrome MV3 background, `type: module` | `background.js` |
| Storage | Per-account IndexedDB via Dexie.js | `background.js` |
| Account registry | `chrome.storage.local` (`subsearch_accounts`, `subsearch_active_account`) | `background.js` |
| Auth | Chrome Identity API (OAuth 2, `youtube.readonly` scope) | `background.js` |
| Account identity | Google userinfo endpoint (`/oauth2/v3/userinfo`) | `background.js` |
| YouTube API | YouTube Data API v3, paginated | `background.js` |
| Indexer | Single-phase, concurrent (`CONCURRENT_FETCHES=3`), all channels × capped videos-per-channel | `background.js` |
| Background sync | Chrome Alarms API, every `SYNC_INTERVAL_MINUTES` (default 480 = 8h) | `background.js` |
| Search | Fuse.js fuzzy search, in-memory, freshness pre-filter | `content.js` |
| Content UI | Shadow DOM overlay injected on `youtube.com` | `content.js` / `content.css` |
| Popup | Accounts dropdown, index status, quota, debug-log copy, monetization links | `popup.js` / `popup.html` |
| Settings | Options page (videos-per-channel, default freshness, overlay toggle) | `options.js` / `options.html` |

### Multi-account design

Each Google account gets its own Dexie DB: `SubSearchDB_<accountId>` (`accountId` = stable Google `sub`). Switching accounts **never deletes data** — old DB is left alone, only the active pointer moves. Logs are shared across accounts in `SubSearchDB_logs`.

- **Identify:** `runFullIndex()` → `fetchAccountInfo(token)` → `upsertAccount()` + `setActiveAccountId()`.
- **Switch:** `SWITCH_ACCOUNT` → move active pointer → try silent `getAuthToken` → verify via userinfo → on mismatch, revoke + `needsAuth: true` (popup shows yellow re-auth banner).
- **Add:** `ADD_ACCOUNT` → revoke cached token (forces Chrome's account picker) → user clicks "Build Index" → new account auto-discovered and registered.
- Single-account use behaves identically to the old v1/v2 flow.

### Message protocol

| Message | Direction | Response | Notes |
|---|---|---|---|
| `START_INDEX` | popup → background | `INDEX_STATE` | |
| `GET_INDEX_STATE` | popup → background | `INDEX_STATE` + `activeAccountId` | |
| `GET_VIDEOS` | content → background | `VIDEOS` + `INDEX_STATE` | Active account's DB |
| `GET_QUOTA_STATUS` | popup → background | `QUOTA_STATUS` | Per-device estimate only |
| `GET_DEBUG_LOG` | popup → background | `DEBUG_LOG` | From shared logs DB |
| `CLEAR_INDEX` | popup → background | `OK` | Active account only |
| `GET_ACCOUNTS` | popup → background | `ACCOUNTS` + `activeAccountId` | |
| `SWITCH_ACCOUNT` | popup → background | `SWITCH_ACCOUNT_RESULT` | No DB clear |
| `ADD_ACCOUNT` | popup → background | `OK` | Revokes token, prompts re-auth |
| `RE_AUTH` | popup → background | `OK` | Legacy alias for `ADD_ACCOUNT` |
| `FORCE_INCREMENTAL_REFRESH` | popup → background | `OK` | |

All background message handling validates `sender.id === chrome.runtime.id` before processing.

### IndexedDB schema (Dexie, v1, per-account)

```
channels:   id (PK), title
videos:     id (PK), channelId (indexed), publishedAt (indexed), channelName (indexed)
indexState: id (PK)

SubSearchDB_logs (shared, not per-account):
logs: ++id (auto PK), level (indexed), timestamp (indexed), source (indexed)
```

### Configuration (`.env`, inlined at build time via esbuild `--define`, not secret at runtime)

| Variable | Default | Notes |
|---|---|---|
| `OAUTH_CLIENT_ID` | (set) | Public, safe to share |
| `DEFAULT_VIDEOS_PER_CHANNEL` | 15 | Clamped 5–50 in settings |
| `DAILY_QUOTA_LIMIT` | 10000 | Per Google Cloud project, shared across all users |
| `QUOTA_WARN_THRESHOLD` | 0.80 | |
| `QUOTA_ABORT_THRESHOLD` | 0.95 | |
| `SYNC_INTERVAL_MINUTES` | 480 | |
| `CONCURRENT_FETCHES` | 3 | Keep at 3 to avoid 429s |
| `DEFAULT_SEARCH_TOP_K` | 10 | |
| `FRESHNESS_WEIGHT` | 0.3 | |
| `KOFI_USERNAME` / `GUMROAD_URL` / `SPONSOR_TEXT` / `SPONSOR_URL` | (empty) | **Not actually wired into `popup.js`** — see gaps above |

### Quota cost reference

| Operation | Units |
|---|---|
| Subscriptions page (50 results) | 3 |
| Channel batch (50 channels) | 3 |
| Playlist items page | 1 |
| Search | 0 (local only) |
| Full index, 500 channels × 15 videos | ~530 |
| Incremental refresh (active channels only) | ~50–100 |

---

## Version sprawl in this folder — read before trusting any single subfolder

There are many partial/duplicate copies under `new_on_claude/`, not in chronological order by name:

| Folder | Last modified | Notes |
|---|---|---|
| `subsearch-extension/` | — | Earliest, "v1" |
| `v2/` | — | `subsearch_v1_fixed` |
| `v3/` | — | `subsearch_v2_fixed` |
| `v3-0/` | — | Has `manifest.json` + `.env` directly, single-account |
| `v4/subsearch_multi_account/` | **2026-05-09** | Multi-account, but *older* than v3-1 despite the "v4" name |
| `v3-1/subsearch_out/` | **2026-05-28** | Multi-account, newest by modification time — treated as canonical here per user instruction |

**"v4" is chronologically older than "v3-1."** Folder names do not reflect build order — if reconciling code between them, verify by content/mtime, not by name.

Outside `new_on_claude/`, the repo root also has: `subsearch/`, `subsearch-py/` (Python prototype, has its own `.venv`), `subsearch-python-prototype-zip.zip`, `proper/subsearch/` (a git repo), `creds/`, `extra/`, and several `.docx`/`.zip` snapshots. `proper/subsearch` is the only folder that is an actual git repository — everything else is a flat snapshot with no version control.

---

## Known limitations (accepted, not defects)

- Chrome Identity API returns one token per Chrome-primary-account; true multi-account token isolation would need `launchWebAuthFlow`.
- Quota tracking is per-device; no backend, no cross-user aggregate.
- "All time" freshness filter caps at 5 years (1825 days) internally.
