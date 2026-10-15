import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Scope font discovery to this process; never modify system or user font settings. */
export function initializeRuntimeEnvironment(): void {
  if (process.env.FONTCONFIG_FILE || process.platform !== "darwin") return;
  const existing = [
    "/opt/homebrew/etc/fonts/fonts.conf",
    "/usr/local/etc/fonts/fonts.conf",
  ].find((file) => existsSync(file));
  if (existing) {
    process.env.FONTCONFIG_FILE = existing;
    return;
  }
  const directory = resolve(
    process.env.CROSSCUT_DATA_DIR || "data",
    "run",
    "fontconfig",
  );
  const cache = join(directory, "cache");
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const dirs = [
    "/System/Library/Fonts",
    "/Library/Fonts",
    ...(process.env.CROSSCUT_FONT_PATH
      ? [dirname(resolve(process.env.CROSSCUT_FONT_PATH))]
      : []),
  ].filter((dir) => existsSync(dir));
  const xml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const file = join(directory, "fonts.conf");
  writeFileSync(
    file,
    `<?xml version="1.0"?>\n<fontconfig>\n${dirs.map((dir) => `  <dir>${xml(dir)}</dir>`).join("\n")}\n  <cachedir>${xml(cache)}</cachedir>\n</fontconfig>\n`,
    { mode: 0o600 },
  );
  process.env.FONTCONFIG_FILE = file;
}

initializeRuntimeEnvironment();
