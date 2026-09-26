import { chromium } from "playwright";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(process.env.AIC_LEADERBOARD_ROOT || process.cwd());
const profile = path.resolve(process.env.AIC_LEADERBOARD_PIPE_PROFILE ||
  path.join(os.tmpdir(), "aic_leaderboard_pipe_profile"));
const chrome = process.env.AIC_LEADERBOARD_CHROME_PATH || "";
const submitUrl = process.env.AIC_LEADERBOARD_SUBMIT_URL || "";
const leaderboardUrl = process.env.AIC_LEADERBOARD_LEADERBOARD_URL || "";
const recordsUrl = process.env.AIC_LEADERBOARD_RECORDS_URL ||
  "https://reg.aicomp.cn/app/JSGLPT/65b75207a58fdc32c79e9842";
const command = process.argv[2] || "probe";
const candidate = process.argv[3] || "";
const timeoutMs = Math.min(Number(process.env.AIC_LEADERBOARD_BROWSER_TIMEOUT_MS || 60000), 600000);

const print = (value) => console.log(JSON.stringify(value, null, 2));
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const body = async (page) => (await page.locator("body").innerText({timeout: 10000}).catch(() => "")).slice(0, 12000);
async function tableRows(page) {
  return page.locator("table tbody tr").evaluateAll(rows => rows.map(row =>
    [...row.querySelectorAll("td")].map(cell => cell.innerText.trim()).join(" | "))
    .filter(Boolean).join("\n")).catch(() => "");
}
async function visibleBody(page, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let text = "";
  do {
    text = await body(page);
    if (text.trim()) return text;
    await page.waitForTimeout(500);
  } while (Date.now() < deadline);
  return text;
}
const loginRequired = (url, text) => /passport|cas\b|\/login\b/i.test(url) ||
  /统一身份认证|扫码登录|账号登录|请登录/i.test(text.slice(0, 700));
const allowed = (url, purpose) => url.startsWith("https://reg.aicomp.cn/") ||
  (purpose !== "submit-one" && process.env.AIC_LEADERBOARD_TEST_URLS === "1" && url.startsWith("file:///"));

async function openContext() {
  if (chrome && !fs.existsSync(chrome)) throw new Error(`CHROME_NOT_FOUND:${chrome}`);
  return chromium.launchPersistentContext(profile, {
    ...(chrome ? {executablePath: chrome} : {channel: "chrome"}),
    headless: process.env.AIC_LEADERBOARD_HEADLESS === "true",
    acceptDownloads: true,
    timeout: 20000,
    viewport: null,
  });
}

async function pageAt(context, url) {
  const page = context.pages().find(p => p.url().startsWith(url)) ||
    context.pages().find(p => p.url() === "about:blank") || await context.newPage();
  await page.goto(url, {waitUntil: "domcontentloaded", timeout: timeoutMs});
  await page.bringToFront();
  return page;
}

async function run() {
  if (command === "probe") {
    const context = await openContext();
    try {
      const page = await pageAt(context, "about:blank");
      await page.setContent("<title>aic-pipe-ready</title>");
      const title = await page.title();
      print({ok: title === "aic-pipe-ready", reason: "pipe-ready", title,
        transport: "Chrome debugging pipe", profile});
      return title === "aic-pipe-ready" ? 0 : 3;
    } finally { await context.close(); }
  }
  if (command === "heartbeat" || command === "wait-login" || command === "submit-one") {
    if (!allowed(submitUrl, command)) throw new Error("AIC_LEADERBOARD_SUBMIT_URL must be a full AIC submit URL");
  }
  if (command === "leaderboard" && !allowed(leaderboardUrl, command)) {
    throw new Error("AIC_LEADERBOARD_LEADERBOARD_URL must be a full AIC leaderboard URL");
  }
  if (command === "result-records" && !allowed(recordsUrl, command)) {
    throw new Error("AIC_LEADERBOARD_RECORDS_URL must be a full AIC result-records URL");
  }
  if (command === "submit-one") {
    const expected = String(process.env.AIC_LEADERBOARD_EXPECTED_SHA256 || "").toLowerCase();
    const queueId = String(process.env.AIC_LEADERBOARD_QUEUE_ID || "");
    const attemptId = String(process.env.AIC_LEADERBOARD_ATTEMPT_ID || "");
    const team = String(process.env.AIC_LEADERBOARD_TEAM_ID || "");
    if (process.env.AIC_LEADERBOARD_CONFIRM !== "true" || !expected || !queueId || !team ||
      !/^[0-9a-f]{32}$/.test(attemptId)) return 77;
    if (!fs.existsSync(candidate) || digest(candidate) !== expected) return 77;
    const queue = JSON.parse(fs.readFileSync(path.join(root, "aic_leaderboard_state.json"), "utf8"));
    const matches = queue.queue.filter(x => x.id === queueId && x.status === "submitting" &&
      x.sha256 === expected && x.team === team && path.resolve(x.path) === path.resolve(candidate));
    if (matches.length !== 1) return 77;
  }

  const context = await openContext();
  try {
    const page = await pageAt(context, command === "leaderboard" ? leaderboardUrl :
      command === "result-records" ? recordsUrl : submitUrl);
    if (command === "result-records") {
      const team = String(process.env.AIC_LEADERBOARD_TEAM_ID || "");
      const stage = String(process.env.AIC_LEADERBOARD_STAGE || "semi");
      const expected = String(process.env.AIC_LEADERBOARD_EXPECTED_SHA256 || "").toLowerCase();
      if (!team) { print({ok:false,reason:"TEAM_REQUIRED"}); return 3; }
      const stageText = stage === "semi" ? "复赛" : stage === "prelim" ? "初赛" : stage;
      // A logged-out session lands on /cas/login, which has no 打分时间 table, so
      // the empty read below would report a clean `no_matching_result`.  That is
      // byte-identical to "this account has nothing scored", and only the `url`
      // field tells them apart.  `heartbeat`, `wait-login` and `submit-one` all
      // gate on login first; `result-records` is how a score gets attributed, so
      // it must too.  Exit 2 / reason "login" is the pair auto.py already checks.
      const gate = await visibleBody(page);
      if (!gate.trim() || loginRequired(page.url(), gate)) {
        print({ok:false, reason: gate.trim() ? "login" : "empty-page", url:page.url()});
        return gate.trim() ? 2 : 3;
      }
      const table = page.locator("table").filter({hasText:"打分时间"}).first();
      await table.locator("tbody tr").first().waitFor({timeout:30000}).catch(() => {});
      const records = await table.evaluate(element => {
        const headers = [...element.querySelectorAll("thead th")].map(x => x.innerText.trim());
        return [...element.querySelectorAll("tbody tr")].map((row, index) => {
          const cells = [...row.querySelectorAll("td")].map(x => x.innerText.trim());
          return {index, fields:Object.fromEntries(headers.map((h, i) => [h, cells[i] || ""]))};
        });
      }).catch(() => []);
      const selected = records.filter(x => x.fields["参赛编号"] === team &&
        x.fields["当前阶段"] === stageText && /^\d{4}-\d\d-\d\d /.test(x.fields["打分时间"] || ""))
        .sort((a,b) => b.fields["打分时间"].localeCompare(a.fields["打分时间"]))[0];
      if (!selected) {
        print({ok:true,reason:"no_matching_result",url:page.url(),team,stage,recordCount:records.length});
        return 0;
      }
      const record = {
        team,stage,score:Number(selected.fields["分数"]),
        status:selected.fields["当前状态"],evaluated:selected.fields["打分时间"],
        title:selected.fields["参赛作品名称（20字以内）"],
        failureReason:selected.fields["失败原因"] || "",fields:selected.fields,
        attachmentSha256:null,attachmentMatches:null,
      };
      const row = table.locator("tbody tr").nth(selected.index);
      const detailButton = row.getByText("详情",{exact:true});
      if (await detailButton.count() === 1) {
        await detailButton.click({timeout:5000});
        const modal = page.locator(".ant-modal:visible").first();
        await modal.waitFor({timeout:10000});
        await page.waitForTimeout(700);
        const details = await modal.evaluate(element => Object.fromEntries(
          [...element.querySelectorAll("input,textarea")].map(input => [
            input.closest(".ant-form-item")?.querySelector("label")?.innerText?.trim() || "",
            input.value || "",
          ]).filter(([label]) => label)));
        record.details = details;
        record.failureReason = details["备注"] || details["失败原因"] || record.failureReason;
        if (expected) {
          const link = modal.getByText("下载",{exact:true});
          if (await link.count() === 1) {
            const tempFile = path.join(os.tmpdir(), `aic-result-${randomUUID()}.zip`);
            try {
              const [download] = await Promise.all([
                page.waitForEvent("download",{timeout:30000}),link.click(),
              ]);
              await download.saveAs(tempFile);
              record.attachmentSha256 = digest(tempFile);
              record.attachmentMatches = record.attachmentSha256 === expected;
              record.attachmentBytes = fs.statSync(tempFile).size;
            } catch (error) {
              record.attachmentError = String(error?.message || error).slice(0, 300);
            } finally { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); }
          }
        }
      }
      print({ok:true,reason:"result_record",url:page.url(),record});
      return 0;
    }
    if (command === "heartbeat") {
      const text = await visibleBody(page);
      if (!text.trim()) {
        print({ok: false, reason: "empty-page", url: page.url(), title: await page.title()});
        return 3;
      }
      const login = loginRequired(page.url(), text);
      if (!login && process.env.AIC_LEADERBOARD_TEAM_ID) {
        const row = page.locator("tr").filter({hasText: process.env.AIC_LEADERBOARD_TEAM_ID});
        await row.first().waitFor({timeout: 30000}).catch(() => {});
        if (await row.count() !== 1) {
          print({ok: false, reason: "team-row-unavailable", url: page.url()});
          return 3;
        }
      }
      print({ok: !login, reason: login ? "login" : "ready", url: page.url(), text: text.slice(0, 1000)});
      return login ? 2 : 0;
    }
    if (command === "wait-login") {
      const end = Date.now() + Math.min(Number(process.argv[3] || 600000), 600000);
      while (Date.now() < end) {
        const text = await visibleBody(page, 3000);
        if (!text.trim()) { await page.waitForTimeout(3000); continue; }
        if (!loginRequired(page.url(), text)) {
          print({ok: true, reason: "logged-in", url: page.url()});
          return 0;
        }
        await page.waitForTimeout(3000);
      }
      print({ok: false, reason: "login-timeout", url: page.url()});
      return 2;
    }
    if (command === "leaderboard") {
      await page.waitForTimeout(2000);
      // The rows arrive from an XHR fired after DOMContentLoaded, so a fixed pause
      // reads whatever has painted by then -- usually the empty state.  Wait for a
      // real data row instead, or this reports "暂无数据" on a populated board.
      await page.locator("table tbody tr").filter({hasText: "AIC-"})
        .first().waitFor({timeout: 30000}).catch(() => {});
      let text = await visibleBody(page);
      if (!text.trim()) { print({ok: false, reason: "empty-page", url: page.url()}); return 3; }
      text = [await tableRows(page), text].filter(Boolean).join("\n");
      const team = process.env.AIC_LEADERBOARD_TEAM_ID || "";
      if (team && !text.includes(team)) {
        const second = page.locator(".ant-pagination-item-2").first();
        if (await second.count()) {
          await second.click({timeout: 3000}).catch(() => {});
          await page.waitForTimeout(1000);
          text += "\n--- page 2 ---\n" + [await tableRows(page), await body(page)].filter(Boolean).join("\n");
        }
      }
      print({time: new Date().toISOString(), url: page.url(), text});
      return 0;
    }
    if (command === "submit-one") {
      const initialText = await visibleBody(page);
      if (!initialText.trim() || loginRequired(page.url(), initialText)) {
        print({ok: false, reason: initialText.trim() ? "login" : "empty-page", url: page.url()});
        return 3;
      }
      const row = page.locator("tr").filter({hasText: process.env.AIC_LEADERBOARD_TEAM_ID});
      await row.first().waitFor({timeout: 30000}).catch(() => {});
      if (await row.count() !== 1) { print({ok: false, reason: "TEAM_ROW_NOT_UNIQUE"}); return 3; }
      let input = page.locator('input[type="file"][accept*=".zip"]').first();
      if (!(await input.count())) {
        const button = row.first().getByText("提交作品", {exact: true});
        if (await button.count() === 1) await button.click({timeout: 5000});
        input = page.locator('input[type="file"][accept*=".zip"]').first();
        await input.waitFor({timeout: 10000}).catch(() => {});
      }
      if (!(await input.count())) { print({ok: false, reason: "NO_FILE_INPUT"}); return 3; }
      const oldAttachment = await input.evaluate(element => {
        const widget = element.closest(".ant-upload");
        const close = widget?.querySelector('.anticon-close-circle,[aria-label="close-circle"],[data-icon="close-circle"]');
        if (!close) return null;
        const previous = (widget.innerText || widget.textContent || "").trim();
        (close.closest("span,button,div") || close).click();
        return previous;
      });
      if (oldAttachment) {
        const cleared = await page.waitForFunction(() => {
          const element = document.querySelector('input[type="file"][accept*=".zip"]');
          const widget = element?.closest(".ant-upload");
          return !!widget && !widget.querySelector('.anticon-close-circle,[aria-label="close-circle"],[data-icon="close-circle"]');
        }, null, {timeout: 10000}).then(() => true).catch(() => false);
        if (!cleared) { print({ok: false, reason: "OLD_ATTACHMENT_NOT_REMOVED"}); return 4; }
      }
      await input.setInputFiles(candidate);
      // The AIC upload service displays underscores as hyphens in the stored filename.
      const displayName = path.basename(candidate).replaceAll("_", "-");
      const uploadReady = await page.waitForFunction(name => {
        const input = document.querySelector('input[type="file"][accept*=".zip"]');
        const widget = input?.closest(".ant-upload");
        const text = widget?.innerText || widget?.textContent || "";
        const removable = !!widget?.querySelector('.anticon-close-circle,[aria-label="close-circle"],[data-icon="close-circle"]');
        return text.includes(name) && removable;
      }, displayName, {timeout: 90000}).then(() => true).catch(() => false);
      if (!uploadReady) { print({ok: false, reason: "UPLOAD_NOT_READY", displayName}); return 4; }
      await page.waitForTimeout(30000);
      const buttons = page.locator(".ant-modal:visible").getByRole("button", {name: /^\s*提\s*交\s*$/});
      if (await buttons.count() !== 1 || !(await buttons.first().isEnabled())) {
        print({ok: false, reason: "NO_SUBMIT_BUTTON"}); return 5;
      }
      const attemptedAt = new Date().toISOString();
      const attemptDir = path.join(root, "submissions");
      fs.mkdirSync(attemptDir, {recursive: true});
      fs.writeFileSync(path.join(attemptDir, `${process.env.AIC_LEADERBOARD_QUEUE_ID}.${process.env.AIC_LEADERBOARD_ATTEMPT_ID}.attempt.json`),
        JSON.stringify({attemptedAt, sha256: process.env.AIC_LEADERBOARD_EXPECTED_SHA256,
          candidateId: process.env.AIC_LEADERBOARD_QUEUE_ID}) + "\n", {flag: "wx"});
      console.log(`SUBMIT_CLICK_ATTEMPTED_AT=${attemptedAt}`);
      await buttons.first().click({timeout: 5000});
      const clickedAt = new Date().toISOString();
      console.log(`SUBMIT_CLICKED_AT=${clickedAt}`);
      let feedback = "";
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        feedback = await page.locator(".ant-message,.ant-notification,.ant-modal,.ant-alert")
          .allInnerTexts().then(x => x.join(" ")).catch(() => "");
        if (/提交成功|作品提交成功|提交失败|上传失败|操作失败/.test(feedback)) break;
        await page.waitForTimeout(500);
      }
      if (/提交失败|上传失败|操作失败/.test(feedback)) { print({ok:false,reason:"rejected",feedback}); return 6; }
      if (/提交成功|作品提交成功/.test(feedback)) {
        await page.goto(submitUrl, {waitUntil: "domcontentloaded", timeout: timeoutMs});
        const savedRow = page.locator("tr").filter({hasText: process.env.AIC_LEADERBOARD_TEAM_ID});
        await savedRow.first().waitFor({timeout: 30000}).catch(() => {});
        if (await savedRow.count() !== 1) {
          print({ok:false,reason:"outcome_unknown_team_row",feedback}); return 7;
        }
        const reopen = savedRow.first().getByText("提交作品", {exact: true});
        if (await reopen.count() !== 1) {
          print({ok:false,reason:"outcome_unknown_reopen",feedback}); return 7;
        }
        await reopen.click({timeout: 5000});
        const savedReady = await page.waitForFunction(name => {
          const element = document.querySelector('input[type="file"][accept*=".zip"]');
          const widget = element?.closest(".ant-upload");
          const text = widget?.innerText || widget?.textContent || "";
          return text.includes(name);
        }, displayName, {timeout: 20000}).then(() => true).catch(() => false);
        if (!savedReady) {
          const current = await page.locator('input[type="file"][accept*=".zip"]').first()
            .evaluate(element => element.closest(".ant-upload")?.innerText || "").catch(() => "");
          print({ok:false,reason:"outcome_unknown_saved_file_mismatch",feedback,current}); return 7;
        }
        console.log(`SUBMIT_ACCEPTED_AT=${new Date().toISOString()}`);
        print({ok:true,reason:"accepted_and_saved_file_verified",feedback,displayName});
        return 0;
      }
      print({ok:false,reason:"outcome_unknown_after_click",feedback,clickedAt});
      return 7;
    }
    throw new Error(`UNKNOWN_COMMAND:${command}`);
  } finally { await context.close(); }
}

try { process.exitCode = await run(); }
catch (error) { console.error(String(error?.stack || error)); process.exitCode = 3; }
