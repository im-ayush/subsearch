# CLAUDE.md — SubSearch

## What it is

**SubSearch** is a Chrome extension (Manifest V3) that lets a user search *within their own YouTube subscriptions* — solving "I know I watched this on a channel I follow, but YouTube search won't find it." Solo-developer, local-first, no backend.

**Stack:** TypeScript → esbuild bundles (`background.js`, `content.js`, `popup.js`, `options.js`), IndexedDB via Dexie.js, Fuse.js fuzzy search, Chrome Identity API + `launchWebAuthFlow` for OAuth.

**This repo (`proper/subsearch`) is the canonical codebase.** It is the only git repository and the only copy with TypeScript source and build tooling. The many snapshots under `new_on_claude/` (v2, v3, v3-0, v3-1, v4…) are older bundle-only exports — do not reconcile against them. `README.md` in this repo is partly stale (says 5–50 videos/channel and single-client auth); trust this file and the code.

**User's own backlog lives in `FUTURE.md`** (untracked). Check it before proposing "next steps."

---

## Working in this repo

- **Build:** `npm run build` (esbuild, inlines `.env` via `define`). **Type-check:** `npx tsc --noEmit` — strict; keep it clean.
- **Test loop:** rebuild → `chrome://extensions` → reload SubSearch → **refresh any open YouTube tab** (a tab open across a reload keeps an orphaned content script; the extension now shows a "refresh this page" toast for that case).
- **Verify before claiming:** the user tests manually and reports symptoms precisely. Always end a change with what to reload and what to click.
- **`.env` is gitignored** and holds two public OAuth client IDs (see Configuration). `.env.example` documents every key.
- **Memory notes** for Claude sessions live outside the repo (`~/.claude/projects/…/memory/`) — user preferences and decision rationale; this file is the in-repo source of truth.

---

## Original plan (`SubSearch_Complete_Playbook.docx`) — condensed

- Phase 0–1: YouTube API compliance (30-day data TTL, `youtube.readonly` scope only, no scraping), Cloud Console setup, privacy policy.
- Phase 2: Python prototype to validate the API, then port to the TypeScript extension.
- Phase 3–4: Chrome Web Store submission; monetization via Ko-fi / Gumroad / optional sponsor (all `.env`-gated, hidden when blank).
- Phase 5–6: grassroots launch with kill criteria: **under 200 installs + under 15% week-1 retention → stop.** (See "Quota" below — 200 active users exceeds today's API ceiling; this must be solved before launch.)

## Production review (`SubSearch_Production_Review*.docx`) — what it mandated, all implemented here

1. **Index all channels, cap videos-per-channel** (not a channel cap) — the single highest-impact fix; arbitrary partial coverage undermines the core promise.
2. `Result<T>` pattern + exponential backoff; distinct handling for 401/403/429.
3. Security: CSP in manifest, `textContent` over `innerHTML` (one static-SVG exception in `content/index.ts`), `sender.id` validation on every message.
4. Named constants over magic numbers (`constants.ts`).
5. Freshness filter as a pre-search gate (1mo/6mo/1yr/18mo/all-time; "all time" capped at 5 years).
6. Batched IndexedDB writes, bounded concurrency (3), persisted logging with a "Copy debug log" button.

---

## Architecture (as implemented)

| Layer | Technology | Where |
|---|---|---|
| Service worker | MV3 background, `type: module` | `src/background/index.ts` (message router) |
| Auth | `chrome.identity.getAuthToken` (default account, silent refresh) **+** `chrome.identity.launchWebAuthFlow` (account chooser) | `src/background/auth.ts` |
| Account registry / switching | `chrome.storage.local` | `src/storage/db.ts`, `src/background/account-switcher.ts` |
| YouTube Data API v3 | paginated `subscriptions`, `channels`, `playlistItems` | `src/background/api.ts` |
| Indexer | single pass, all channels × capped videos; pinned channels get full history | `src/background/indexer.ts` |
| Background sync | Alarms every `SYNC_INTERVAL_MINUTES` (480) | `src/background/sync.ts` |
| Storage | one Dexie DB per account + shared logs DB | `src/storage/db.ts` |
| Search | Fuse.js, in-memory, freshness pre-filter, recency boost | `src/search/engine.ts` |
| Content UI | overlay + floating button on **every** youtube.com page | `src/content/index.ts`, `overlay.ts`, `router.ts`, `content.css` |
| Popup | quick panel: accounts dropdown, status, index/refresh/clear, quota, auto-open toggle, debug log | `src/popup/index.ts`, `popup.html` |
| Options | **full setup page**: account & index card, pinned channels, preferences | `src/options/index.ts`, `options.html` |
| Shared status text | one formatter used by popup and Options | `src/shared/status.ts` |

### Auth & multi-account — two OAuth clients, on purpose

- `OAUTH_CLIENT_ID` — **"Chrome App"** type client (manifest `oauth2`). Used by `getAuthToken()` for the default account and for silent, **pinned** token refresh (`getAuthToken(false, accountId)` — the `account.id` is the Google `sub`/Gaia ID we already key DBs on).
- `OAUTH_WEB_CLIENT_ID` — **"Web application"** type client ("Subsearch MultiAccount", same Cloud project). Used by `launchWebAuthFlow()` for **Add account** with `prompt=select_account`, which is the *only* way to force Google's account chooser. Requires an Authorized redirect URI of `https://<extension-id>.chromiumapp.org/` on that client.
- **Why two:** `getAuthToken` always resolves to Chrome's profile identity ("the Sync account, else the first Google web account") and exposes no chooser parameter, so a second account could never be selected. A "Chrome App" client cannot be reused for `launchWebAuthFlow` — that client type has no redirect-URI field in Cloud Console at all (`redirect_uri_mismatch`). The user asked why one client wouldn't do; that is the answer. **Do not collapse back to one client.**
- The picker uses the **implicit flow** (`response_type=token`) specifically to avoid a token-endpoint exchange that would require embedding a client secret.
- Picker tokens live in **`chrome.storage.session`** keyed by account (`subsearch_token_<id>`): memory-only, cleared on browser close, survives service-worker unload. `getTokenForAccount()` checks there first, then falls back to pinned `getAuthToken`.
- **Never pin an interactive request.** Pinning `getAuthToken(true, id)` makes Chrome hard-fail if the user authenticates as a different account — exactly what adding a second account does. Pins are for silent calls only. (This was a real regression during development.)
- Switching accounts never deletes data — only the active pointer moves. "Add account" registers and activates; it does **not** index (one action per control).

### Pinned channels (deep index)

- **Framing:** deep history *on top of* the all-channels baseline — never "index only selected." Baseline = latest `videosPerChannel` (5–200, default 15) for every subscription; pins = everything within the 5-year window, safety ceiling `DEEP_MAX_VIDEOS_PER_CHANNEL = 2000`.
- **Hard cap: `MAX_PINNED_CHANNELS = 10`** (user decision — do not raise without asking). Enforced in UI and background.
- Pins stored in `chrome.storage.local` (`subsearch_pinned_<accountId>`), not on channel rows, so rebuilds and "Clear index" never wipe them.
- Pin → immediate deep backfill (`applyPinChanges`); unpin → trims that channel back to the baseline count, no API cost. Full rebuilds and incremental syncs honor pins automatically (`fetchOptionsFor`).
- Progress tracked in separate `deep*` fields on `IndexState` so the baseline counters and `lastFullIndexAt` are never disturbed.
- Cost preview in Options uses `Channel.videoCount`, captured free by adding `statistics` to the existing `channels.list` call (extra parts cost no quota). Channels indexed before that field existed show "up to N" until the next rebuild.
- Transparency: popup/overlay status says `· N pinned`; results from pinned channels carry a "Pinned" chip.

### Overlay & onboarding UX decisions

- **Floating button on every YouTube page** (not just results) — the always-present entry point. First-run: pulse ring + dismissible callout explaining the button and `Ctrl/⌘+Shift+F`. Marked seen (`subsearch_fab_intro_seen`, local) only when the user opens the overlay *themselves* or dismisses — an auto-open doesn't count.
- **Auto-open on YouTube search** is one preference (`overlayEnabled`) reachable from three places: overlay footer toggle, popup toggle, Options. Default on, **but gated on an index existing** — a modal that can only say "not indexed yet" is pure interruption. No snooze (off + button *is* the snooze); no in-extension "disable" (Chrome's toggle already is that, since we only run on youtube.com).
- **Query prefill:** overlay reads `search_query` from the URL at open time and searches immediately, cursor at end for refinement. Works from auto-open, button, and shortcut.
- **Zero-result state is evidence-based:** on a miss it re-runs at "All time"; if matches exist it says "N older matches hidden by the 6 months filter" with **Show all time**; otherwise explains the per-channel baseline with **Pin a channel →** (opens `options.html#pinned`, scrolls, focuses the filter). A failed search is the churn moment; this turns it into the feature's best case.
- **Options is the full "home" page** (Chrome opens it on install). Step-aware **Account & Index** card: no account → Connect; account → Build with live progress; indexed → status. The pin list populates by itself when a run finishes. Completion is detected by `lastFullIndexAt` *changing*, not by catching a "busy" poll tick — a small account finishes an entire index inside one 2s gap.
- **No dead-end surfaces:** every empty/blocked state offers its own unblocking action in place. Walk each surface as a brand-new installer before shipping.
- **Orphaned content scripts** (extension reloaded or auto-updated under an open tab) show an inline-styled "SubSearch was updated — refresh this page" toast instead of failing silently.

---

## Message protocol (`src/shared/messages.ts`)

All handlers validate `sender.id === chrome.runtime.id`.

| Message | From | Response | Notes |
|---|---|---|---|
| `START_INDEX` | popup/options | `INDEX_STATE` | pinned silent token first, unpinned interactive fallback |
| `GET_INDEX_STATE` | popup/options/content | `INDEX_STATE` (+ `pinnedCount`) | |
| `GET_VIDEOS` | content | `VIDEOS` (+ `pinnedChannelIds`) | active account's DB |
| `GET_CHANNELS` | options | `CHANNELS` (+ `accountEmail`, `maxPinned`) | sorted by title |
| `SET_PINNED_CHANNELS` | options | `OK` / `ERROR` | enforces cap; kicks off `applyPinChanges` |
| `OPEN_SETTINGS` | content | `OK` | content scripts can't call `openOptionsPage`; opens `options.html#pinned` |
| `GET_QUOTA_STATUS` | popup | `QUOTA_STATUS` | **per-device counter only** (see Quota) |
| `GET_DEBUG_LOG` | popup | `DEBUG_LOG` | shared logs DB |
| `CLEAR_INDEX` | popup | `OK` | active account only; pins survive |
| `GET_ACCOUNTS` | popup/options | `ACCOUNTS` | |
| `SWITCH_ACCOUNT` | popup/options | `SWITCH_ACCOUNT_RESULT` | no DB clear; `needsAuth` on token mismatch |
| `ADD_ACCOUNT` / `RE_AUTH` | popup/options | `ADD_ACCOUNT_RESULT` | picker → register → activate; **no indexing** |
| `FORCE_INCREMENTAL_REFRESH` | popup | `OK` | |

## Storage

```
Per account (Dexie v1, SubSearchDB_<accountId>):
  channels:   id (PK), title            + uploadsPlaylistId, lastVideoAt, videoCount?
  videos:     id (PK), channelId, publishedAt, channelName  (+ title, description ≤300, thumbnailUrl)
  indexState: id (PK)  — status, counters, quota, lastProcessedChannelId,
                         deepStatus, deepProcessedChannels, deepTotalChannels, lastDeepIndexAt
  (readIndexState spreads DEFAULT_INDEX_STATE under stored rows: new fields need no migration)

Shared: SubSearchDB_logs — logs: ++id, level, timestamp, source

chrome.storage.sync:    subsearch_prefs (videosPerChannel, freshnessMonths, overlayEnabled), subsearch_freshness_months
chrome.storage.local:   subsearch_accounts, subsearch_active_account, subsearch_pinned_<accountId>, subsearch_fab_intro_seen
chrome.storage.session: subsearch_token_<accountId>  (picker access tokens, ~1h)
```

## Configuration (`.env`, inlined at build; public, not secret)

| Variable | Default | Notes |
|---|---|---|
| `OAUTH_CLIENT_ID` | (set) | Chrome App client — `getAuthToken` |
| `OAUTH_WEB_CLIENT_ID` | (set) | Web application client — `launchWebAuthFlow`; needs chromiumapp.org redirect URI |
| `DEFAULT_VIDEOS_PER_CHANNEL` | 15 | clamped **5–200** (`MIN/MAX_VIDEOS_PER_CHANNEL`) |
| `DAILY_QUOTA_LIMIT` | 10000 | per Cloud project, **shared by all users** |
| `QUOTA_WARN/ABORT_THRESHOLD` | 0.80 / 0.95 | against the local counter — protects little in practice |
| `SYNC_INTERVAL_MINUTES` | 480 | |
| `CONCURRENT_FETCHES` | 3 | keep at 3 to avoid 429s |
| `DEFAULT_SEARCH_TOP_K` / `FRESHNESS_WEIGHT` | 10 / 0.3 | |
| `KOFI_USERNAME` / `GUMROAD_URL` / `SPONSOR_*` | blank | blank = hidden; wired via `src/monetization/config.ts` |

Code constants: `MAX_PINNED_CHANNELS = 10`, `DEEP_MAX_VIDEOS_PER_CHANNEL = 2000`, `DEFAULT_MAX_AGE_DAYS = 1825`.

---

## Quota — the top open concern

**Costs** (`playlistItems` = 1 unit / 50 videos; `subscriptions`, `channels` = 3 / page of 50):

| Activity | Units |
|---|---|
| Onboarding, 200 subs × 15 | ~230 |
| Onboarding, 500 subs × 15 | ~530 |
| Incremental sync, active channels | ~30 per run (3×/day) — after the pagination fix below |
| Pin one channel (full history) | `ceil(min(videoCount, 2000) / 50)`, max 40 |
| Search | 0 (local) |

**Fixed 2026-09-13:** `fetchVideosForChannel` treated `publishedAfter` as a filter — it *skipped* older items but kept paginating, so an incremental sweep of a 1,000-video channel spent 20 units to find two new uploads. It now **stops** at the boundary. The same boundary gives deep mode its time window.

**The problem (discussed 2026-09-15):** 10,000 units/day is **per Cloud project, shared across every installed copy**. The popup shows a *local, per-device* counter against that *global* limit — wrong in both directions. Steady state ≈ 100 units/user/day → roughly **20–100 daily-active users saturate the pool**, after which *everyone* gets 403 `quotaExceeded` until midnight Pacific. The playbook's own success bar (200 installs) sits above this ceiling. Per-user rationing was considered and rejected: it needs a backend to know N, it doesn't prevent exhaustion (just decides who is refused), and the share shrinks with every install.

**Agreed direction:**
1. **Display fix (next, cheap):** stop showing 10,000; show "~N units used today by this device"; on 403 `quotaExceeded` say plainly that YouTube's shared daily limit is used up, search still works, indexing resumes after midnight Pacific.
2. **Apply for a quota extension** via Google's YouTube API audit form (free, weeks; needs the Phase 0–1 privacy/compliance work). Raises the ceiling, keeps the shared shape. (In `FUTURE.md`.)
3. **RSS for the baseline — the real fix.** YouTube's official per-channel Atom feed (`youtube.com/feeds/videos.xml?channel_id=UC…`) returns the latest 15 videos with title/id/date/description/thumbnail at **zero quota, no auth** — exactly the baseline index. Baseline build + every incremental sync could run on it; the API would only serve the subscriptions list (~30 units/500 channels) and pins. Steady state → ~0 units/user/day; pool supports thousands. Caveats: revisit the playbook's "no scraping" stance (RSS is official syndication, not HTML scraping — belongs in the compliance review); MV3 service workers lack `DOMParser`, so it needs a small purpose-built parser for a handful of known tags.
4. **BYOK** (user's own Cloud project → own 10k) as a power-user escape hatch later; feasible via the `launchWebAuthFlow` path. (In `FUTURE.md`.)

---

## Decision log — 2026-09-06 → 2026-09-15

- **09-06 — Overlay looked broken (padding, close button, white buttons).** Root cause: `overlay.ts` generated class names (`ss-title`, `ss-close`, `ss-pill`) that didn't exist in `content.css` (`ss-logo`, `ss-close-btn`, `ss-filter-btn`), so elements rendered with browser defaults. Aligned names and DOM structure. Committed `c6c3a61`.
- **09-06 → 09-13 — "Add account does nothing."** Multi-round investigation. In order: (a) the 3s status poll was overwriting the "ready to add" hint (real, not the cause); (b) pinning the *interactive* `getAuthToken` to the active account — **a regression** that hard-failed when a different account was picked; (c) the underlying wall: `getAuthToken` cannot force a chooser. Lesson recorded: for `chrome.*` behaviour, confirm the mechanism or add a diagnostic before shipping a fix — three speculative rounds cost real rebuild-reload-retest cycles. Resolved by the dual-client `launchWebAuthFlow` design above.
- **09-13 — "Add account" reused "Build index" logic** (user: "why not take reference from the working code?"), then **split again** when adding also started indexing (user: "add should only pick an account; build should only index"). Net: reuse *internals*, keep *one action per control*. Account registration extracted into `addNewAccount()`.
- **09-13 — Query prefill, floating button on all pages, first-run callout, auto-open controls** (toggle in three places, gated on an index existing). Snooze and in-extension disable deliberately not built.
- **09-13 — Pinned channels, Phases 0–2** (see section above). Phase 3 "mute/exclude channels" parked unless users ask — riskier (silent misses).
- **09-13 — Options became the full setup page** after the user walked the fresh-install path: post-install page had a pin list saying "build your index first" with no way to do so. Fixed the split of responsibilities; empty states now point *up* to the action, not away.
- **09-14 — Orphaned-content-script toast** (extension reload / auto-update under an open tab).
- **09-15 — Quota scaling discussion** (section above). No code change yet; display fix is next.

## Next work (agreed / pending)

1. Quota display fix + `quotaExceeded` messaging (agreed 09-15).
2. Apply for YouTube API quota extension (`FUTURE.md`).
3. RSS-backed baseline index (architectural; biggest scaling lever).
4. Refresh `README.md` (stale: 5–50 clamp, single-client auth).
5. `FUTURE.md` items: "write to us" feedback channel, better ranking (channel/title/description/date/duration), BYOK.

## Known limitations (accepted for now)

- Picker-issued tokens last ~1 hour with no refresh token; the 8-hour sync on a **non-primary** account will eventually need re-auth. Fix with a `prompt=none` silent re-auth only if it becomes a real annoyance.
- Quota tracking is per-device; there is no cross-user aggregate and no backend.
- "All time" caps at 5 years; deep index uses the same window.
- Fuse.js is in-memory O(n): fine to ~20k videos, noticeable past ~50k — another reason for the 10-pin cap.
- YouTube API 30-day data-TTL policy: deep history increases the volume of stored metadata subject to it; address in the privacy notes before launch.
