import { DEFAULT_PREFERENCES } from "../shared/types";
import { getUserPreferences, setUserPreferences } from "../shared/preferences";

function getEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

let savedMsgTimer: number | null = null;
function showSaved(): void {
  const el = getEl("saved-msg");
  el.textContent = "Preferences saved ✓";
  el.style.display = "block";
  if (savedMsgTimer !== null) window.clearTimeout(savedMsgTimer);
  savedMsgTimer = window.setTimeout(() => {
    el.style.display = "none";
  }, 2500);
}

async function init(): Promise<void> {
  const videosPerChannelInput = getEl<HTMLInputElement>("videos-per-channel");
  const freshnessSelect = getEl<HTMLSelectElement>("freshness-months");
  const overlayEnabledInput = getEl<HTMLInputElement>("overlay-enabled");
  const saveBtn = getEl<HTMLButtonElement>("save-btn");
  const resetBtn = getEl<HTMLButtonElement>("reset-btn");

  function populate(prefs: typeof DEFAULT_PREFERENCES): void {
    videosPerChannelInput.value = String(prefs.videosPerChannel);
    freshnessSelect.value = String(prefs.freshnessMonths);
    overlayEnabledInput.checked = prefs.overlayEnabled;
  }

  populate(await getUserPreferences());

  saveBtn.addEventListener("click", async () => {
    const videosPerChannel = Math.max(
      5,
      Math.min(50, parseInt(videosPerChannelInput.value, 10) || DEFAULT_PREFERENCES.videosPerChannel)
    );
    await setUserPreferences({
      videosPerChannel,
      freshnessMonths: Number(freshnessSelect.value),
      overlayEnabled: overlayEnabledInput.checked,
    });
    videosPerChannelInput.value = String(videosPerChannel);
    showSaved();
  });

  resetBtn.addEventListener("click", async () => {
    await setUserPreferences(DEFAULT_PREFERENCES);
    populate(DEFAULT_PREFERENCES);
    showSaved();
  });
}

void init();
