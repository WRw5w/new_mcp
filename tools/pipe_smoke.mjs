import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const chrome = process.env.AIC_LEADERBOARD_CHROME_PATH || "";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "aic-pipe-smoke-"));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(chrome ? {executablePath: chrome} : {channel: "chrome"}),
    headless: process.env.AIC_PIPE_HEADLESS !== "false",
    timeout: 20000,
  });
  const page = await context.newPage();
  await page.goto("about:blank");
  await page.setContent("<title>pipe-ok</title><main>Chrome is controlled</main>");
  const title = await page.title();
  const browser = context.browser();
  console.log(JSON.stringify({ok: title === "pipe-ok", title, pages: context.pages().length,
    connected: browser ? browser.isConnected() : null,
    transport: "Playwright launchPersistentContext with Chrome debugging pipe"}));
} catch (error) {
  console.error(String(error?.stack || error));
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  fs.rmSync(profile, {recursive: true, force: true});
}
