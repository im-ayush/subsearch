import { logger } from "../shared/logger";
import { getAccountRegistry, setActiveAccountId, upsertAccount } from "../storage/db";
import { fetchAccountInfo, getTokenForAccount, launchAccountPicker, revokeToken, saveSessionToken } from "./auth";
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
 * Signs in an account and registers it — no indexing. Goes through
 * launchWebAuthFlow with prompt=select_account so Google's chooser appears
 * every time, regardless of which identity Chrome considers primary. No token
 * revocation needed: the chooser is forced by the prompt parameter, not by
 * destroying the existing account's grant.
 */
export async function addNewAccount(): Promise<Result<Account>> {
  const authResult = await launchAccountPicker();
  if (!authResult.ok) {
    logger.warn(SOURCE, "addNewAccount: auth failed", { error: authResult.error });
    return { ok: false, error: authResult.error, retryable: false };
  }

  const info = await fetchAccountInfo(authResult.value.token);
  if (!info) {
    logger.warn(SOURCE, "addNewAccount: could not identify account");
    return { ok: false, error: "Could not identify the signed-in account", retryable: false };
  }

  await saveSessionToken(info.id, authResult.value.token, authResult.value.expiresIn);
  const account: Account = { ...info, addedAt: Date.now() };
  await upsertAccount(account);
  await setActiveAccountId(account.id);
  logger.info(SOURCE, "account added", { email: account.email });
  return { ok: true, value: account };
}
