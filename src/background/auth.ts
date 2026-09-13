import { logger } from "../shared/logger";
import { OAUTH_SCOPES, OAUTH_WEB_CLIENT_ID } from "../shared/constants";
import type { Account, Result } from "../shared/types";

const SOURCE = "auth";
const SESSION_TOKEN_PREFIX = "subsearch_token_";
/** Treat a token as spent this long before its real expiry, so an index run can't start on one about to die. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

interface SessionToken {
  token: string;
  expiresAt: number;
}

/**
 * Tokens from launchWebAuthFlow have no home in Chrome's own token cache, so
 * they live in chrome.storage.session — memory-only, cleared when the browser
 * closes, and (unlike a module variable) still there after the MV3 service
 * worker unloads.
 */
export async function saveSessionToken(accountId: string, token: string, expiresInSec: number): Promise<void> {
  const entry: SessionToken = { token, expiresAt: Date.now() + expiresInSec * 1000 };
  await chrome.storage.session.set({ [SESSION_TOKEN_PREFIX + accountId]: entry });
}

async function readSessionToken(accountId: string): Promise<string | null> {
  const key = SESSION_TOKEN_PREFIX + accountId;
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key] as SessionToken | undefined;
  if (!entry || entry.expiresAt <= Date.now() + TOKEN_EXPIRY_MARGIN_MS) return null;
  return entry.token;
}

/**
 * Google's real account chooser, via launchWebAuthFlow. We build the auth URL
 * ourselves, which is the only way to set `prompt=select_account` —
 * getAuthToken() offers no such parameter and always resolves to Chrome's
 * profile identity, so it can never be used to pick a different account.
 *
 * Uses the implicit flow (`response_type=token`): it returns the access token
 * straight back on the redirect fragment, avoiding a token-endpoint exchange
 * that would require embedding a client secret in the extension.
 */
export async function launchAccountPicker(): Promise<Result<{ token: string; expiresIn: number }>> {
  if (!OAUTH_WEB_CLIENT_ID) {
    return { ok: false, error: "OAUTH_WEB_CLIENT_ID is not set — add it to .env and rebuild.", retryable: false };
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", OAUTH_WEB_CLIENT_ID);
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  authUrl.searchParams.set("prompt", "select_account");

  logger.info(SOURCE, "launching account picker", { redirectUri });

  try {
    const responseUrl = await new Promise<string | null>((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true }, (url) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(url ?? null);
      });
    });

    if (!responseUrl) {
      return { ok: false, error: "Sign-in window was closed before completing", retryable: false };
    }

    const params = new URLSearchParams(responseUrl.split("#")[1] ?? "");
    const error = params.get("error");
    if (error) {
      logger.warn(SOURCE, "account picker returned an error", { error });
      return { ok: false, error: `Google returned: ${error}`, retryable: false };
    }
    const token = params.get("access_token");
    if (!token) {
      return { ok: false, error: "No access token in the sign-in response", retryable: false };
    }
    return { ok: true, value: { token, expiresIn: Number(params.get("expires_in")) || 3600 } };
  } catch (err) {
    logger.warn(SOURCE, "launchAccountPicker failed", { err: String(err) });
    return { ok: false, error: String(err), retryable: false };
  }
}

/**
 * `accountId` is the account's Gaia ID — the same value Google's userinfo
 * endpoint returns as `sub`, which is what we key the per-account DBs on.
 * Passing it pins the request to that specific account; omitting it makes
 * Chrome fall back to the Sync account, or else the first Google web account,
 * which is why unpinned requests keep returning the same identity.
 */
export async function getAuthToken(
  interactive = false,
  accountId?: string
): Promise<Result<{ token: string; expiresAt: null }>> {
  const details: chrome.identity.TokenDetails = { interactive };
  if (accountId) details.account = { id: accountId };
  try {
    const token = await new Promise<string | null>((resolve, reject) => {
      chrome.identity.getAuthToken(details, (token) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(token ?? null);
      });
    });
    if (!token) {
      return { ok: false, error: "No auth token returned", retryable: false };
    }
    return { ok: true, value: { token, expiresAt: null } };
  } catch (err) {
    logger.warn(SOURCE, "getAuthToken failed", { interactive, accountId, err: String(err) });
    return { ok: false, error: String(err), retryable: interactive };
  }
}

export async function getTokenForAccount(accountId: string, hint: string): Promise<Result<{ token: string }>> {
  // A token from the account picker is checked first: for an account that
  // isn't Chrome's profile identity, it is the only one that will work.
  const sessionToken = await readSessionToken(accountId);
  if (sessionToken) return { ok: true, value: { token: sessionToken } };

  const result = await getAuthToken(false, accountId);
  if (!result.ok) {
    logger.warn(SOURCE, "no silent token for account", { accountId, hint, error: result.error });
    return { ok: false, error: result.error, retryable: false };
  }
  return { ok: true, value: { token: result.value.token } };
}

export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(token)}`);
  } catch (err) {
    logger.warn(SOURCE, "revoke request failed", { err: String(err) });
  }
  await new Promise<void>((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

export async function refreshToken(
  staleToken: string,
  accountId?: string
): Promise<Result<{ token: string; expiresAt: null }>> {
  await revokeToken(staleToken);
  return getAuthToken(false, accountId);
}

export async function fetchAccountInfo(
  token: string
): Promise<Pick<Account, "id" | "email" | "displayName" | "picture"> | null> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { sub: string; email: string; name: string; picture: string };
    return { id: data.sub, email: data.email, displayName: data.name, picture: data.picture };
  } catch (err) {
    logger.warn(SOURCE, "fetchAccountInfo failed", { err: String(err) });
    return null;
  }
}
