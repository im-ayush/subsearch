import { logger } from "../shared/logger";
import type { Account, Result } from "../shared/types";

const SOURCE = "auth";

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

/**
 * The identity Chrome itself resolves an unpinned getAuthToken() to — the Sync
 * account if the profile has one, else the first Google web account. When this
 * is set, an unpinned interactive request can only ever come back as this
 * account, no matter how many other accounts are signed in on the web.
 */
export async function getProfileIdentity(): Promise<{ email: string; id: string } | null> {
  return new Promise((resolve) => {
    try {
      chrome.identity.getProfileUserInfo({ accountStatus: "ANY" as chrome.identity.AccountStatus }, (info) => {
        resolve(info && info.email ? { email: info.email, id: info.id } : null);
      });
    } catch {
      resolve(null);
    }
  });
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
