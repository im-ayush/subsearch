import { logger } from "../shared/logger";
import { getAccountRegistry, getActiveAccountId, setActiveAccountId, upsertAccount } from "../storage/db";
import { fetchAccountInfo, getAuthToken, getProfileIdentity, getTokenForAccount, revokeToken } from "./auth";
import type { Account, Result } from "../shared/types";

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

/**
 * Signs in an account and registers it — no indexing. Revoking the active
 * account's token first is what forces Google to show the chooser; with a
 * live grant it would hand back the same identity silently and the picker
 * would never appear. Google may still auto-pick the most recently used
 * account, so callers compare the returned id against what they already had.
 */
export async function addNewAccount(): Promise<Result<Account>> {
  const activeAccountId = await getActiveAccountId();
  const cached = await getAuthToken(false, activeAccountId ?? undefined);
  if (cached.ok) {
    await revokeToken(cached.value.token);
  }

  const profile = await getProfileIdentity();
  logger.info(SOURCE, "addNewAccount: Chrome profile identity", { profile });

  const tokenResult = await getAuthToken(true);
  if (!tokenResult.ok) {
    logger.warn(SOURCE, "addNewAccount: auth failed", { error: tokenResult.error });
    return { ok: false, error: tokenResult.error, retryable: false };
  }

  const info = await fetchAccountInfo(tokenResult.value.token);
  if (!info) {
    logger.warn(SOURCE, "addNewAccount: could not identify account");
    return { ok: false, error: "Could not identify the signed-in account", retryable: false };
  }

  const account: Account = { ...info, addedAt: Date.now() };
  await upsertAccount(account);
  await setActiveAccountId(account.id);
  return { ok: true, value: account };
}
