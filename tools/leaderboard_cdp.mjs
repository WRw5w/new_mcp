import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEBUG_URL = process.env.AIC_LEADERBOARD_DEBUG_URL || "http://127.0.0.1:9222";
const SUBMIT_URL = process.env.AIC_LEADERBOARD_SUBMIT_URL ||
  "https://reg.aicomp.cn/";
const SCORE_RESULTS_URL =
  process.env.AIC_LEADERBOARD_RECORDS_URL || SUBMIT_URL;
const LEADERBOARD_URL = process.env.AIC_LEADERBOARD_LEADERBOARD_URL || SUBMIT_URL;
const ROOT = process.env.AIC_LEADERBOARD_ROOT
  ? path.resolve(process.env.AIC_LEADERBOARD_ROOT)
  : process.cwd();
const SUBMISSIONS = path.join(ROOT, "submissions");
const QUEUE_PATH = path.join(ROOT, "aic_leaderboard_state.json");
const RUNNER_LEASE_PATH = path.join(SUBMISSIONS, "aicomp_runner.lock", "owner.json");
const DEFAULT_FILE = process.env.AIC_LEADERBOARD_CANDIDATE || path.join(ROOT, "candidate.zip");
const POST_UPLOAD_DELAY_MS = Number(process.env.AICOMP_POST_UPLOAD_DELAY_MS || 30000);
const POST_SUBMIT_DELAY_MS = Number(process.env.AICOMP_POST_SUBMIT_DELAY_MS || 30000);
const CDP_COMMAND_TIMEOUT_MS = Number(process.env.AICOMP_CDP_COMMAND_TIMEOUT_MS || 60000);
const SUBMIT_HEALTH_TIMEOUT_MS = Number(process.env.AICOMP_SUBMIT_HEALTH_TIMEOUT_MS || 180000);
const LEADERBOARD_RETRY_MS = Number(process.env.AICOMP_LEADERBOARD_RETRY_MS || 240000);
const RECORDS_MAX_PAGES = boundedIntEnv("AICOMP_RECORDS_MAX_PAGES", 4, 1, 200);
const RECORDS_MAX_DETAILS = boundedIntEnv("AICOMP_RECORDS_MAX_DETAILS", 200, 0, 1000);
const RECORDS_PAGE_WAIT_MS = boundedIntEnv("AICOMP_RECORDS_PAGE_WAIT_MS", 3500, 500, 30000);
const RECORDS_DETAIL_WAIT_MS = boundedIntEnv("AICOMP_RECORDS_DETAIL_WAIT_MS", 1500, 300, 10000);
const RECORDS_NAVIGATION_TIMEOUT_MS = boundedIntEnv("AICOMP_RECORDS_NAVIGATION_TIMEOUT_MS", 30000, 1000, 120000);
const RECORDS_READINESS_POLL_MS = boundedIntEnv("AICOMP_RECORDS_READINESS_POLL_MS", 1000, 100, 5000);
const RETRYABLE_PAGE_KINDS = new Set(["submit", "leaderboard"]);
const TEAM_ID = process.env.AIC_LEADERBOARD_TEAM_ID || "";
const PER_SUBMISSION_SOURCE_UNAVAILABLE = "PER_SUBMISSION_SOURCE_UNAVAILABLE";
const PER_SUBMISSION_FIELDS_INSUFFICIENT = "PER_SUBMISSION_FIELDS_INSUFFICIENT";
const SUBMISSION_RECORDS_COLLECTION_TRUNCATED = "SUBMISSION_RECORDS_COLLECTION_TRUNCATED";
const EXIT_USAGE = 64;
const EXIT_SECURITY = 77;

function printUsage() {
  console.log(`Usage:
  node tools\\leaderboard_cdp.mjs probe [submit|leaderboard]
  node tools\\leaderboard_cdp.mjs pages
  node tools\\leaderboard_cdp.mjs heartbeat
  node tools\\leaderboard_cdp.mjs submit-one <result.zip>  (explicit confirmation and hash required)
  node tools\\leaderboard_cdp.mjs inspect-upload
  node tools\\leaderboard_cdp.mjs submission-records
  node tools\\leaderboard_cdp.mjs leaderboard`);
}

function isHelpArg(value) {
  return value === "--help" || value === "-h" || value === "help";
}

function boundedIntEnv(name, fallback, min, max) {
  const parsed = Number(process.env[name] || fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function validateSubmitFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`SUBMIT_FILE_NOT_FOUND: ${resolved}`);
    return null;
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    console.error(`SUBMIT_FILE_NOT_FILE: ${resolved}`);
    return null;
  }
  if (!/\.(zip|rar)$/i.test(resolved)) {
    console.error(`SUBMIT_FILE_UNSUPPORTED_TYPE: ${resolved}`);
    return null;
  }
  return resolved;
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256File(filePath) {
  const digest = createHash("sha256");
  digest.update(fs.readFileSync(filePath));
  return digest.digest("hex");
}

function assertFencedSubmitCapability(filePath) {
  if (process.env.AIC_LEADERBOARD_CONFIRM !== "true") {
    throw new Error("EXPLICIT_BROWSER_CONFIRMATION_REQUIRED");
  }
  const expected = String(process.env.AIC_LEADERBOARD_EXPECTED_SHA256 || "").toLowerCase();
  if (!expected || sha256File(path.resolve(filePath)) !== expected) {
    throw new Error("CANDIDATE_SHA256_MISMATCH");
  }
  if (process.env.AIC_LEADERBOARD_FENCE_MODE === "local") return path.resolve(filePath);
  const token = String(process.env.AICOMP_RUNNER_LEASE_TOKEN || "");
  const expectedIndex = String(process.env.AICOMP_EXPECTED_QUEUE_INDEX || "");
  const expectedSha256 = String(process.env.AICOMP_EXPECTED_CANDIDATE_SHA256 || "").toLowerCase();
  const expectedLogicalId = String(process.env.AICOMP_EXPECTED_LOGICAL_SUBMISSION_ID || "");
  const expectedAttemptId = String(process.env.AICOMP_SUBMIT_ATTEMPT_ID || "");
  const expectedRunnerId = String(process.env.AICOMP_RUNNER_ID || "");
  if (!token || !expectedIndex || !expectedSha256 || !expectedLogicalId || !expectedAttemptId || !expectedRunnerId) {
    throw new Error("SUBMIT_CAPABILITY_ENV_INCOMPLETE");
  }
  const lease = readJson(RUNNER_LEASE_PATH, null);
  if (!lease || lease.token !== token) throw new Error("SUBMIT_LEASE_TOKEN_MISMATCH");
  if (Number(lease.pid) !== Number(process.ppid)) throw new Error("SUBMIT_PARENT_IS_NOT_FENCED_RUNNER");
  if (lease.phase !== "running" || lease.intent?.action !== "submit_candidate") {
    throw new Error("SUBMIT_LEASE_ACTION_NOT_ALLOWED");
  }
  if (String(lease.intent.queueIndex) !== expectedIndex) throw new Error("SUBMIT_LEASE_INDEX_MISMATCH");
  if (String(lease.intent.candidateSha256 || "").toLowerCase() !== expectedSha256) {
    throw new Error("SUBMIT_LEASE_SHA256_MISMATCH");
  }
  if (String(lease.intent.logicalSubmissionId || "") !== expectedLogicalId) {
    throw new Error("SUBMIT_LEASE_LOGICAL_ID_MISMATCH");
  }
  if (String(lease.runner_id || "") !== expectedRunnerId || String(lease.intent.runnerId || "") !== expectedRunnerId) {
    throw new Error("SUBMIT_LEASE_RUNNER_ID_MISMATCH");
  }
  if (String(lease.intent.attemptId || "") !== expectedAttemptId) {
    throw new Error("SUBMIT_LEASE_ATTEMPT_ID_MISMATCH");
  }

  const queueDocument = readJson(QUEUE_PATH, null);
  const queue = Array.isArray(queueDocument?.queue) ? queueDocument.queue : [];
  const matches = queue.filter((item) => String(item.index) === expectedIndex);
  if (matches.length !== 1) throw new Error("SUBMIT_QUEUE_INDEX_NOT_UNIQUE");
  const item = matches[0];
  if (item.status !== "uploading") throw new Error(`SUBMIT_QUEUE_STATUS_NOT_UPLOADING:${item.status || ""}`);
  if (String(item.attemptId || "") !== expectedAttemptId) throw new Error("SUBMIT_ATTEMPT_ID_MISMATCH");
  if (String(item.runnerId || "") !== expectedRunnerId) throw new Error("SUBMIT_RUNNER_ID_MISMATCH");
  if (String(item.logicalSubmissionId || "") !== expectedLogicalId) throw new Error("SUBMIT_QUEUE_LOGICAL_ID_MISMATCH");
  const resolved = path.resolve(filePath);
  if (path.resolve(String(item.path || "")) !== resolved) throw new Error("SUBMIT_QUEUE_PATH_MISMATCH");
  if (!fs.existsSync(resolved) || sha256File(resolved) !== expectedSha256) {
    throw new Error("SUBMIT_CANDIDATE_BYTES_MISMATCH");
  }
  return resolved;
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connect timeout")), 10000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener("error", reject);
    });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        for (const handler of this.handlers.get(msg.method)) handler(msg.params || {});
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, CDP_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return result.result.value;
  }

  close() {
    this.ws?.close();
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
}

async function listPages() {
  return await fetch(`${DEBUG_URL}/json`).then((r) => r.json());
}

function pageKind(page) {
  const url = page?.url || "";
  if (url.includes("/app/JSGLPT/639980063d903c241eb85102")) return "submit";
  if (url.includes("/special/phb/detail")) return "leaderboard";
  if (url.includes("reg.aicomp.cn")) return "aicomp";
  return "other";
}

async function createPage(url) {
  const endpoint = `${DEBUG_URL}/json/new?${encodeURIComponent(url)}`;
  let response = await fetch(endpoint, { method: "PUT" });
  if (!response.ok) response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Could not create Chrome tab for ${url}: HTTP ${response.status}`);
  }
  await sleep(1500);
  return await response.json();
}

async function getPageWsUrl(kind = "submit") {
  let pages = await listPages();
  let page = null;
  if (kind === "submit") {
    page = pages.find((p) => p.type === "page" && pageKind(p) === "submit");
    if (!page) page = await createPage(SUBMIT_URL);
  } else if (kind === "leaderboard") {
    page = pages.find((p) => p.type === "page" && pageKind(p) === "leaderboard");
    if (!page) page = await createPage(LEADERBOARD_URL);
  } else {
    page =
      pages.find((p) => p.type === "page" && p.url.includes("reg.aicomp.cn")) ||
      pages.find((p) => p.type === "page");
  }
  if (!page) throw new Error("No Chrome page found on debug port 9222");
  return page.webSocketDebuggerUrl;
}

async function closePagesOfKind(kind) {
  const pages = await listPages();
  const targets = pages.filter((page) => page.type === "page" && pageKind(page) === kind);
  for (const page of targets) {
    await fetch(`${DEBUG_URL}/json/close/${page.id}`).catch(() => {});
  }
  if (targets.length) await sleep(1000);
}

async function connectPage(kind = "submit") {
  let lastError = null;
  const retryable = RETRYABLE_PAGE_KINDS.has(kind);
  const attempts = retryable ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const cdp = new CDP(await getPageWsUrl(kind));
    try {
      await cdp.connect();
      await cdp.send("Runtime.enable");
      await cdp.send("Page.enable");
      await cdp.send("DOM.enable");
      await cdp.send("Page.bringToFront").catch(() => {});
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
      return cdp;
    } catch (error) {
      lastError = error;
      cdp.close();
      if (!retryable || attempt === attempts) throw error;
      console.error(`${kind} CDP connection failed; recreating tab: ${error.message}`);
      await closePagesOfKind(kind);
    }
  }
  throw lastError || new Error(`Could not connect to ${kind} page`);
}

const probeExpression = String.raw`
(() => {
  const styleText = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      visible: s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)
    };
  };
  const interesting = Array.from(document.querySelectorAll(
    "button,a,input,textarea,select,[role=button],.ant-btn,.ant-upload,.ant-upload-drag"
  )).map((el, i) => ({
    i,
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type") || "",
    role: el.getAttribute("role") || "",
    text: (el.innerText || el.placeholder || el.title || el.getAttribute("aria-label") || "").trim().slice(0, 120),
    id: el.id || "",
    name: el.getAttribute("name") || "",
    cls: (el.className || "").toString().slice(0, 160),
    href: el.href || "",
    ...styleText(el)
  })).filter((x) => x.visible || x.type === "file").slice(0, 250);
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    bodyText: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 3000),
    inputs: Array.from(document.querySelectorAll("input")).map((el, i) => ({
      i,
      type: el.type,
      name: el.name,
      accept: el.accept,
      placeholder: el.placeholder,
      value: "",
      id: el.id,
      cls: (el.className || "").toString().slice(0, 160),
      ...styleText(el)
    })),
    interesting
  };
})()
`;

async function waitForPage(cdp, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await cdp.eval(`({url: location.href, text: (document.body?.innerText || "").slice(0, 500)})`);
    if (!/about:blank/.test(state.url) && state.text.trim().length > 20) return state;
    await sleep(1000);
  }
  throw new Error("Timed out waiting for page content");
}

function compactText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function isLoginRequired(url = "", text = "") {
  const sample = `${url}\n${text}`;
  if (/cas\/login/i.test(url)) return true;
  if (/当前角色为：参赛学生|参赛学生/.test(text)) return false;
  return /统一身份认证|账号登录|请登录|验证码|扫码|手机号|密码/.test(sample);
}

function isSubmitListReady(info) {
  const text = compactText(info?.bodyText || "");
  return (
    info?.inputs?.some((x) => x.type === "file") ||
    (/参赛作品上传\s*共\s*1\s*条数据/.test(text) && text.includes(TEAM_ID) && text.includes("提交作品"))
  );
}

function isSubmitListEmpty(info) {
  return /参赛作品上传\s*共\s*0\s*条数据|暂无数据/.test(compactText(info?.bodyText || ""));
}

async function reloadAndWait(cdp, waitMs = 8000) {
  await cdp.send("Page.reload", { ignoreCache: true }).catch(() => {});
  await sleep(waitMs);
  await waitForPage(cdp, 30000).catch(() => {});
}

async function resetSubmitQuery(cdp) {
  const reset = await cdp.eval(clickExactTextExpression("重置")).catch((err) => ({ error: String(err) }));
  await sleep(1500);
  const query = await cdp.eval(clickExactTextExpression("查询")).catch((err) => ({ error: String(err) }));
  await sleep(8000);
  return { reset, query };
}

async function ensureSubmitListReady(cdp, timeoutMs = SUBMIT_HEALTH_TIMEOUT_MS) {
  const loc = await cdp.eval("location.href").catch(() => "");
  if (!loc.includes("/app/JSGLPT/639980063d903c241eb85102")) {
    await cdp.send("Page.navigate", { url: SUBMIT_URL });
    await sleep(7000);
  }
  await waitForPage(cdp, 60000);

  const start = Date.now();
  let last = null;
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    attempts += 1;
    await cdp.send("Page.bringToFront").catch(() => {});
    last = await cdp.eval(probeExpression);

    if (isLoginRequired(last.url, last.bodyText)) {
      return { ok: false, reason: "login", attempts, info: last };
    }
    if (isSubmitListReady(last)) {
      return { ok: true, reason: "ready", attempts, info: last };
    }

    if (isSubmitListEmpty(last)) {
      console.log(`submit list is empty; reset/query retry ${attempts}`);
      console.log("reset/query:", JSON.stringify(await resetSubmitQuery(cdp)));
    } else {
      const query = await cdp.eval(clickExactTextExpression("查询")).catch((err) => ({ error: String(err) }));
      console.log(`submit list not ready; query retry ${attempts}: ${JSON.stringify(query)}`);
      await sleep(6000);
    }

    if (attempts % 3 === 0) {
      console.log("submit list still not ready; reloading page");
      await reloadAndWait(cdp);
    }
  }
  return { ok: false, reason: "submit_list_unhealthy", attempts, info: last };
}

async function waitForSubmitForm(cdp, timeoutMs = 120000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await cdp.eval(probeExpression);
    if (isLoginRequired(last.url, last.bodyText)) return last;
    if (last.inputs.some((x) => x.type === "file")) return last;
    await sleep(3000);
  }
  return last;
}

async function openSubmitForm(cdp) {
  let info = await cdp.eval(probeExpression);
  if (info.inputs.some((x) => x.type === "file")) return info;

  for (let i = 0; i < 10; i++) {
    info = await cdp.eval(probeExpression);
    if (info.inputs.some((x) => x.type === "file")) return info;
    if (isLoginRequired(info.url, info.bodyText)) return info;

    const clicked = await cdp.eval(clickExactTextExpression("提交作品"));
    console.log("open submit form:", JSON.stringify(clicked));
    await sleep(clicked.clicked ? 8000 : 5000);
  }

  return await waitForSubmitForm(cdp);
}

async function probe() {
  const cdp = await connectPage(process.argv[3] || "submit");
  try {
    await waitForPage(cdp, 30000);
    const info = await cdp.eval(probeExpression);
    console.log(JSON.stringify(info, null, 2));
  } finally {
    cdp.close();
  }
}

const clickByTextExpression = (patterns) => `
(() => {
  const patterns = ${JSON.stringify(patterns)};
  const els = Array.from(document.querySelectorAll("button,a,[role=button],.ant-btn,.ant-upload,.ant-upload-drag"));
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  for (const p of patterns) {
    const re = new RegExp(p, "i");
    const el = els.find((x) => visible(x) && re.test((x.innerText || x.textContent || x.title || x.getAttribute("aria-label") || "").trim()));
    if (el) {
      el.scrollIntoView({block: "center", inline: "center"});
      el.click();
      return {clicked: true, pattern: p, tag: el.tagName, text: (el.innerText || el.textContent || "").trim().slice(0, 120), cls: (el.className || "").toString().slice(0, 120)};
    }
  }
  return {clicked: false};
})()
`;

const clickExactTextExpression = (text) => `
(() => {
  const target = ${JSON.stringify(text)}.replace(/\\s+/g, "");
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const els = Array.from(document.querySelectorAll("a,button,[role=button]"))
    .filter((el) => visible(el) && (el.innerText || el.textContent || "").replace(/\\s+/g, "") === target)
    .map((el) => ({ el, r: el.getBoundingClientRect(), text: (el.innerText || el.textContent || "").trim(), cls: (el.className || "").toString() }));
  const picked = els[els.length - 1];
  if (!picked) return {clicked: false, target};
  picked.el.scrollIntoView({block: "center", inline: "center"});
  picked.el.click();
  return {clicked: true, target, text: picked.text, x: Math.round(picked.r.x), y: Math.round(picked.r.y), cls: picked.cls};
})()
`;

const inspectUploadExpression = String.raw`
(() => {
  const trim = (s, n = 1000) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
  };
  const uploads = Array.from(document.querySelectorAll(".ant-upload, .ant-upload-list, .ant-upload-list-item, input[type=file]"))
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      accept: el.getAttribute("accept") || "",
      cls: (el.className || "").toString(),
      text: trim(el.innerText || el.textContent),
      visible: visible(el),
      box: box(el),
      html: trim(el.outerHTML, 2500)
    }));
  const candidates = Array.from(document.querySelectorAll("button,a,span,svg,[role=button]"))
    .filter((el) => {
      const cls = (el.className || "").toString();
      const label = [el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText, el.textContent, cls].join(" ");
      return /(delete|remove|close|del|trash|删除|移除|关闭|anticon-close|anticon-delete|ant-upload-list-item-card-actions)/i.test(label);
    })
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      cls: (el.className || "").toString(),
      label: trim([el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText, el.textContent].join(" ")),
      visible: visible(el),
      box: box(el),
      html: trim(el.outerHTML, 1200)
    }));
  const messages = Array.from(document.querySelectorAll(".ant-message, .ant-message-notice, .ant-notification, .ant-modal, .ant-popover"))
    .map((el) => ({cls: (el.className || "").toString(), visible: visible(el), box: box(el), text: trim(el.innerText || el.textContent, 1500), html: trim(el.outerHTML, 1800)}));
  return {
    url: location.href,
    text: trim(document.body?.innerText || "", 2500),
    uploads,
    candidates,
    messages
  };
})()
`;

const uploadStateExpression = String.raw`
(() => {
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const result = [];
  for (const input of document.querySelectorAll('input[type=file][accept*=".zip"], input[type=file][accept*=".rar"]')) {
    const upload = input.closest(".ant-upload");
    if (!upload) continue;
    const text = (upload.innerText || upload.textContent || "").replace(/\s+/g, " ").trim();
    const hasClose = !!upload.querySelector('.anticon-close-circle, [aria-label="close-circle"], [data-icon="close-circle"]');
    const src = upload.querySelector("img.ant-image-img, .ant-image-img")?.getAttribute("src") || "";
    result.push({
      visible: visible(upload),
      text,
      hasClose,
      src,
      ready: visible(upload) && hasClose && /\.zip|\.rar|pred-results/i.test(text + " " + src)
    });
  }
  return result;
})()
`;

async function setResultZipFileInput(cdp, filePath) {
  const root = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const input = await cdp.send("DOM.querySelector", {
    nodeId: root.root.nodeId,
    selector: 'input[type=file][accept*=".zip"], input[type=file][accept*=".rar"]',
  });
  if (!input.nodeId) return false;
  await cdp.send("DOM.setFileInputFiles", {
    nodeId: input.nodeId,
    files: [filePath],
  });
  return true;
}

async function waitForUploadReady(cdp, timeoutMs = 90000) {
  const start = Date.now();
  let last = [];
  while (Date.now() - start < timeoutMs) {
    last = await cdp.eval(uploadStateExpression);
    if (last.some((x) => x.ready)) return { ready: true, state: last };
    await sleep(1500);
  }
  return { ready: false, state: last };
}

const clickSubmitButtonExpression = String.raw`
(() => {
  const norm = (s) => (s || "").replace(/\s+/g, "");
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const buttons = Array.from(document.querySelectorAll("button"))
    .filter((el) => visible(el) && /^(提交|确定|确认|OK)$/i.test(norm(el.innerText || el.textContent || "")))
    .map((el) => ({ el, r: el.getBoundingClientRect(), text: norm(el.innerText || el.textContent || "") }))
    .sort((a, b) => b.r.y - a.r.y);
  const picked = buttons[0];
  if (!picked) return {clicked: false};
  picked.el.scrollIntoView({block: "center", inline: "center"});
  picked.el.click();
  return {
    clicked: true,
    text: picked.text,
    x: Math.round(picked.r.x),
    y: Math.round(picked.r.y),
    cls: (picked.el.className || "").toString()
  };
})()
`;

const submitFeedbackExpression = String.raw`
(() => {
  const trim = (s, n = 2000) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const feedbackText = Array.from(document.querySelectorAll(
    ".ant-message, .ant-message-notice, .ant-notification, .ant-modal, .ant-alert"
  ))
    .filter(visible)
    .map((el) => trim(el.innerText || el.textContent))
    .filter(Boolean)
    .join(" ");
  const bodyText = trim(document.body?.innerText || "");
  const success = !!feedbackText && /提交成功|作品提交成功/.test(feedbackText) && !/失败|错误|数据已被其他人修改|请刷新页面后重试/.test(feedbackText);
  const failure = !!feedbackText && /数据已被其他人修改|请刷新页面后重试|提交失败|上传失败|保存失败|操作失败|错误/.test(feedbackText);
  return {
    success,
    failure,
    feedbackText,
    text: bodyText.slice(0, 2000)
  };
})()
`;

async function waitForSubmitFeedback(cdp, baselineFeedbackText = "", timeoutMs = 20000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await cdp.eval(submitFeedbackExpression);
    if (last.feedbackText && last.feedbackText !== baselineFeedbackText && (last.success || last.failure)) return last;
    await sleep(500);
  }
  return last || { success: false, failure: false, feedbackText: "", text: "" };
}

const removeResultZipExpression = String.raw`
(() => {
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const zipInputs = Array.from(document.querySelectorAll('input[type=file][accept*=".zip"], input[type=file][accept*=".rar"]'));
  for (const input of zipInputs) {
    const upload = input.closest(".ant-upload");
    if (!upload) continue;
    const close = upload.querySelector('.anticon-close-circle, [aria-label="close-circle"], [data-icon="close-circle"]');
    if (!close) continue;
    const clickable = close.closest("span,button,div") || close;
    clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    const r = clickable.getBoundingClientRect();
    return {
      removed: true,
      visible: visible(clickable),
      x: Math.round(r.x),
      y: Math.round(r.y),
      text: (upload.innerText || upload.textContent || "").trim()
    };
  }
  return {removed: false};
})()
`;

async function submitOne(filePath = DEFAULT_FILE) {
  const resolved = validateSubmitFile(filePath);
  if (!resolved) return EXIT_USAGE;
  const cdp = await connectPage("submit");
  try {
    return await submitOneWithCdp(cdp, resolved);
  } finally {
    cdp.close();
  }
}

async function submitOneDebug(filePath = DEFAULT_FILE) {
  const resolved = validateSubmitFile(filePath);
  if (!resolved) return EXIT_USAGE;
  const cdp = await connectPage("submit");
  const requests = new Map();
  const logs = [];
  const bodyPromises = [];
  try {
    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", (p) => {
      requests.set(p.requestId, {
        url: p.request?.url || "",
        method: p.request?.method || "",
        type: p.type || "",
      });
    });
    cdp.on("Network.responseReceived", (p) => {
      const prev = requests.get(p.requestId) || {};
      requests.set(p.requestId, {
        ...prev,
        url: p.response?.url || prev.url || "",
        status: p.response?.status,
        mime: p.response?.mimeType || "",
        type: p.type || prev.type || "",
      });
    });
    cdp.on("Network.loadingFinished", (p) => {
      const meta = requests.get(p.requestId);
      if (!meta) return;
      const shouldRead =
        /XHR|Fetch/i.test(meta.type) ||
        /(upload|submit|store|file|process|instance|business|score|special|created|table|JSGLPT)/i.test(meta.url);
      if (!shouldRead) return;
      bodyPromises.push(
        cdp
          .send("Network.getResponseBody", { requestId: p.requestId })
          .then((body) => {
            const text = body.base64Encoded
              ? Buffer.from(body.body, "base64").toString("utf8")
              : body.body;
            logs.push({
              method: meta.method,
              status: meta.status,
              type: meta.type,
              url: meta.url,
              body: text.slice(0, 1200),
            });
          })
          .catch(() => { })
      );
    });

    const rc = await submitOneWithCdp(cdp, resolved);
    await sleep(5000);
    await Promise.allSettled(bodyPromises);
    console.log("NETWORK_LOGS");
    console.log(JSON.stringify(logs, null, 2));
    return rc;
  } finally {
    cdp.close();
  }
}

async function submitOneWithCdp(cdp, filePath) {
  const health = await ensureSubmitListReady(cdp);
  let info = health.info || await cdp.eval(probeExpression);
  console.log(`page: ${info.url}`);
  console.log(info.bodyText.slice(0, 800));

  if (health.reason === "login" || isLoginRequired(info.url, info.bodyText)) {
    console.log("LOGIN_REQUIRED: please finish login in the opened Chrome window, then rerun this command.");
    return 2;
  }
  if (!health.ok) {
    console.log(`SUBMIT_PAGE_NOT_READY: ${health.reason}`);
    console.log(JSON.stringify(info, null, 2));
    return 3;
  }

  let hasInput = info.inputs.some((x) => x.type === "file");
  if (!hasInput) {
    info = await openSubmitForm(cdp);
    hasInput = info.inputs.some((x) => x.type === "file");
  }

  if (!hasInput) {
    console.log("NO_FILE_INPUT");
    console.log(JSON.stringify(info, null, 2));
    return 3;
  }

  const removed = await cdp.eval(removeResultZipExpression);
  console.log("remove old file:", JSON.stringify(removed));
  await sleep(1500);

  const setOk = await setResultZipFileInput(cdp, filePath);
  console.log(`set file input: ${setOk} ${filePath}`);
  const ready = await waitForUploadReady(cdp);
  console.log("upload ready:", JSON.stringify(ready));
  if (!ready.ready) return 4;
  console.log(`waiting ${POST_UPLOAD_DELAY_MS}ms for platform form state to settle...`);
  await sleep(POST_UPLOAD_DELAY_MS);
  console.log("upload state after settle:", JSON.stringify(await cdp.eval(uploadStateExpression)));

  let clickedAt = "";
  const feedbackBeforeClick = await cdp.eval(submitFeedbackExpression);
  for (let i = 0; i < 3; i++) {
    assertFencedSubmitCapability(filePath);
    const clicked = await cdp.eval(clickSubmitButtonExpression);
    console.log("click:", JSON.stringify(clicked));
    if (clicked.clicked) {
      clickedAt = nowIsoForBrowser();
      console.log(`SUBMIT_CLICKED_AT=${clickedAt}`);
      break;
    }
    await sleep(5000);
  }

  if (!clickedAt) {
    console.log("SUBMIT_NOT_DISPATCHED=NO_SUBMIT_BUTTON_CLICKED");
    return 5;
  }
  const feedback = await waitForSubmitFeedback(cdp, feedbackBeforeClick.feedbackText || "");
  console.log("submit feedback:", JSON.stringify(feedback));
  if (feedback.success) {
    console.log(`SUBMIT_ACCEPTED_AT=${nowIsoForBrowser()}`);
  }
  if (feedback.failure) {
    console.log("SUBMIT_REJECTED_OR_STALE");
    return 6;
  }
  if (!feedback.success) {
    console.log("SUBMIT_ACCEPTANCE_UNCONFIRMED");
  }
  console.log(`waiting ${POST_SUBMIT_DELAY_MS}ms after submit...`);
  await sleep(POST_SUBMIT_DELAY_MS);
  info = await cdp.eval(probeExpression);
  console.log("after submit text:");
  console.log(info.bodyText.slice(0, 2000));
  return 0;
}

async function waitLogin(timeoutMs = 300000) {
  const cdp = await connectPage("submit");
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const info = await cdp.eval(probeExpression);
      console.log(`[${new Date().toLocaleTimeString()}] ${info.url}`);
      console.log(info.bodyText.slice(0, 300));
      if (!isLoginRequired(info.url, info.bodyText.slice(0, 800))) {
        console.log("LOGIN_OK");
        return 0;
      }
      await sleep(5000);
    }
    console.log("LOGIN_WAIT_TIMEOUT");
    return 2;
  } finally {
    cdp.close();
  }
}

async function clickExact(text) {
  const cdp = await connectPage("submit");
  try {
    const clicked = await cdp.eval(clickExactTextExpression(text));
    console.log(JSON.stringify(clicked, null, 2));
    await sleep(1500);
    const info = await cdp.eval(probeExpression);
    console.log(info.bodyText.slice(0, 1500));
    return clicked.clicked ? 0 : 1;
  } finally {
    cdp.close();
  }
}

async function inspectUpload() {
  const cdp = await connectPage("submit");
  try {
    let info = await cdp.eval(inspectUploadExpression);
    if (!info.uploads.some((x) => x.visible || x.accept.includes(".zip"))) {
      await cdp.eval(clickExactTextExpression("提交作品"));
      await sleep(2000);
      info = await cdp.eval(inspectUploadExpression);
    }
    console.log(JSON.stringify(info, null, 2));
    return 0;
  } finally {
    cdp.close();
  }
}

async function removeFile() {
  const cdp = await connectPage("submit");
  try {
    const removed = await cdp.eval(removeResultZipExpression);
    console.log(JSON.stringify(removed, null, 2));
    await sleep(1000);
    const info = await cdp.eval(inspectUploadExpression);
    console.log(JSON.stringify(info, null, 2));
    return removed.removed ? 0 : 1;
  } finally {
    cdp.close();
  }
}

async function clickCurrentSubmit() {
  const cdp = await connectPage("submit");
  try {
    const state = await cdp.eval(uploadStateExpression);
    console.log("current upload state:", JSON.stringify(state));
    if (!state.some((x) => x.ready)) {
      console.log("CURRENT_UPLOAD_NOT_READY");
      return 4;
    }
    console.log("waiting 20000ms before final submit click...");
    await sleep(20000);
    console.log("state before click:", JSON.stringify(await cdp.eval(uploadStateExpression)));
    const clicked = await cdp.eval(clickSubmitButtonExpression);
    console.log("click:", JSON.stringify(clicked));
    console.log("waiting 45000ms after final submit click...");
    await sleep(45000);
    const info = await cdp.eval(probeExpression);
    console.log("after final submit text:");
    console.log(info.bodyText.slice(0, 2000));
    return clicked.clicked ? 0 : 1;
  } finally {
    cdp.close();
  }
}

const submissionRecordsExpression = String.raw`
(() => {
  const trim = (s, n = 4000) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const headersFor = (table) => Array.from(table.querySelectorAll("thead th"))
    .map((th) => trim(th.innerText || th.textContent, 120))
    .filter(Boolean);
  const rowsFor = (table, headers) => Array.from(table.querySelectorAll("tbody tr"))
    .filter((tr) => visible(tr) && !tr.className.toString().includes("placeholder"))
    .map((tr, rowIndex) => {
      const cells = Array.from(tr.querySelectorAll("td")).map((td) => trim(td.innerText || td.textContent, 1000));
      const links = Array.from(tr.querySelectorAll("a[href]")).map((a) => ({
        text: trim(a.innerText || a.textContent, 200),
        href: a.href || ""
      }));
      const actionTexts = Array.from(tr.querySelectorAll("a,button,[role=button],.ant-btn,span"))
        .filter(visible)
        .map((el) => trim(el.innerText || el.textContent || el.title || el.getAttribute("aria-label") || "", 80))
        .filter(Boolean);
      const row = {};
      cells.forEach((cell, i) => {
        const key = headers[i] || "col_" + i;
        if (key && !/^操作$/.test(key)) row[key] = cell;
      });
      if (links.length) row.links = links;
      return { rowIndex, cells, row, text: trim(cells.join(" "), 2000), links, actionTexts };
    })
    .filter((row) => row.cells.some(Boolean));
  const tables = Array.from(document.querySelectorAll(".ant-table, table")).map((table, tableIndex) => {
    const headers = headersFor(table);
    const rows = rowsFor(table, headers);
    return {
      tableIndex,
      headers,
      rows,
      text: trim(table.innerText || table.textContent, 5000)
    };
  }).filter((table) => table.headers.length || table.rows.length || table.text);
  const headings = Array.from(document.querySelectorAll(
    "h1,h2,h3,.ant-page-header-heading-title,.ant-pro-card-title,.ant-tabs-tab-active,.ant-menu-item-selected"
  )).filter(visible).map((el) => trim(el.innerText || el.textContent, 120)).filter(Boolean);
  const links = Array.from(document.querySelectorAll("a[href]"))
    .filter(visible)
    .map((a) => ({ text: trim(a.innerText || a.textContent, 200), href: a.href || "" }))
    .filter((x) => x.text || x.href)
    .slice(0, 200);
  const paginationItems = Array.from(document.querySelectorAll(".ant-pagination li, .ant-pagination button, [class*='pagination'] li, [class*='pagination'] button"))
    .filter(visible)
    .map((el) => ({
      text: trim(el.innerText || el.textContent || el.title || el.getAttribute("aria-label") || "", 80),
      title: el.getAttribute("title") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      cls: (el.className || "").toString().slice(0, 160),
      disabled: el.getAttribute("aria-disabled") === "true" || el.disabled === true || /disabled/.test((el.className || "").toString())
    }))
    .filter((x) => x.text || x.title || x.ariaLabel || x.cls)
    .slice(0, 80);
  const currentPage = paginationItems.find((x) => /active/.test(x.cls) && /^\d+$/.test(x.text))?.text || "";
  const totalText = trim((document.body?.innerText || "").match(/共\s*\d+\s*条数据/)?.[0] || "", 80);
  const totalCount = Number((totalText.match(/\d+/) || [])[0] || 0) || null;
  const storageKeySample = (name) => {
    try {
      const storage = window[name];
      return { keys: Object.keys(storage || {}).slice(0, 100), error: "" };
    } catch (err) {
      return { keys: [], error: String(err?.name || "StorageAccessError") + ": " + String(err?.message || err || "") };
    }
  };
  const localStorageSample = storageKeySample("localStorage");
  const sessionStorageSample = storageKeySample("sessionStorage");
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    headings,
    bodyText: trim(document.body?.innerText || "", 12000),
    tables,
    links,
    pagination: {
      currentPage,
      totalText,
      totalCount,
      items: paginationItems
    },
    storageKeys: {
      localStorage: localStorageSample.keys,
      sessionStorage: sessionStorageSample.keys,
      errors: {
        localStorage: localStorageSample.error,
        sessionStorage: sessionStorageSample.error
      }
    }
  };
})()
`;

const clickMenuTextExpression = (texts) => `
(() => {
  const targets = ${JSON.stringify(texts)}.map((x) => x.replace(/\\s+/g, ""));
  const trim = (s) => (s || "").replace(/\\s+/g, "").trim();
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const candidates = Array.from(document.querySelectorAll(
    "a,button,li,span,div,[role=button],.ant-menu-item,.ant-menu-submenu-title,.ant-tabs-tab"
  )).filter(visible).map((el) => ({
    el,
    text: trim(el.innerText || el.textContent || el.title || el.getAttribute("aria-label") || ""),
    rawText: (el.innerText || el.textContent || el.title || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim()
  })).filter((x) => x.text);
  let picked = candidates.find((x) => targets.includes(x.text));
  if (!picked) {
    picked = candidates.find((x) => targets.some((target) => x.text.includes(target) && x.text.length <= target.length + 12));
  }
  if (!picked) return {clicked: false, targets};
  const clickable = picked.el.closest("a,button,[role=button],.ant-menu-item,.ant-menu-submenu-title,.ant-tabs-tab,li") || picked.el;
  clickable.scrollIntoView({block: "center", inline: "center"});
  clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return {
    clicked: true,
    text: picked.rawText.slice(0, 120),
    tag: clickable.tagName,
    cls: (clickable.className || "").toString().slice(0, 160)
  };
})()
`;

const fillSubmissionRecordsQueryExpression = (target) => `
(() => {
  const target = ${JSON.stringify(target || {})};
  const queryText = String(target.file || target.sha256 || "").split(/[\\\\/]/).pop().trim();
  if (!queryText) return {attempted: false, reason: "NO_SEARCHABLE_TARGET"};
  const trim = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const labelFor = (el) => {
    const id = el.id;
    const explicit = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
    const formItem = el.closest(".ant-form-item, .form-item, [class*='form-item']");
    return trim([
      explicit?.innerText || explicit?.textContent || "",
      formItem?.querySelector(".ant-form-item-label, label")?.innerText || "",
      el.placeholder || "",
      el.name || "",
      el.getAttribute("aria-label") || ""
    ].filter(Boolean).join(" "));
  };
  const inputs = Array.from(document.querySelectorAll("input,textarea"))
    .filter((el) => visible(el) && !el.disabled && !/^(hidden|file|checkbox|radio|password)$/i.test(el.type || ""))
    .map((el) => {
      const label = labelFor(el);
      let score = 0;
      if (/文件|作品|附件|名称|filename|file|name/i.test(label)) score += 8;
      if (/搜索|查询|关键字|keyword/i.test(label)) score += 4;
      if (el.value) score -= 1;
      return {el, label, score};
    })
    .sort((a, b) => b.score - a.score);
  const picked = inputs[0];
  if (!picked) return {attempted: true, filled: false, reason: "NO_VISIBLE_QUERY_INPUT", queryText};
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(picked.el), "value")?.set ||
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  picked.el.focus();
  if (setter) setter.call(picked.el, queryText);
  else picked.el.value = queryText;
  picked.el.dispatchEvent(new Event("input", { bubbles: true }));
  picked.el.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    attempted: true,
    filled: true,
    queryText,
    label: picked.label.slice(0, 160),
    placeholder: picked.el.placeholder || "",
    name: picked.el.name || "",
    cls: (picked.el.className || "").toString().slice(0, 160)
  };
})()
`;

const clickSubmissionRecordsNextPageExpression = String.raw`
(() => {
  const trim = (s) => (s || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const disabled = (el) => el.disabled === true || el.getAttribute("aria-disabled") === "true" || /disabled/.test((el.className || "").toString());
  const candidates = Array.from(document.querySelectorAll(
    ".ant-pagination-next, [title='下一页'], [aria-label='Next Page'], [aria-label='下一页'], button, a, li"
  )).filter(visible).map((el) => ({
    el,
    text: trim(el.innerText || el.textContent || el.title || el.getAttribute("aria-label") || ""),
    cls: (el.className || "").toString()
  })).filter((x) => /ant-pagination-next|下一页|Next Page|^>$|›|»/.test(x.cls + " " + x.text));
  const picked = candidates.find((x) => !disabled(x.el));
  if (!picked) {
    return {
      clicked: false,
      reason: candidates.length ? "NEXT_PAGE_DISABLED" : "NEXT_PAGE_NOT_FOUND",
      candidates: candidates.map((x) => ({text: x.text.slice(0, 80), cls: x.cls.slice(0, 120), disabled: disabled(x.el)})).slice(0, 10)
    };
  }
  const clickable = picked.el.closest("button,a,li,[role=button]") || picked.el;
  clickable.scrollIntoView({block: "center", inline: "center"});
  clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return {clicked: true, text: picked.text.slice(0, 80), cls: picked.cls.slice(0, 160)};
})()
`;

const clickSubmissionRecordDetailExpression = (tableIndex, rowIndex) => `
(() => {
  const targetTableIndex = ${Number(tableIndex)};
  const targetRowIndex = ${Number(rowIndex)};
  const trim = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const disabled = (el) => el.disabled === true || el.getAttribute("aria-disabled") === "true" || /disabled/.test((el.className || "").toString());
  const tables = Array.from(document.querySelectorAll(".ant-table, table"));
  const table = tables[targetTableIndex];
  if (!table) return {clicked: false, reason: "TABLE_NOT_FOUND", targetTableIndex, targetRowIndex};
  const rows = Array.from(table.querySelectorAll("tbody tr"))
    .filter((tr) => visible(tr) && !tr.className.toString().includes("placeholder"));
  const row = rows[targetRowIndex];
  if (!row) return {clicked: false, reason: "ROW_NOT_FOUND", targetTableIndex, targetRowIndex, rowCount: rows.length};
  const candidates = Array.from(row.querySelectorAll("a,button,[role=button],.ant-btn,span"))
    .filter((el) => visible(el) && !disabled(el))
    .map((el) => ({
      el,
      text: trim(el.innerText || el.textContent || el.title || el.getAttribute("aria-label") || ""),
      cls: (el.className || "").toString()
    }))
    .filter((x) => /详情|查看|明细|结果|分数|评分|打分|detail|view/i.test(x.text + " " + x.cls) && !/删除|移除|撤回|delete|remove/i.test(x.text + " " + x.cls));
  const picked = candidates[0];
  if (!picked) {
    return {
      clicked: false,
      reason: "DETAIL_ACTION_NOT_FOUND",
      targetTableIndex,
      targetRowIndex,
      rowText: trim(row.innerText || row.textContent, 500),
      actions: Array.from(row.querySelectorAll("a,button,[role=button],.ant-btn,span"))
        .filter(visible)
        .map((el) => trim(el.innerText || el.textContent || el.title || el.getAttribute("aria-label") || "", 80))
        .filter(Boolean)
        .slice(0, 20)
    };
  }
  const clickable = picked.el.closest("a,button,[role=button],.ant-btn") || picked.el;
  clickable.scrollIntoView({block: "center", inline: "center"});
  clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return {clicked: true, text: picked.text.slice(0, 120), cls: picked.cls.slice(0, 160), targetTableIndex, targetRowIndex};
})()
`;

const submissionRecordDetailExpression = String.raw`
(() => {
  const trim = (s, n = 4000) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const containers = Array.from(document.querySelectorAll(".ant-modal, .ant-drawer, .ant-popover, [role='dialog']"))
    .filter(visible)
    .map((el) => ({
      el,
      text: trim(el.innerText || el.textContent, 12000),
      cls: (el.className || "").toString().slice(0, 160)
    }))
    .filter((x) => x.text);
  const picked = containers[containers.length - 1];
  if (!picked) return {visible: false, fields: {}, text: "", containers: []};
  const root = picked.el;
  const fields = {};
  const add = (key, value) => {
    key = trim(key, 120).replace(/[：:]\s*$/, "");
    value = trim(value, 1000);
    if (key && value && key !== value && fields[key] === undefined) fields[key] = value;
  };
  for (const item of root.querySelectorAll(".ant-descriptions-item")) {
    add(item.querySelector(".ant-descriptions-item-label")?.innerText || "", item.querySelector(".ant-descriptions-item-content")?.innerText || "");
  }
  for (const item of root.querySelectorAll(".ant-form-item")) {
    add(item.querySelector(".ant-form-item-label, label")?.innerText || "", item.querySelector(".ant-form-item-control, .ant-form-item-control-input")?.innerText || "");
  }
  for (const tr of root.querySelectorAll("tr")) {
    const cells = Array.from(tr.querySelectorAll("th,td")).map((cell) => trim(cell.innerText || cell.textContent, 1000)).filter(Boolean);
    if (cells.length === 2) add(cells[0], cells[1]);
  }
  for (const line of picked.text.split(/\n| {2,}/)) {
    const m = trim(line, 1000).match(/^(.{1,80}?)[：:]\s*(.{1,900})$/);
    if (m) add(m[1], m[2]);
  }
  return {
    visible: true,
    text: picked.text,
    fields,
    cls: picked.cls,
    containers: containers.map((x) => ({cls: x.cls, text: x.text.slice(0, 1000)})).slice(-5)
  };
})()
`;

const closeSubmissionRecordDetailExpression = String.raw`
(() => {
  const trim = (s) => (s || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const candidates = Array.from(document.querySelectorAll(
    ".ant-modal-close, .ant-drawer-close, button[aria-label='Close'], button[aria-label='关闭'], .anticon-close, button, a"
  )).filter(visible).map((el) => ({
    el,
    text: trim(el.innerText || el.textContent || el.title || el.getAttribute("aria-label") || ""),
    cls: (el.className || "").toString()
  })).filter((x) => /ant-modal-close|ant-drawer-close|anticon-close|关闭|Close|取消|确定/.test(x.text + " " + x.cls));
  const picked = candidates[0];
  if (!picked) return {closed: false, reason: "CLOSE_NOT_FOUND"};
  const clickable = picked.el.closest("button,a,[role=button]") || picked.el;
  clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return {closed: true, text: picked.text.slice(0, 80), cls: picked.cls.slice(0, 160)};
})()
`;

function canonicalRecordKey(key) {
  const text = String(key || "").replace(/[\s_\-/:：()（）]+/g, "").toLowerCase();
  if (/^(id|recordid|workid|businessid|rowid)$/.test(text) || /作品id|记录id/.test(text)) return "record_id";
  if (/queueindex|队列/.test(text)) return "queue_index";
  if (/提交时间|创建时间|submittime|submittedat|acceptedat|createtime|createdat/.test(text)) return "submit_time";
  if (/打分时间|评分时间|scoretime|scoredat/.test(text)) return "score_time";
  if (/附件|文件名|作品文件|提交文件|filename|fileName|attachmentfilename/i.test(String(key || ""))) return "attachment_filename";
  if (/url|链接|地址|attachmenturl|downloadurl|fileurl/.test(text)) return "attachment_url";
  if (/hash|sha256|md5/.test(text)) return "attachment_hash";
  if (/失败原因|驳回原因|错误原因|failurereason|failreason|reason|message/.test(text)) return "failure_reason";
  if (/分数|成绩|score|得分/.test(text)) return "score";
  if (/状态|status|state|作品提交/.test(text)) return "status";
  if (/参赛编号|teamid|teamno|teamcode/.test(text)) return "team_id";
  if (/团队名称|teamname/.test(text)) return "team_name";
  if (/竞赛名称|competitionname/.test(text)) return "competition_name";
  if (/竞赛id|competitionid|compid/.test(text)) return "competition_id";
  return String(key || "");
}

function basenameFromUrl(value) {
  const text = String(value || "");
  if (!text) return "";
  try {
    const url = new URL(text, "https://reg.aicomp.cn");
    const name = decodeURIComponent(url.pathname.split("/").pop() || "");
    return /\./.test(name) ? name : "";
  } catch {
    const name = decodeURIComponent(text.split(/[\\/]/).pop() || "");
    return /\./.test(name) ? name : "";
  }
}

function shallowObject(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 1) return value;
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => shallowObject(item, depth + 1));
  const out = {};
  for (const [key, child] of Object.entries(value).slice(0, 80)) {
    if (child === null || ["string", "number", "boolean"].includes(typeof child)) out[key] = child;
    else if (typeof child === "object") out[key] = shallowObject(child, depth + 1);
  }
  return out;
}

function normalizeRecordObject(raw, source, sourceDetail = "") {
  const record = {
    source,
    sourceDetail,
    raw: shallowObject(raw)
  };
  for (const [key, value] of Object.entries(raw || {})) {
    const canonical = canonicalRecordKey(key);
    if (canonical && record[canonical] === undefined && value !== null && value !== undefined && typeof value !== "object") {
      record[canonical] = value;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [childKey, childValue] of Object.entries(value)) {
        const childCanonical = canonicalRecordKey(childKey);
        if (childCanonical && record[childCanonical] === undefined && childValue !== null && childValue !== undefined && typeof childValue !== "object") {
          record[childCanonical] = childValue;
        }
      }
    }
  }
  if (!record.attachment_filename) {
    record.attachment_filename = basenameFromUrl(record.attachment_url || record.url || "");
  }
  return record;
}

function recordsFromTables(info, pageIndex = 1) {
  const records = [];
  for (const table of info.tables || []) {
    for (const row of table.rows || []) {
      const text = row.text || "";
      if (!text || /暂无数据|No Data/i.test(text)) continue;
      const raw = { ...(row.row || {}) };
      raw._rowText = text;
      raw._cells = row.cells || [];
      raw._actionTexts = row.actionTexts || [];
      if (row.links?.length) {
        raw.attachmentUrl = row.links.find((link) => /\.(zip|rar|csv|txt)(\?|$)/i.test(link.href))?.href || row.links[0]?.href || "";
      }
      records.push(normalizeRecordObject(raw, "aicomp_submission_records_table", `page_${pageIndex}_table_${table.tableIndex}_row_${row.rowIndex ?? ""}`));
    }
  }
  return records;
}

function looksLikeSubmissionObject(obj) {
  const sample = JSON.stringify(shallowObject(obj)).slice(0, 4000);
  return /AIC-2026-\d+|swpu_1|\.zip|\.rar|作品|打分|评分|分数|成绩|提交|附件|team|score|submit|work|file|status/i.test(sample);
}

function recordsFromJson(value, sourceDetail, out = [], depth = 0) {
  if (!value || depth > 6) return out;
  if (Array.isArray(value)) {
    for (const item of value) recordsFromJson(item, sourceDetail, out, depth + 1);
    return out;
  }
  if (typeof value !== "object") return out;
  if (looksLikeSubmissionObject(value)) {
    out.push(normalizeRecordObject(value, "aicomp_submission_records_api", sourceDetail));
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") recordsFromJson(child, sourceDetail, out, depth + 1);
  }
  return out;
}

function dedupeRecords(records) {
  const seen = new Set();
  const out = [];
  for (const record of records) {
    const key = JSON.stringify([
      record.record_id || "",
      record.attachment_filename || "",
      record.submit_time || "",
      record.score_time || "",
      record.score || "",
      record.status || "",
      record.sourceDetail || "",
      JSON.stringify(record.raw || {}).slice(0, 500)
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

function recordHasPerSubmissionFields(record) {
  return Boolean(
    record?.attachment_filename ||
    record?.attachment_url ||
    record?.attachment_hash ||
    record?.submit_time ||
    record?.score_time ||
    (record?.score !== undefined && record?.score !== null && String(record.score).trim() !== "")
  );
}

function hasTargetValue(target, key) {
  const value = target?.[key];
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function targetComparableFieldNames(target) {
  const fields = [];
  if (hasTargetValue(target, "queue_index")) fields.push("queue_index");
  if (hasTargetValue(target, "file")) fields.push("attachment_filename");
  if (hasTargetValue(target, "sha256")) fields.push("attachment_hash");
  if (hasTargetValue(target, "submitted_at") || hasTargetValue(target, "accepted_at")) fields.push("submit_time");
  return fields;
}

function recordHasTargetComparableField(record, target) {
  return Boolean(
    (hasTargetValue(target, "queue_index") && hasTargetValue(record, "queue_index")) ||
    (hasTargetValue(target, "file") && (hasTargetValue(record, "attachment_filename") || hasTargetValue(record, "attachment_url"))) ||
    (hasTargetValue(target, "sha256") && hasTargetValue(record, "attachment_hash")) ||
    ((hasTargetValue(target, "submitted_at") || hasTargetValue(target, "accepted_at")) &&
      (hasTargetValue(record, "submit_time") || hasTargetValue(record, "create_time")))
  );
}

function summarizeRecordFields(records, target = {}) {
  const counts = {
    total: records.length,
    withRecordId: 0,
    withQueueIndex: 0,
    withFilename: 0,
    withSubmitTime: 0,
    withScore: 0,
    withScoreTime: 0,
    withStatus: 0,
    withTargetComparableField: 0,
    withAnyPerSubmissionField: 0
  };
  for (const record of records) {
    if (record.record_id) counts.withRecordId += 1;
    if (record.queue_index !== undefined && record.queue_index !== null && String(record.queue_index).trim() !== "") counts.withQueueIndex += 1;
    if (record.attachment_filename || record.attachment_url || record.attachment_hash) counts.withFilename += 1;
    if (record.submit_time) counts.withSubmitTime += 1;
    if (record.score !== undefined && record.score !== null && String(record.score).trim() !== "") counts.withScore += 1;
    if (record.score_time) counts.withScoreTime += 1;
    if (record.status) counts.withStatus += 1;
    if (recordHasTargetComparableField(record, target)) counts.withTargetComparableField += 1;
    if (recordHasPerSubmissionFields(record)) counts.withAnyPerSubmissionField += 1;
  }
  counts.targetComparableFields = targetComparableFieldNames(target);
  return counts;
}

function submissionRecordsFieldGap(fieldSummary, target = {}) {
  const targetFields = targetComparableFieldNames(target);
  const gaps = [];
  if (fieldSummary.total === 0) {
    gaps.push("NO_RECORDS_EXTRACTED");
  }
  if (targetFields.length > 0 && fieldSummary.withTargetComparableField === 0) {
    gaps.push("NO_TARGET_COMPARABLE_FIELD");
  }
  if (targetFields.length > 0 && fieldSummary.withScore === 0 && fieldSummary.withScoreTime === 0) {
    gaps.push("NO_SCORE_OR_SCORE_TIME_FIELD");
  }
  if (targetFields.length === 0 && fieldSummary.withAnyPerSubmissionField === 0) {
    gaps.push("NO_PER_SUBMISSION_FIELDS");
  }
  return {
    fieldsSufficient: gaps.length === 0,
    gaps,
    requiredTargetComparableFields: targetFields,
    requiresScoreEvidence: targetFields.length > 0
  };
}

function shouldCaptureNetworkBody(meta) {
  if (/XHR|Fetch/i.test(meta.type || "")) return true;
  return /Document/i.test(meta.type || "") &&
    /(score|result|record|appCreator|JSGLPT)/i.test(meta.url || "");
}

function isSubmissionRecordsRoute(info) {
  const text = compactText(info?.bodyText || "");
  const targetRoute = String(info?.url || "").includes("/app/JSGLPT/65b75207a58fdc32c79e9842");
  return (
    (info?.headings || []).some((heading) => /作品打分结果|打分结果|评分结果/.test(heading)) ||
    (targetRoute && /(?:作品打分结果|打分结果|评分结果)/.test(text)) ||
    /(?:作品打分结果|打分结果|评分结果)\s+共\s*\d+\s*条数据/.test(text)
  );
}

function submissionRecordsDataLoaded(info) {
  const text = compactText(info?.bodyText || "");
  const tables = info?.tables || [];
  return (
    /(?:作品打分结果|打分结果|评分结果)\s+共\s*\d+\s*条数据/.test(text) ||
    /暂无数据|暂无相关数据|无数据/.test(text) ||
    tables.some((table) => (table?.headers || []).length > 0 || (table?.rows || []).length > 0)
  );
}

function isSubmissionRecordsInfo(info) {
  return isSubmissionRecordsRoute(info) && submissionRecordsDataLoaded(info);
}

function classifySubmissionRecordsReadiness(info) {
  if (isSubmissionRecordsInfo(info)) return "records";
  const text = compactText(info?.bodyText || "");
  if (/登录|手机号|验证码|重新登录|login/i.test(text)) return "login";
  if (/无权限|访问被拒绝|系统错误|加载失败|network error|forbidden/i.test(text)) return "error";
  const targetRoute = String(info?.url || "").includes("/app/JSGLPT/65b75207a58fdc32c79e9842");
  const emptyShell = !info?.title && !(info?.headings || []).length && !(info?.tables || []).length;
  if (targetRoute && isSubmissionRecordsRoute(info)) return "records_loading";
  if (/^当前角色为[:：]/.test(text) || !text || (targetRoute && emptyShell)) return "bootstrap";
  return "wrong_page";
}

function readinessSample(info, kind, elapsedMs = 0) {
  return {
    kind,
    elapsedMs,
    url: info?.url || "",
    title: info?.title || "",
    headings: info?.headings || [],
    tableCount: info?.tables?.length || 0,
    text: compactText(info?.bodyText || "").slice(0, 240)
  };
}

function submissionRecordsReadinessFromSequence(infos) {
  const samples = [];
  let info = {};
  for (let index = 0; index < infos.length; index += 1) {
    info = infos[index] || {};
    const kind = classifySubmissionRecordsReadiness(info);
    samples.push(readinessSample(info, kind, index));
    if (["records", "login", "error"].includes(kind)) {
      return { ready: kind === "records", kind, info, samples, elapsedMs: index };
    }
  }
  const kind = samples.at(-1)?.kind || "bootstrap";
  return { ready: false, kind: "timeout", lastKind: kind, info, samples, elapsedMs: Math.max(0, infos.length - 1) };
}

async function waitForSubmissionRecordsReady(cdp, timeoutMs = RECORDS_NAVIGATION_TIMEOUT_MS) {
  const startedAt = Date.now();
  const samples = [];
  let info = {};
  while (true) {
    info = await cdp.eval(submissionRecordsExpression);
    const elapsedMs = Date.now() - startedAt;
    const kind = classifySubmissionRecordsReadiness(info);
    samples.push(readinessSample(info, kind, elapsedMs));
    if (["records", "login", "error"].includes(kind)) {
      return { ready: kind === "records", kind, info, samples: samples.slice(-20), elapsedMs };
    }
    if (elapsedMs >= timeoutMs) {
      return { ready: false, kind: "timeout", lastKind: kind, info, samples: samples.slice(-20), elapsedMs };
    }
    await sleep(Math.min(RECORDS_READINESS_POLL_MS, Math.max(1, timeoutMs - elapsedMs)));
  }
}

function submissionRecordsTargetFromEnv() {
  return {
    queue_index: process.env.AICOMP_RECORDS_TARGET_QUEUE_INDEX || "",
    file: process.env.AICOMP_RECORDS_TARGET_FILE || "",
    sha256: process.env.AICOMP_RECORDS_TARGET_SHA256 || "",
    submitted_at: process.env.AICOMP_RECORDS_TARGET_SUBMITTED_AT || "",
    accepted_at: process.env.AICOMP_RECORDS_TARGET_ACCEPTED_AT || ""
  };
}

function normalizedRecordFilename(value) {
  let text = String(value || "").trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep the original bounded text when it is not URL encoded.
  }
  return text.replaceAll("\\\\", "/").split("/").at(-1).toLowerCase();
}

function parseAicompRecordTime(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const isNaivePlatformTime = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text);
  const iso = !hasExplicitTimezone && isNaivePlatformTime
    ? `${text.replace(" ", "T")}+08:00`
    : text;
  const milliseconds = Date.parse(iso);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function matchSubmissionRecordTarget(record, target) {
  const matchedBy = [];
  const targetIndex = String(target?.queue_index || "").trim();
  const recordIndex = String(record?.queue_index || "").trim();
  if (targetIndex && recordIndex) {
    if (targetIndex !== recordIndex) return { matched: false, reason: "QUEUE_INDEX_MISMATCH" };
    matchedBy.push("queue_index");
  }

  const targetFile = normalizedRecordFilename(target?.file);
  const recordFile = normalizedRecordFilename(record?.attachment_filename || record?.attachment_url);
  if (targetFile && recordFile) {
    if (targetFile !== recordFile) return { matched: false, reason: "ATTACHMENT_FILENAME_MISMATCH" };
    matchedBy.push("attachment_filename");
  }

  const targetHash = String(target?.sha256 || "").trim().toLowerCase();
  const recordHash = String(record?.attachment_hash || "").trim().toLowerCase();
  if (targetHash && recordHash) {
    if (targetHash !== recordHash) return { matched: false, reason: "ATTACHMENT_HASH_MISMATCH" };
    matchedBy.push("attachment_hash");
  }

  const teamId = String(record?.team_id || "").trim();
  if (teamId && teamId !== TEAM_ID) return { matched: false, reason: "TEAM_ID_MISMATCH" };

  const targetTimes = [target?.accepted_at, target?.submitted_at].map(parseAicompRecordTime).filter((value) => value !== null);
  const recordTimes = [record?.submit_time, record?.create_time].map(parseAicompRecordTime).filter((value) => value !== null);
  if (targetTimes.length && recordTimes.length) {
    const deltas = targetTimes.flatMap((targetTime) => recordTimes.map((recordTime) => Math.abs(recordTime - targetTime)));
    const deltaMs = Math.min(...deltas);
    if (deltaMs > 15 * 60 * 1000) return { matched: false, reason: "SUBMIT_TIME_MISMATCH", deltaSeconds: Math.trunc(deltaMs / 1000) };
    matchedBy.push("submit_time");
  }

  if (!matchedBy.length) return { matched: false, reason: "NO_TARGET_COMPARABLE_FIELD" };
  return { matched: true, reason: `MATCHED_BY_${matchedBy.join("_").toUpperCase()}`, matchedBy };
}

function summarizeSubmissionAttribution(records, target) {
  const evaluated = records.map((record) => ({ record, match: matchSubmissionRecordTarget(record, target) }));
  const matched = evaluated.filter((item) => item.match.matched);
  const scoredMatched = matched.filter((item) => (
    item.record?.score !== undefined && item.record?.score !== null && String(item.record.score).trim() !== "" &&
    String(item.record?.score_time || "").trim() !== ""
  ));
  const attributionReady = matched.length === 1 && scoredMatched.length === 1;
  return {
    attributionReady,
    matchedRecordCount: matched.length,
    scoredMatchedRecordCount: scoredMatched.length,
    reason: matched.length > 1
      ? "AMBIGUOUS_MATCHING_SUBMISSION_RECORDS"
      : attributionReady
        ? "UNIQUE_MATCHED_RECORD_WITH_SCORE_AND_SCORE_TIME"
        : matched.length === 1
          ? "MATCHED_RECORD_SCORE_OR_SCORE_TIME_MISSING"
          : "NO_MATCHING_SUBMISSION_RECORD",
    evaluations: evaluated.slice(0, 80).map((item) => ({ match: item.match, sourceDetail: item.record?.sourceDetail || "" }))
  };
}

async function attemptSubmissionRecordsSearch(cdp, target) {
  const search = await cdp.eval(fillSubmissionRecordsQueryExpression(target)).catch((err) => ({ attempted: true, error: String(err) }));
  if (search?.filled && process.env.AICOMP_RECORDS_CLICK_QUERY !== "0") {
    search.queryClicked = await cdp.eval(clickExactTextExpression("查询")).catch((err) => ({ clicked: false, error: String(err) }));
    await sleep(4000);
  }
  return search || { attempted: false };
}

async function resetSubmissionRecordsSearch(cdp) {
  const reset = await cdp.eval(clickExactTextExpression("重置")).catch((err) => ({ clicked: false, error: String(err) }));
  await sleep(1200);
  const query = await cdp.eval(clickExactTextExpression("查询")).catch((err) => ({ clicked: false, error: String(err) }));
  await sleep(4000);
  return { reset, query };
}

async function collectSubmissionRecordsPages(cdp, firstInfo) {
  const pages = [];
  const tableRecords = [];
  const detailRecords = [];
  const detailAttempts = [];
  let info = firstInfo;
  let endReason = "MAX_PAGES_REACHED";

  pageLoop:
  for (let pageIndex = 1; pageIndex <= RECORDS_MAX_PAGES; pageIndex += 1) {
    const onRecordsPage = isSubmissionRecordsInfo(info);
    const visibleRecords = onRecordsPage ? recordsFromTables(info, pageIndex) : [];
    tableRecords.push(...visibleRecords);
    pages.push({
      pageIndex,
      onRecordsPage,
      url: info?.url || "",
      title: info?.title || "",
      headings: info?.headings || [],
      pagination: info?.pagination || {},
      tableCount: info?.tables?.length || 0,
      rowCount: (info?.tables || []).reduce((sum, table) => sum + (table.rows?.length || 0), 0),
      recordFieldSummary: summarizeRecordFields(visibleRecords),
      text: compactText(info?.bodyText || "").slice(0, 1200)
    });
    if (!onRecordsPage) {
      endReason = "LEFT_SUBMISSION_RECORDS_PAGE";
      break;
    }

    for (const table of info.tables || []) {
      for (const row of table.rows || []) {
        if (detailAttempts.length >= RECORDS_MAX_DETAILS) break;
        const clicked = await cdp.eval(clickSubmissionRecordDetailExpression(table.tableIndex, row.rowIndex)).catch((err) => ({
          clicked: false,
          error: String(err),
          targetTableIndex: table.tableIndex,
          targetRowIndex: row.rowIndex
        }));
        detailAttempts.push(clicked);
        if (!clicked?.clicked) continue;
        await sleep(RECORDS_DETAIL_WAIT_MS);
        const detail = await cdp.eval(submissionRecordDetailExpression).catch((err) => ({ visible: false, error: String(err), fields: {} }));
        if (detail?.visible) {
          const raw = { ...(detail.fields || {}), _detailText: detail.text || "", _detailClass: detail.cls || "" };
          detailRecords.push(normalizeRecordObject(raw, "aicomp_submission_record_detail", `page_${pageIndex}_table_${table.tableIndex}_row_${row.rowIndex}`));
        }
        const closed = await cdp.eval(closeSubmissionRecordDetailExpression).catch((err) => ({ closed: false, error: String(err) }));
        clicked.closeResult = closed;
        await sleep(500);
      }
      if (detailAttempts.length >= RECORDS_MAX_DETAILS) break;
    }

    if (detailAttempts.length >= RECORDS_MAX_DETAILS) {
      endReason = "MAX_DETAILS_REACHED";
      break pageLoop;
    }

    if (pageIndex >= RECORDS_MAX_PAGES) break;
    const next = await cdp.eval(clickSubmissionRecordsNextPageExpression).catch((err) => ({ clicked: false, error: String(err) }));
    pages[pages.length - 1].next = next;
    if (!next?.clicked) {
      endReason = next?.reason || "NEXT_PAGE_NOT_CLICKED";
      break;
    }
    await sleep(RECORDS_PAGE_WAIT_MS);
    info = await cdp.eval(submissionRecordsExpression);
  }

  return {
    records: [...tableRecords, ...detailRecords],
    tableRecords,
    detailRecords,
    pages,
    detailAttempts,
    endReason,
    truncated: endReason === "MAX_DETAILS_REACHED",
    limits: {
      maxPages: RECORDS_MAX_PAGES,
      maxDetails: RECORDS_MAX_DETAILS,
      pageWaitMs: RECORDS_PAGE_WAIT_MS,
      detailWaitMs: RECORDS_DETAIL_WAIT_MS
    }
  };
}

async function submissionRecordsFetch() {
  let cdp = null;
  const requests = new Map();
  let captureEpoch = 0;
  let activeNetworkCapture = { epoch: captureEpoch, networkEvidence: [], bodyPromises: [] };
  const beginNetworkCapture = () => {
    captureEpoch += 1;
    requests.clear();
    activeNetworkCapture = { epoch: captureEpoch, networkEvidence: [], bodyPromises: [] };
    return activeNetworkCapture;
  };
  try {
    cdp = await connectPage("submit");
    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", (p) => {
      requests.set(p.requestId, {
        capture: activeNetworkCapture,
        url: p.request?.url || "",
        method: p.request?.method || "",
        type: p.type || "",
        postData: (p.request?.postData || "").slice(0, 2000)
      });
    });
    cdp.on("Network.responseReceived", (p) => {
      const prev = requests.get(p.requestId) || {};
      requests.set(p.requestId, {
        ...prev,
        url: p.response?.url || prev.url || "",
        status: p.response?.status,
        mime: p.response?.mimeType || "",
        type: p.type || prev.type || ""
      });
    });
    cdp.on("Network.loadingFinished", (p) => {
      const meta = requests.get(p.requestId);
      if (!meta || meta.capture !== activeNetworkCapture || !shouldCaptureNetworkBody(meta)) return;
      const capture = meta.capture;
      capture.bodyPromises.push(
        cdp.send("Network.getResponseBody", { requestId: p.requestId })
          .then((body) => {
            if (meta.capture !== activeNetworkCapture) return;
            const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
            capture.networkEvidence.push({
              method: meta.method,
              status: meta.status,
              type: meta.type,
              mime: meta.mime,
              url: meta.url,
              postData: meta.postData,
              body: text.slice(0, 30000)
            });
          })
          .catch(() => {})
      );
    });

    await waitForPage(cdp, 30000).catch(() => {});
    const before = await cdp.eval(submissionRecordsExpression);
    let networkCapture = beginNetworkCapture();
    const clicked = await cdp.eval(clickMenuTextExpression(["作品打分结果", "打分结果", "评分结果"])).catch((err) => ({ clicked: false, error: String(err) }));
    let clickReadiness = await waitForSubmissionRecordsReady(
      cdp,
      Math.min(2500, RECORDS_NAVIGATION_TIMEOUT_MS)
    );
    let navigationFallback = { attempted: false, readiness: null };
    let after = clickReadiness.info;
    if (!clickReadiness.ready && !["login", "error"].includes(clickReadiness.kind)) {
      navigationFallback = { attempted: true, url: SCORE_RESULTS_URL, readiness: null };
      networkCapture = beginNetworkCapture();
      await cdp.send("Page.navigate", { url: SCORE_RESULTS_URL }).catch((err) => {
        navigationFallback.error = String(err);
      });
      const fallbackReadiness = await waitForSubmissionRecordsReady(cdp, RECORDS_NAVIGATION_TIMEOUT_MS);
      navigationFallback.readiness = fallbackReadiness;
      after = fallbackReadiness.info;
    }
    const onRecordsPage = isSubmissionRecordsInfo(after);
    const target = submissionRecordsTargetFromEnv();
    if (!onRecordsPage) {
      const text = compactText(after.bodyText || "");
      console.log(JSON.stringify({
        ok: false,
        reason: PER_SUBMISSION_SOURCE_UNAVAILABLE,
        source: "aicomp_submission_records_cdp",
        sourceAvailable: false,
        fieldsSufficient: false,
        time: nowIsoForBrowser(),
        records: [],
        diagnostics: {
          clicked,
          clickReadiness,
          target,
          before: {
            url: before.url,
            title: before.title,
            headings: before.headings,
            text: compactText(before.bodyText || "").slice(0, 1000)
          },
          navigationFallback,
          after: {
            url: after.url,
            title: after.title,
            headings: after.headings,
            text: text.slice(0, 2000),
            tables: after.tables?.map((table) => ({
              tableIndex: table.tableIndex,
              headers: table.headers,
              rowCount: table.rows?.length || 0,
              text: compactText(table.text || "").slice(0, 1000)
            })) || []
          }
        }
      }, null, 2));
      return 3;
    }

    const search = await attemptSubmissionRecordsSearch(cdp, target);
    after = await cdp.eval(submissionRecordsExpression);
    let collection = await collectSubmissionRecordsPages(cdp, after);
    let resetAfterEmptySearch = null;
    if (search?.filled && collection.records.length === 0 && process.env.AICOMP_RECORDS_RESET_AFTER_EMPTY_SEARCH !== "0") {
      resetAfterEmptySearch = await resetSubmissionRecordsSearch(cdp);
      after = await cdp.eval(submissionRecordsExpression);
      collection = await collectSubmissionRecordsPages(cdp, after);
    }

    await sleep(1000);
    await Promise.allSettled(networkCapture.bodyPromises);

    const apiRecords = [];
    for (const entry of networkCapture.networkEvidence) {
      try {
        const parsed = JSON.parse(entry.body);
        recordsFromJson(parsed, entry.url, apiRecords);
      } catch {
        // Non-JSON API payloads are still retained as raw evidence.
      }
    }
    const records = dedupeRecords([...collection.records, ...apiRecords]);
    const fieldSummary = summarizeRecordFields(records, target);
    const fieldGap = submissionRecordsFieldGap(fieldSummary, target);
    const fieldsSufficient = !collection.truncated && fieldGap.fieldsSufficient;
    const attribution = summarizeSubmissionAttribution(records, target);
    const text = compactText(after.bodyText || "");
    const reason = collection.truncated
      ? SUBMISSION_RECORDS_COLLECTION_TRUNCATED
      : fieldsSufficient
        ? "OK"
        : PER_SUBMISSION_FIELDS_INSUFFICIENT;
    console.log(JSON.stringify({
      ok: fieldsSufficient,
      reason,
      source: "aicomp_submission_records_cdp",
      sourceAvailable: true,
      fieldsSufficient,
      attributionReady: attribution.attributionReady,
      time: nowIsoForBrowser(),
      records,
      diagnostics: {
        clicked,
        target,
        search,
        resetAfterEmptySearch,
        fieldSummary,
        fieldGap,
        attribution,
        clickReadiness,
        collection: {
          endReason: collection.endReason,
          truncated: collection.truncated,
          limits: collection.limits,
          pageCount: collection.pages.length,
          detailAttempts: collection.detailAttempts.length,
          detailRecords: collection.detailRecords.length,
          tableRecords: collection.tableRecords.length,
          pages: collection.pages,
          detailAttemptSamples: collection.detailAttempts.slice(0, 40)
        },
        before: {
          url: before.url,
          title: before.title,
          headings: before.headings,
          text: compactText(before.bodyText || "").slice(0, 1000)
        },
        navigationFallback,
        after: {
          url: after.url,
          title: after.title,
          headings: after.headings,
          text: text.slice(0, 2000),
          tables: after.tables?.map((table) => ({
            tableIndex: table.tableIndex,
            headers: table.headers,
            rowCount: table.rows?.length || 0,
            text: compactText(table.text || "").slice(0, 1000)
          })) || []
        },
        networkEvidence: networkCapture.networkEvidence.map((entry) => ({
          method: entry.method,
          status: entry.status,
          type: entry.type,
          mime: entry.mime,
          url: entry.url,
          postData: entry.postData,
          body: entry.body.slice(0, 2000)
        })).slice(0, 80)
      }
    }, null, 2));
    return fieldsSufficient ? 0 : 4;
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      reason: PER_SUBMISSION_SOURCE_UNAVAILABLE,
      source: "aicomp_submission_records_cdp",
      sourceAvailable: false,
      fieldsSufficient: false,
      diagnostics: {
        error: String(error?.stack || error)
      },
      records: []
    }, null, 2));
    return 3;
  } finally {
    cdp?.close();
  }
}

async function submissionRecordsFixture(filePath) {
  const fixture = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const readiness = submissionRecordsReadinessFromSequence(
    Array.isArray(fixture?.readinessSnapshots) ? fixture.readinessSnapshots : [fixture]
  );
  const info = readiness.info || {};
  const target = submissionRecordsTargetFromEnv();
  if (!isSubmissionRecordsInfo(info)) {
    const text = compactText(info.bodyText || "");
    console.log(JSON.stringify({
      ok: false,
      reason: PER_SUBMISSION_SOURCE_UNAVAILABLE,
      source: "aicomp_submission_records_fixture",
      sourceAvailable: false,
      fieldsSufficient: false,
      time: nowIsoForBrowser(),
      records: [],
      diagnostics: {
        target,
        readiness,
        after: {
          url: info.url || "",
          title: info.title || "",
          headings: info.headings || [],
          text: text.slice(0, 2000),
          tables: info.tables?.map((table) => ({
            tableIndex: table.tableIndex,
            headers: table.headers,
            rowCount: table.rows?.length || 0,
            text: compactText(table.text || "").slice(0, 1000)
          })) || []
        }
      }
    }, null, 2));
    return 3;
  }

  const records = dedupeRecords(recordsFromTables(info, 1));
  const fieldSummary = summarizeRecordFields(records, target);
  const fieldGap = submissionRecordsFieldGap(fieldSummary, target);
  const fieldsSufficient = fieldGap.fieldsSufficient;
  const attribution = summarizeSubmissionAttribution(records, target);
  const reason = fieldsSufficient ? "OK" : PER_SUBMISSION_FIELDS_INSUFFICIENT;
  console.log(JSON.stringify({
    ok: fieldsSufficient,
    reason,
    source: "aicomp_submission_records_fixture",
    sourceAvailable: true,
    fieldsSufficient,
    attributionReady: attribution.attributionReady,
    time: nowIsoForBrowser(),
    records,
    diagnostics: {
      target,
      readiness,
      fieldSummary,
      fieldGap,
      attribution,
      after: {
        url: info.url || "",
        title: info.title || "",
        headings: info.headings || [],
        text: compactText(info.bodyText || "").slice(0, 2000),
        tables: info.tables?.map((table) => ({
          tableIndex: table.tableIndex,
          headers: table.headers,
          rowCount: table.rows?.length || 0,
          text: compactText(table.text || "").slice(0, 1000)
        })) || []
      }
    }
  }, null, 2));
  return fieldsSufficient ? 0 : 4;
}

async function leaderboardSnapshot() {
  const cdp = await connectPage("leaderboard");
  try {
    const start = Date.now();
    let info = null;
    let attempts = 0;
    while (Date.now() - start < LEADERBOARD_RETRY_MS) {
      attempts += 1;
      await cdp.send("Page.bringToFront").catch(() => {});
      await cdp.send("Page.navigate", { url: LEADERBOARD_URL });
      await sleep(10000);
      info = await cdp.eval(probeExpression);
      const page1Text = compactText(info.bodyText);
      let page2Text = "";
      if (!page1Text.includes(TEAM_ID)) {
        const clickedPage2 = await cdp.eval(String.raw`
(() => {
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const candidates = Array.from(document.querySelectorAll(".ant-pagination-item-2, li, button, a, [role=button]"))
    .filter((el) => visible(el) && (el.innerText || el.textContent || "").trim() === "2");
  const el = candidates[0];
  if (!el) return false;
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return true;
})()
`);
        if (clickedPage2) {
          await sleep(5000);
          const page2 = await cdp.eval(probeExpression);
          page2Text = compactText(page2.bodyText);
        }
      }
      const text = `${page1Text} ${page2Text}`.trim();
      if (page2Text) {
        info = { ...info, bodyText: `${info.bodyText}\n\n--- page 2 ---\n${page2Text}` };
      }
      const hasOurScore = new RegExp(`${TEAM_ID}.*?\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}.*?[0-9]+\\.[0-9]+`).test(text);
      if (hasOurScore) break;
      console.log(`leaderboard not ready; retry ${attempts}; text=${text.slice(0, 180)}`);
      await sleep(10000);
    }
    info ||= await cdp.eval(probeExpression);
    console.log(JSON.stringify({
      time: nowIsoForBrowser(),
      url: info.url,
      title: info.title,
      text: info.bodyText.slice(0, 5000),
    }, null, 2));
    return 0;
  } finally {
    cdp.close();
  }
}

async function heartbeat() {
  const cdp = await connectPage("submit");
  try {
    const health = await ensureSubmitListReady(cdp, 60000);
    const info = health.info || await cdp.eval(probeExpression);
    console.log(JSON.stringify({
      time: nowIsoForBrowser(),
      ok: health.ok,
      reason: health.reason,
      attempts: health.attempts,
      url: info.url,
      text: compactText(info.bodyText).slice(0, 800),
    }, null, 2));
    if (health.ok) return 0;
    if (health.reason === "login") return 2;
    return 3;
  } finally {
    cdp.close();
  }
}

async function printPages() {
  const pages = await listPages();
  console.log(JSON.stringify(
    pages
      .filter((p) => p.type === "page")
      .map((p) => ({
        kind: pageKind(p),
        title: p.title || "",
        url: p.url || "",
        id: p.id || "",
      })),
    null,
    2,
  ));
  return 0;
}

function nowIsoForBrowser() {
  return new Date().toISOString();
}

const args = process.argv.slice(2);
const cmd = args[0] || "probe";
if (isHelpArg(cmd) || isHelpArg(args[1])) {
  printUsage();
  process.exitCode = 0;
} else if (cmd === "probe") {
  await probe();
} else if (cmd === "submit-one") {
  const submitFile = process.argv[3] || DEFAULT_FILE;
  let gateAllowed = true;
  try {
    assertFencedSubmitCapability(submitFile);
  } catch (error) {
    console.error(`SUBMIT_GATE_REJECTED:${String(error?.message || error)}`);
    process.exitCode = EXIT_SECURITY;
    gateAllowed = false;
  }
  if (gateAllowed) process.exitCode = await submitOne(submitFile);
} else if (cmd === "submit-one-debug") {
  console.error("DIRECT_SUBMIT_COMMAND_DISABLED:submit-one-debug");
  process.exitCode = EXIT_SECURITY;
} else if (cmd === "wait-login") {
  process.exitCode = await waitLogin(Number(process.argv[3] || 300000));
} else if (cmd === "click-exact") {
  console.error("DIRECT_SUBMIT_COMMAND_DISABLED:click-exact");
  process.exitCode = EXIT_SECURITY;
} else if (cmd === "inspect-upload") {
  process.exitCode = await inspectUpload();
} else if (cmd === "remove-file") {
  console.error("DIRECT_SUBMIT_COMMAND_DISABLED:remove-file");
  process.exitCode = EXIT_SECURITY;
} else if (cmd === "click-current-submit") {
  console.error("DIRECT_SUBMIT_COMMAND_DISABLED:click-current-submit");
  process.exitCode = EXIT_SECURITY;
} else if (cmd === "submission-records") {
  process.exitCode = await submissionRecordsFetch();
} else if (cmd === "submission-records-fixture") {
  process.exitCode = await submissionRecordsFixture(process.argv[3] || "");
} else if (cmd === "leaderboard") {
  process.exitCode = await leaderboardSnapshot();
} else if (cmd === "heartbeat") {
  process.exitCode = await heartbeat();
} else if (cmd === "pages") {
  process.exitCode = await printPages();
} else {
  console.error(`Unknown command: ${cmd}`);
  process.exitCode = 1;
}
