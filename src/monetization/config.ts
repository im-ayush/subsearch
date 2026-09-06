// Values inlined from .env at build time — see env.d.ts / esbuild.config.js.
// Leaving a value blank in .env hides the corresponding UI element.
const KOFI_USERNAME = __KOFI_USERNAME__;
const GUMROAD_URL = __GUMROAD_URL__;
const SPONSOR_TEXT = __SPONSOR_TEXT__;
const SPONSOR_URL = __SPONSOR_URL__;

export const MONETIZATION = {
  KOFI_ENABLED: !!KOFI_USERNAME,
  KOFI_USERNAME,
  GUMROAD_ENABLED: !!GUMROAD_URL,
  GUMROAD_URL,
  SPONSOR_ENABLED: !!(SPONSOR_TEXT && SPONSOR_URL),
  SPONSOR_TEXT,
  SPONSOR_URL,
};
