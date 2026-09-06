import { STORAGE_KEY_PREFERENCES } from "./constants";
import { DEFAULT_PREFERENCES, type Preferences } from "./types";

export async function getUserPreferences(): Promise<Preferences> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(STORAGE_KEY_PREFERENCES, (result) => {
      const stored = result[STORAGE_KEY_PREFERENCES] as Partial<Preferences> | undefined;
      resolve({ ...DEFAULT_PREFERENCES, ...(stored ?? {}) });
    });
  });
}

export async function setUserPreferences(patch: Partial<Preferences>): Promise<void> {
  const current = await getUserPreferences();
  const updated = { ...current, ...patch };
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set({ [STORAGE_KEY_PREFERENCES]: updated }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}
