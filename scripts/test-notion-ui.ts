import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { buildApp } from "../src/app.js";

const root = await mkdtemp(path.join(os.tmpdir(), "notion-ui-"));
const output = path.resolve("test-results/notion-ui");
const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
await mkdir(output, { recursive: true });
await writeFile(path.join(root, "FaceSwapS.md"), "# FaceSwapS\n\n자체 얼굴 합성 모델의 재구성 지표는 신원 전달 성공을 뜻하지 않는다.\n");
Object.assign(process.env, { WIKI_ROOT: root, WIKI_CHAT_PATH: path.join(root, "history.sqlite"), AUTH_MODE: "disabled", HERMES_WIKI_URL: "http://provider.test", HERMES_WIKI_KEY: "synthetic-key" });
for (const name of ["QDRANT_URL", "EMBEDDING_URL", "WIKI_MEASUREMENT_PATH", "WIKI_MEASUREMENT_SECRET", "ALLOWED_ORIGINS"]) delete process.env[name];
const originalFetch = fetch;
const requests: any[] = [];
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith("http://provider.test")) return originalFetch(url, init);
  const request = JSON.parse(String(init?.body)); requests.push(request);
  const evidence = JSON.parse(request.input).evidence;
  const source = evidence.find((item: any) => item.source_type === "notion");
  assert.ok(source); assert.match(source.content, /FaceSwapS/);
  return Response.json({ model: "gpt-6-luna", answer: `FaceSwapS 자체 모델의 재구성 성능과 신원 전달을 분리해 평가해야 합니다. [${source.source}]` });
};
const entity = { id, parent: { type: "workspace", workspace: true }, last_edited_time: "2026-10-01T00:00:00Z", properties: { title: { type: "title", title: [{ plain_text: "FaceSwapS 실험" }] } } };
const probe = createServer(); await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const webPort = (probe.address() as { port: number }).port; await new Promise<void>((resolve) => probe.close(() => resolve()));
process.env.WIKI_WEB_URL = `http://127.0.0.1:${webPort}`;
const app = await buildApp({ notion: { token: "synthetic-notion-token", rootIds: [id], intervalMs: 0, fetchImpl: async (url) => {
  const endpoint = new URL(String(url)).pathname;
  if (endpoint === "/v1/search") return Response.json({ results: [entity], has_more: false });
  if (endpoint.endsWith("/markdown")) return Response.json({ markdown: "# FaceSwapS 실험\n\n자체 얼굴 합성 모델의 정량 결과와 정성 평가 기록이다.\n", truncated: false, unknown_block_ids: [] });
  return Response.json(entity);
} } });
await app.listen({ port: 0, host: "127.0.0.1" });
const apiUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
await cp("web/.next/static", "web/.next/standalone/.next/static", { recursive: true });
await cp("web/public", "web/.next/standalone/public", { recursive: true });
const server = spawn(process.execPath, ["web/.next/standalone/server.js"], { env: { ...process.env, WIKI_API_URL: apiUrl, PORT: String(webPort), HOSTNAME: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Web startup timed out")), 30000);
    server.once("error", reject); server.once("exit", (code) => reject(new Error(`Web exited ${code}`)));
    server.stdout.on("data", (chunk) => { if (String(chunk).includes("Ready")) { clearTimeout(timer); resolve(); } });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.WIKI_TEST_BROWSER_CHANNEL ? { channel: process.env.WIKI_TEST_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${apiUrl}/chat`);
  const input = page.getByRole("textbox", { name: "위키 Agent에게 질문" });
  const send = page.getByRole("button", { name: "질문 보내기", exact: true });
  await input.fill("FaceSwapS 얼굴 합성 아키텍처와 정량·정성 결과, 다음 방향을 정리해줘"); await send.click();
  const citation = page.getByRole("link").filter({ hasText: "Notion · FaceSwapS" }); await citation.first().waitFor();
  assert.equal(await citation.first().getAttribute("href"), `https://app.notion.com/p/${id}`);
  await input.fill("자체 모델만. InSwapper / GHOST 제외"); await send.click();
  await page.waitForFunction(() => document.querySelectorAll(".wiki-chat-message-assistant").length === 2);
  assert.equal(requests.length, 2);
  const followup = JSON.parse(requests[1].input);
  assert.match(followup.question, /InSwapper \/ GHOST 제외/);
  assert.ok(followup.history.some((message: any) => message.role === "user" && message.content.includes("아키텍처")));
  assert.match(requests[1].instructions, /최신 범위 수정·제외 지시/);
  await page.screenshot({ path: path.join(output, "desktop.png") });
  await page.reload(); await citation.first().waitFor();
  assert.equal(await page.locator(".wiki-chat-message-assistant").count(), 2);
  assert.equal(await citation.first().getAttribute("href"), `https://app.notion.com/p/${id}`);
  await page.setViewportSize({ width: 390, height: 844 });
  const close = page.getByRole("button", { name: "대화 목록 닫기", exact: true }); if (await close.count()) await close.click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, "mobile.png") });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ syntheticNotionCitation: "passed", historyScopeCorrection: "passed", persistedReload: "passed", mobile: "passed", pageErrors: errors, screenshots: output }));
} finally {
  await browser?.close(); server.kill("SIGTERM"); await app.close(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true });
}
