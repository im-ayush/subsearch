import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.argv.includes("--prod");

function parseEnv(filePath) {
  const out = {};
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

const env = parseEnv(path.join(__dirname, ".env"));

// Keys inlined at build time via esbuild `define`. Not secret at runtime —
// see .env.example for details. Numeric keys are inlined as number literals,
// everything else as string literals.
const NUMERIC_KEYS = new Set([
  "DEFAULT_VIDEOS_PER_CHANNEL",
  "DAILY_QUOTA_LIMIT",
  "QUOTA_WARN_THRESHOLD",
  "QUOTA_ABORT_THRESHOLD",
  "SYNC_INTERVAL_MINUTES",
  "CONCURRENT_FETCHES",
  "DEFAULT_SEARCH_TOP_K",
  "FRESHNESS_WEIGHT",
]);

const ALL_KEYS = [
  "OAUTH_CLIENT_ID",
  ...NUMERIC_KEYS,
  "KOFI_USERNAME",
  "GUMROAD_URL",
  "SPONSOR_TEXT",
  "SPONSOR_URL",
];

const define = {};
for (const key of ALL_KEYS) {
  const raw = env[key] ?? "";
  define[`__${key}__`] = NUMERIC_KEYS.has(key) ? String(Number(raw) || 0) : JSON.stringify(raw);
}

const common = {
  bundle: true,
  define,
  minify: isProd,
  sourcemap: !isProd,
  logLevel: "info",
  target: "es2022",
  platform: "browser",
};

async function run() {
  await Promise.all([
    esbuild.build({
      ...common,
      entryPoints: [path.join(__dirname, "src/background/index.ts")],
      outfile: path.join(__dirname, "background.js"),
      format: "esm",
    }),
    esbuild.build({
      ...common,
      entryPoints: [path.join(__dirname, "src/content/index.ts")],
      outfile: path.join(__dirname, "content.js"),
      format: "iife",
    }),
    esbuild.build({
      ...common,
      entryPoints: [path.join(__dirname, "src/popup/index.ts")],
      outfile: path.join(__dirname, "popup.js"),
      format: "iife",
    }),
    esbuild.build({
      ...common,
      entryPoints: [path.join(__dirname, "src/options/index.ts")],
      outfile: path.join(__dirname, "options.js"),
      format: "iife",
    }),
  ]);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
