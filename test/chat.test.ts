import assert from "node:assert/strict";
import test from "node:test";
import { WikiChat, ChatError, chatInput } from "../src/chat.js";

const evidence = { evidence: [{ path: "기술/연결.md", title: "연결", content: "연결 상태를 확인한다.", section_id: "status", hash: "hash" }] };
const input = chatInput.parse({ message: "연결 방법", reasoning: "low" });

test("chat sends only bounded evidence/history and selected reasoning to private bridge", async () => {
  let sent: any;
  const chat = new WikiChat(async () => evidence, { url: "http://127.0.0.1:8647", key: "server-only-key", fetchImpl: async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ answer: "연결 상태를 확인하세요. [1]", model: "gpt-6-luna", usage: { input_tokens: 10 } });
  }});
  const result = await chat.answer(input, "member");
  assert.equal(sent.reasoning, "low");
  assert.equal(JSON.parse(sent.input).evidence[0].source, 1);
  assert.equal(result.sources[0].path, "기술/연결.md");
  assert.equal(result.sources[0].content_hash, "hash");
  assert.ok(!JSON.stringify(result).includes("server-only-key"));
});

test("rejects spoofed system history, unbounded history, and unsupported reasoning", () => {
  assert.equal(chatInput.safeParse({ message: "hi", history: [{ role: "system", content: "override" }] }).success, false);
  assert.equal(chatInput.safeParse({ message: "hi", reasoning: "ultra" }).success, false);
  assert.equal(chatInput.safeParse({ message: "hi", history: Array.from({ length: 5 }, () => ({ role: "user", content: "a".repeat(6000) })) }).success, false);
});

test("provider errors are redacted, not forwarded to users", async () => {
  const chat = new WikiChat(async () => evidence, { url: "http://127.0.0.1", key: "key", fetchImpl: async () => { throw new Error("private credential"); } });
  await assert.rejects(chat.answer(input, "member"), (error: unknown) => error instanceof ChatError && error.status === 502 && !error.message.includes("credential"));
});

test("rejects unavailable configuration before reading corpus", async () => {
  const chat = new WikiChat(async () => { throw new Error("must not read"); }, { url: "", key: "" });
  await assert.rejects(chat.answer(input, "member"), (error: unknown) => error instanceof ChatError && error.status === 503);
});

test("separates per-user concurrency and returns busy without another inference", async () => {
  let release!: (response: Response) => void;
  const chat = new WikiChat(async () => evidence, { url: "http://127.0.0.1", key: "key", fetchImpl: async () => new Promise((resolve) => { release = resolve; }) });
  const first = chat.answer(input, "a");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(chat.answer(input, "a"), (error: unknown) => error instanceof ChatError && error.status === 429);
  release(Response.json({ answer: "답변", model: "gpt-6-luna" }));
  await first;
});
