import { logger } from "../shared/logger";
import { getAccountRegistry, setActiveAccountId } from "../storage/db";
import { fetchAccountInfo, getAuthToken, getTokenForAccount, revokeToken } from "./auth";
import type { Account } from "../shared/types";

const SOURCE = "account-switcher";

// SWITCH_ACCOUNT flow:
//   1. Persist the chosen accountId as active (DB is already there — no clear).
//   2. Try a non-interactive token silently.
//   3. If that works, verify the token still belongs to the right account.
//   4. If it fails or mismatches, fail silently and return needsAuth:true so
//      the popup can tell the user to click Build Index to re-authenticate.
export async function switchToAccount(
  accountId: string
): Promise<{ ok: boolean; error?: string; accountId?: string; needsAuth?: boolean; account?: Account }> {
  const registry = await getAccountRegistry();
  const account = registry[accountId];
  if (!account) {
    return { ok: false, error: "Unknown account" };
  }

  await setActiveAccountId(accountId);

  const tokenResult = await getTokenForAccount(accountId, account.email);
  if (!tokenResult.ok) {
    logger.warn(SOURCE, "no silent token available for account switch", { accountId });
    return { ok: true, accountId, needsAuth: true };
  }

  const info = await fetchAccountInfo(tokenResult.value.token);
  if (!info || info.id !== accountId) {
    logger.warn(SOURCE, "cached token belongs to a different account", { accountId, tokenAccountId: info?.id });
    await revokeToken(tokenResult.value.token);
    return { ok: true, accountId, needsAuth: true };
  }

  return { ok: true, accountId, needsAuth: false, account };
}

export async function addNewAccount(): Promise<{ ok: true }> {
  // Revoke whatever token Chrome has cached so the next interactive
  // getAuthToken() (from runFullIndex) forces Chrome's account picker.
  const tokenResult = await getAuthToken(false);
  if (tokenResult.ok) {
    await revokeToken(tokenResult.value.token);
  }
  return { ok: true };
}
