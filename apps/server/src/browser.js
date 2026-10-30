// browser.js — launch a hardened, ephemeral Chromium.
//
// Privacy: we use a normal launch() + newContext(), which is an in-memory
// (incognito-style) context. Nothing is written to a disk profile. On Oracle
// the root fs should additionally be read-only with tmpfs mounts.
//
// Security: the Chromium sandbox is kept ON. Do NOT add --no-sandbox. If your
// container cannot run the sandbox, fix the container (seccomp / user ns),
// don't disable it.
import { chromium } from "playwright";

const HEADLESS = (process.env.HEADLESS || "true") !== "false";
const LOCALE = process.env.LOCALE || "ko-KR";
const TZ = process.env.TZ || "Asia/Seoul";
// Keep the Chromium sandbox ON by default (defense-in-depth: we browse hostile
// pages server-side). Some unprivileged containers can't start it; set
// CHROMIUM_SANDBOX=false there (ideally pair with a seccomp profile instead).
const SANDBOX = (process.env.CHROMIUM_SANDBOX || "true") !== "false";

// Optional: force a specific Chromium binary. Normal installs (npm install /
// the Playwright Docker image) don't need this; it's only for environments
// where the matching browser isn't where Playwright expects it.
const EXECUTABLE_PATH = process.env.PW_EXECUTABLE_PATH || undefined;

export async function launchBrowser() {
  const browser = await chromium.launch({
    headless: HEADLESS,
    chromiumSandbox: SANDBOX,
    executablePath: EXECUTABLE_PATH,
    args: [
      "--disable-dev-shm-usage", // we size /dev/shm ourselves; avoid crashes
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-breakpad", // no crash dumps
      "--enable-smooth-scrolling", // animate wheel scroll so it streams smoother
      "--disable-features=Translate,MediaRouter",
    ],
  });
  return browser;
}

export async function newContext(browser, { width, height } = {}) {
  const context = await browser.newContext({
    locale: LOCALE,
    timezoneId: TZ,
    viewport: { width: width || 1280, height: height || 720 },
    acceptDownloads: true,
    // A mainstream UA reduces bot walls; tune as needed.
    userAgent:
      process.env.USER_AGENT ||
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  });
  return context;
}
