import { logger } from "../shared/logger";
import type { Account, Result } from "../shared/types";

const SOURCE = "auth";

/**
 * Chrome only caches one OAuth token per extension origin (whichever Google
 * account Chrome considers primary) — there is no true per-account token
 * isolation without launchWebAuthFlow. `hint` (the account's email) is only
 * used for logging context here; callers verify the returned token actually
 * belongs to the expected account via fetchAccountInfo.
 */
export async function getTokenForAccount(accountId: string, hint: string): Promise<Result<{ token: string }>> {
  try {
    const token = await new Promise<string | null>((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: false }, (token) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(token ?? null);
      });
    });
    if (!token) {
      return { ok: false, error: "No cached token available", retryable: false };
    }
    return { ok: true, value: { token } };
  } catch (err) {
    logger.warn(SOURCE, "getTokenForAccount failed", { accountId, hint, err: String(err) });
    return { ok: false, error: String(err), retryable: false };
  }
}

export async function getAuthToken(interactive = false): Promise<Result<{ token: string; expiresAt: null }>> {
  try {
    const token = await new Promise<string | null>((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
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
    logger.warn(SOURCE, "getAuthToken failed", { interactive, err: String(err) });
    return { ok: false, error: String(err), retryable: interactive };
  }
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

export async function refreshToken(staleToken: string): Promise<Result<{ token: string; expiresAt: null }>> {
  await revokeToken(staleToken);
  return getAuthToken(false);
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
