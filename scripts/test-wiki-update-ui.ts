import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { buildApp } from "../src/app.js";
import { githubFixture } from "../test/wiki-github-fixture.js";

const root = await mkdtemp(path.join(os.tmpdir(), "wiki-update-ui-"));
const output = path.resolve("test-results/wiki-update-ui");
const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const old = "# 연결\n\n기존 연결 안내를 확인한다.\n";
await writeFile(path.join(root, "연결.md"), old);
await writeFile(path.join(root, "폐기.md"), "# 폐기\n\n지난 안내\n");
await writeFile(path.join(root, "bot.pem"), keys.privateKey, { mode: 0o600 });
await mkdir(output, { recursive: true });
Object.assign(process.env, { WIKI_ROOT: root, WIKI_CHAT_PATH: path.join(root, "history.sqlite"), AUTH_MODE: "disabled", HERMES_WIKI_URL: "http://provider.test", HERMES_WIKI_KEY: "synthetic-provider-key",
  WIKI_GITHUB_APP_CLIENT_ID: "synthetic-bot", WIKI_GITHUB_APP_SLUG: "framework-harness-sync", WIKI_GITHUB_APP_PRIVATE_KEY_PATH: path.join(root, "bot.pem"), WIKI_GITHUB_REPOSITORY: "team-framework/framework-llm-wiki", WIKI_TRACKING_ISSUE: "123" });
for (const name of ["QDRANT_URL", "EMBEDDING_URL", "WIKI_MEASUREMENT_PATH", "WIKI_MEASUREMENT_SECRET", "ALLOWED_ORIGINS"]) delete process.env[name];
const fixture = githubFixture(keys.publicKey, { "연결.md": old, "폐기.md": "# 폐기\n\n지난 안내\n" });
const originalFetch = fetch;
let createCollision = false;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("http://provider.test")) return Response.json({ model: "gpt-6-luna", answer: JSON.stringify({ summary: "연결 안내를 갱신하고 팀 결정을 기록합니다.", changes: createCollision ? [{ action: "create", path: "연결.md", content: "# 생성 충돌\n" }] : [
    { action: "update", path: "연결.md", content: "# 연결\n\n연결 상태를 확인하고 다시 연결한다.\n" },
    { action: "create", path: "팀결정.md", content: "# 팀 결정\n\n팀원이 확인한 변경 사항을 기록한다.\n" }, { action: "delete", path: "폐기.md" }
  ] }) });
  if (String(url).startsWith("https://api.github.com")) return fixture.fetchImpl(url, init);
  return originalFetch(url, init);
};

const portProbe = createServer();
await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const webPort = (portProbe.address() as { port: number }).port;
await new Promise<void>((resolve) => portProbe.close(() => resolve()));
process.env.WIKI_WEB_URL = `http://127.0.0.1:${webPort}`;
const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const apiUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
await cp("web/.next/static", "web/.next/standalone/.next/static", { recursive: true });
await cp("web/public", "web/.next/standalone/public", { recursive: true });
const server = spawn(process.execPath, ["web/.next/standalone/server.js"], { env: { ...process.env, WIKI_API_URL: apiUrl, PORT: String(webPort), HOSTNAME: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Web startup timed out")), 30_000);
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Web exited (${code})`)); });
    server.stdout.on("data", (chunk) => { if (String(chunk).includes("Ready")) { clearTimeout(timer); resolve(); } });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.WIKI_TEST_BROWSER_CHANNEL ? { channel: process.env.WIKI_TEST_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const input = page.getByRole("textbox", { name: "위키 Agent에게 질문" });
  const send = page.getByRole("button", { name: "질문 보내기", exact: true });
  const settle = () => page.waitForFunction(() => [...document.querySelectorAll(".wiki-chat-message-assistant")].every((element) => Number(getComputedStyle(element).opacity) > .99));
  await page.goto(`${apiUrl}/chat`);
  await page.getByRole("button", { name: "/업데이트 문서 생성·수정·삭제", exact: true }).click();
  assert.equal(await input.inputValue(), "/업데이트 ");
  await input.fill("/업데이트 연결.md 수정, 폐기.md 삭제, 팀결정.md 생성"); await send.click();
  const card = page.getByRole("region", { name: "문서 변경안" });
  await card.waitFor(); assert.equal(await card.locator("details").count(), 3);
  await card.locator("summary").first().click();
  await card.getByText("현재 문서", { exact: true }).first().waitFor();
  await card.getByText("변경 후", { exact: true }).first().waitFor();
  await settle(); await page.screenshot({ path: path.join(output, "desktop.png") });
  await card.getByRole("button", { name: "PR 열기", exact: true }).click();
  const pr = card.getByRole("link", { name: "PR 보기" }); await pr.waitFor();
  assert.match((await pr.getAttribute("href"))!, /^https:\/\/github.com\/team-framework\/framework-llm-wiki\/pull\/\d+$/);
  assert.equal(fixture.pulls.length, 1); assert.ok(fixture.pulls[0].draft);
  await page.reload(); await page.getByRole("link", { name: "PR 보기" }).waitFor();
  assert.ok(page.url().includes("conversation="));
  await page.setViewportSize({ width: 390, height: 844 });
  const closeHistory = page.getByRole("button", { name: "대화 목록 닫기", exact: true });
  if (await closeHistory.count()) await closeHistory.click();
  await settle(); await card.locator("summary").first().click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, "mobile.png") });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.waitForFunction(() => {
    const link = document.querySelector(".wiki-update-footer a");
    return link && getComputedStyle(link).backgroundColor === "rgb(245, 245, 245)";
  });
  await page.screenshot({ path: path.join(output, "mobile-dark.png") });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.getByRole("button", { name: "새 대화", exact: true }).click();
  await page.getByText("무엇을 찾고 있나요?", { exact: true }).waitFor();
  await input.fill("/업데이트 연결.md 수정, 폐기.md 삭제, 팀결정.md 생성"); await send.click();
  await card.waitFor();
  fixture.changeBase("연결.md", "# 다른 팀원이 바꾼 원문\n");
  await card.getByRole("button", { name: "PR 열기", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "원본 문서가 바뀌었습니다." }).waitFor();
  createCollision = true;
  await page.getByRole("button", { name: "새 대화", exact: true }).click();
  await page.getByText("무엇을 찾고 있나요?", { exact: true }).waitFor();
  await input.fill("/업데이트 연결.md 생성"); await send.click();
  await page.getByRole("alert").filter({ hasText: "같은 경로에 문서가 있습니다." }).waitFor();
  assert.equal(fixture.pulls.length, 1); assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ desktop: "passed", mobile: "passed", preview: "passed", publish: "passed", persistedReload: "passed", staleConflict: "passed", createCollision: "passed", pageErrors, screenshots: output }));
} finally {
  await browser?.close(); server.kill("SIGTERM"); await app.close(); globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
