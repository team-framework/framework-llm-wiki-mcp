import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import proxy from "@fastify/http-proxy";
import { z } from "zod";
import { WikiChat, ChatError, chatInput } from "./chat.js";
import { ChatHistoryStore, HistoryError } from "./chat-history.js";
import formbody from "@fastify/formbody";
import Fastify from "fastify";
import { GitHubAuth } from "./auth.js";
import { createMcpServer } from "./mcp.js";
import { WikiVectorIndex } from "./vector.js";
import { WikiService } from "./wiki.js";
import { MeasurementStore, WikiMeasurements, WEB_INTERACTION_FEATURES, type MeasurementActor } from "./measurements.js";
import type { FastifyRequest, FastifyReply } from "fastify";

export async function buildApp() {
const wikiRoot = process.env.WIKI_ROOT ?? "/wiki";
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const wiki = new WikiService(wikiRoot);
const vector = process.env.QDRANT_URL && process.env.EMBEDDING_URL ? new WikiVectorIndex(wiki, {
  qdrantUrl: process.env.QDRANT_URL, embeddingUrl: process.env.EMBEDDING_URL,
  cacheDir: process.env.EMBEDDING_CACHE_DIR ?? "/tmp/framework-wiki-embeddings"
}) : null;
if (vector) wiki.setSemanticSearch((query, options) => vector.search(query, options));
const auth = new GitHubAuth();
auth.assertConfigured();
const app = Fastify({ logger: { level: "warn", redact: ["req.headers.authorization", "req.headers.cookie"] }, disableRequestLogging: true, bodyLimit: 100_000 });
let measurementStore: MeasurementStore | null = null;
if (process.env.WIKI_MEASUREMENT_PATH && process.env.WIKI_MEASUREMENT_SECRET) {
  try { measurementStore = new MeasurementStore(process.env.WIKI_MEASUREMENT_PATH, process.env.WIKI_MEASUREMENT_SECRET,
    process.env.WIKI_MEASUREMENT_RELEASE ?? "unversioned", process.env.WIKI_MEASUREMENT_MODE ?? "production"); }
  catch { app.log.warn("Wiki measurement storage is unavailable."); }
}
const measurements = measurementStore ? new WikiMeasurements(measurementStore, wiki) : null;
const chatHistory = process.env.WIKI_CHAT_PATH ? new ChatHistoryStore(process.env.WIKI_CHAT_PATH) : null;
const actor = (request: FastifyRequest, client: MeasurementActor["client"]): MeasurementActor => auth.authorizeServiceRead(request) || auth.authorizeServiceMcpRead(request)
  ? { identity: "wiki-discord-service", kind: "service", client: "discord" }
  : { identity: auth.identity(request)!, kind: "person", client };
const measure = async <T>(request: FastifyRequest, client: MeasurementActor["client"], feature: string, task: () => Promise<T>) =>
  measurements ? measurements.run(actor(request, client), feature, task) : { value: await task(), id: null };
const sameOrigin = (request: FastifyRequest, reply: FastifyReply) => {
  if (!request.headers.authorization && auth.enabled && request.headers.origin !== new URL(auth.publicUrl).origin) {
    reply.code(403).send({ error: "same_origin_required", message: "같은 위키 페이지에서 요청해 주세요." }); return false;
  }
  return true;
};
const measurementPruneTimer = measurementStore ? setInterval(() => { try { measurementStore?.prune(); } catch { app.log.warn("Wiki measurement retention cleanup is unavailable."); } }, 60 * 60_000) : null;
measurementPruneTimer?.unref();
app.addHook("onClose", async () => { if (measurementPruneTimer) clearInterval(measurementPruneTimer); measurementStore?.close(); chatHistory?.close(); });
const chat = new WikiChat((query) => wiki.getContext(query, { maxChars: 12_000, limit: 8 }));
await app.register(formbody);
app.setErrorHandler((error, _request, reply) => {
  const failure = error as Error & { code?: string; statusCode?: number };
  if (failure.code === "ENOENT") return reply.code(404).send({ error: "note_not_found", message: "문서를 찾을 수 없습니다." });
  if (error instanceof z.ZodError || /Invalid wiki|Invalid.*path|Invalid section cursor|outside.*root/i.test(failure.message)) {
    return reply.code(400).send({ error: "invalid_request", message: "요청한 경로와 입력을 확인해 주세요." });
  }
  if (failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 500) return reply.code(failure.statusCode).send({ error: "invalid_request" });
  reply.code(500).send({ error: "request_failed", message: "요청을 처리하지 못했습니다." });
});

app.addHook("preValidation", async (request, reply) => {
  const pathname = request.url.split("?")[0];
  if (pathname === "/health" || pathname.startsWith("/auth/github/") || pathname.startsWith("/.well-known/") || pathname.startsWith("/oauth/")) return;
  const origin = request.headers.origin;
  if (origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
    return reply.code(403).send({ error: "Origin is not allowed." });
  }
  if (!auth.authorizeServiceRead(request) && !auth.authorizeServiceMcpRead(request) && !(await auth.authorize(request))) {
    if ((pathname === "/" || pathname === "/docs" || pathname.startsWith("/docs/") || pathname === "/chat" || pathname.startsWith("/chat/")) && !request.headers.authorization) return auth.startLogin(reply);
    return auth.rejectResourceRequest(reply);
  }
});

app.get("/health", async () => ({ ok: true, ...(await wiki.status()) }));
app.get("/.well-known/oauth-protected-resource/mcp", async () => auth.protectedResourceMetadata());
app.get("/.well-known/oauth-authorization-server", async () => auth.authorizationServerMetadata());
app.get("/.well-known/oauth-authorization-server/mcp", async () => auth.authorizationServerMetadata());
app.post("/oauth/register", async (request, reply) => {
  const clientId = auth.registerClient(request.body);
  if (!clientId) return reply.code(400).send({ error: "invalid_client_metadata" });
  return reply.code(201).send({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: (request.body as { redirect_uris?: string[] } | undefined)?.redirect_uris,
    token_endpoint_auth_method: "none"
  });
});
app.get("/oauth/authorize", async (request, reply) => auth.startAuthorization(request, reply));
app.post("/oauth/token", async (request, reply) => auth.exchangeToken(request, reply));
app.get("/auth/github/login", async (_request, reply) => auth.startLogin(reply));
app.get("/auth/github/callback", async (request, reply) => auth.finishLogin(request, reply));
app.post("/auth/github/logout", async (_request, reply) => auth.logout(reply));
app.get("/api/status", async () => ({ ...(await wiki.status()), vector: vector?.status() ?? { state: "disabled" } }));
app.get("/api/search", async (request, reply) => {
  const query = z.object({ q: z.string().max(4000).default(""), domain: z.string().optional(), owner: z.string().optional(), verification: z.string().optional(), include_history: z.string().optional() }).parse(request.query);
  const result = await measure(request, "web", "web.search", () => wiki.search(query.q, {
    domain: query.domain,
    owner: query.owner,
    verification: query.verification,
    includeHistory: query.include_history === "true"
  }));
  if (result.id) reply.header("X-Wiki-Event", result.id);
  return result.value;
});
app.get("/api/note", async (request) => {
  const query = z.object({ path: z.string().min(1) }).parse(request.query);
  return auth.authorizeServiceRead(request) ? (await measure(request, "discord", "discord.note", () => wiki.getNote(query.path))).value : wiki.getNote(query.path);
});

app.get("/", async (_request, reply) => reply.redirect("/docs"));
app.get("/api/tree", async (_request, reply) => {
  reply.header("Cache-Control", "private, no-store");
  return (await wiki.listNotes()).map((note) => ({ path: note.path, title: note.display?.title ?? note.title, domain: note.metadata.domain ?? null }));
});
app.get("/api/outline", async (request) => {
  const query = z.object({ path: z.string().min(1) }).parse(request.query);
  return auth.authorizeServiceRead(request) ? (await measure(request, "discord", "discord.outline", () => wiki.getOutline(query.path))).value : wiki.getOutline(query.path);
});
app.get("/api/context", async (request) => {
  const query = z.object({ q: z.string().min(1).max(4000), max_chars: z.coerce.number().int().min(1000).max(128000).optional(),
    domain: z.string().optional(), owner: z.string().optional(), verification: z.string().optional(),
    include_history: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(50).optional(), cursor: z.string().max(64000).optional()
  }).parse(request.query);
  const task = () => wiki.getContext(query.q, { maxChars: query.max_chars ?? 12000, domain: query.domain, owner: query.owner,
    verification: query.verification, includeHistory: query.include_history === "true", limit: query.limit, cursor: query.cursor });
  return auth.authorizeServiceRead(request) ? (await measure(request, "discord", "discord.context", task)).value : task();
});
app.post("/api/sections", async (request) => {
  const input = z.object({ refs: z.array(z.object({ path: z.string(), section_id: z.string(), hash: z.string().optional() })).min(1).max(30),
    max_chars: z.number().int().min(1000).max(24000).optional(), cursor: z.string().optional() }).parse(request.body);
  return wiki.readSections(input.refs, { maxChars: input.max_chars ?? 12000, cursor: input.cursor });
});
const savedChatInput = z.object({
  conversation_id: z.string().uuid(), expected_version: z.number().int().min(0), request_id: z.string().uuid(),
  message: z.string().trim().min(1).max(4_000), reasoning: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).default("max")
}).strict();
const historyFailure = (error: unknown, reply: FastifyReply) => {
  if (error instanceof HistoryError) return reply.code(error.status).send({ error: error.code, message: error.message });
  throw error;
};
app.get("/api/chat/conversations", async (request, reply) => {
  if (!chatHistory) return reply.code(503).send({ error: "chat_history_unavailable" });
  const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(30), cursor: z.string().max(256).optional() }).strict().parse(request.query);
  try { return chatHistory.list(query.limit, query.cursor); } catch (error) { return historyFailure(error, reply); }
});
app.post("/api/chat/conversations", async (request, reply) => {
  if (!sameOrigin(request, reply)) return;
  if (!chatHistory) return reply.code(503).send({ error: "chat_history_unavailable" });
  if (!z.object({}).strict().safeParse(request.body ?? {}).success) return reply.code(400).send({ error: "invalid_request" });
  try { return reply.code(201).send({ conversation: chatHistory.create(auth.identity(request)!) }); }
  catch (error) { return historyFailure(error, reply); }
});
app.get("/api/chat/conversations/:id", async (request, reply) => {
  if (!chatHistory) return reply.code(503).send({ error: "chat_history_unavailable" });
  const params = z.object({ id: z.string().uuid() }).parse(request.params);
  const query = z.object({ before_seq: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(request.query);
  try {
    const result = chatHistory.read(params.id, query.limit, query.before_seq);
    const identity = auth.identity(request)!;
    return { ...result, messages: result.messages.map((message) => {
      if (message.role !== "assistant") return message;
      const can_feedback = Boolean(message.measurement_id && measurementStore?.hasEvent(identity, message.measurement_id, "web.chat"));
      return { ...message, measurement_id: can_feedback ? message.measurement_id : null, can_feedback };
    }) };
  } catch (error) { return historyFailure(error, reply); }
});
app.post("/api/chat", async (request, reply) => {
  // Browser sessions must present the same origin. Bearer clients do not rely on cookies.
  if (!sameOrigin(request, reply)) return;
  const body = request.body;
  const saved = body !== null && typeof body === "object" && ["conversation_id", "expected_version", "request_id"].some((key) => key in body);
  if (saved) {
    if (!chatHistory) return reply.code(503).send({ error: "chat_history_unavailable" });
    const parsed = savedChatInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_chat_input", message: "대화 요청을 확인해 주세요." });
    const input = parsed.data, identity = auth.identity(request)!;
    let reserved;
    try { reserved = chatHistory.reserve(input.conversation_id, input.expected_version, input.request_id, identity, input.message, input.reasoning); }
    catch (error) { return historyFailure(error, reply); }
    if (reserved.completed) return reserved.completed;
    try {
      const result = await measure(request, "web", "web.chat", () => chat.answer({ message: input.message, reasoning: input.reasoning, history: reserved.history }, identity));
      const response = { ...result.value, measurement_id: result.id, history_truncated: reserved.history_truncated,
        ...(!measurements ? { measurement_status: "disabled" } : {}) };
      return chatHistory.complete(input.conversation_id, input.request_id, identity, input.message, result.value.answer, result.value.sources, result.id, response);
    } catch (error) {
      chatHistory.release(input.conversation_id, input.request_id);
      if (error instanceof ChatError) return reply.code(error.status).send({ error: error.code, message: error.message });
      return historyFailure(error, reply);
    }
  }
  const parsed = chatInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_chat_input", message: "질문 또는 대화 기록의 길이를 확인해 주세요." });
  reply.header("Cache-Control", "private, no-store");
  try { const result = await measure(request, "web", "web.chat", () => chat.answer(parsed.data, auth.identity(request)!));
    return { ...result.value, measurement_id: result.id, ...(!measurements ? { measurement_status: "disabled" } : {}) }; }
  catch (error) {
    if (error instanceof ChatError) return reply.code(error.status).send({ error: error.code, message: error.message });
    throw error;
  }
});
app.post("/api/events", async (request, reply) => {
  if (!sameOrigin(request, reply)) return;
  const input = z.object({ feature: z.enum(WEB_INTERACTION_FEATURES), path: z.string().min(1).max(1000).optional(), parent_event_id: z.string().uuid().optional() }).strict().parse(request.body);
  if (input.path) await wiki.getOutline(input.path);
  if (!measurementStore) return { measurement_id: null, measurement_status: "disabled" };
  if (input.parent_event_id) {
    const parentFeature = input.feature === "web.search_open" ? "web.search" : input.feature === "web.citation_open" ? "web.chat" : null;
    if (!parentFeature || !measurementStore.hasEvent(auth.identity(request)!, input.parent_event_id, parentFeature)) return reply.code(400).send({ error: "invalid_parent_event" });
  }
  const id = measurementStore.record(actor(request, "web"), { feature: input.feature, status: "ok", latency_ms: 0,
    ...(input.path ? { document_hash: measurementStore.documentKey(input.path) } : {}), ...(input.parent_event_id ? { parent_event_id: input.parent_event_id } : {}) });
  return { measurement_id: id };
});
app.post("/api/feedback", async (request, reply) => {
  if (!sameOrigin(request, reply)) return;
  const input = z.object({ event_id: z.string().uuid(), rating: z.enum(["positive", "negative"]), reason: z.enum(["correct", "missing_context", "outdated", "irrelevant", "slow", "other"]).optional() }).strict().parse(request.body);
  if (!measurementStore) return { recorded: false, measurement_status: "disabled" };
  if (!measurementStore.feedback(auth.identity(request)!, input.event_id, input.rating, input.reason)) return reply.code(404).send({ error: "feedback_event_not_found" });
  return { recorded: true };
});
app.get("/api/measurements", async (request) => {
  const input = z.object({ days: z.enum(["7", "30", "90"]).default("30") }).parse(request.query);
  return measurementStore ? measurementStore.report(Number(input.days)) : { status: "disabled", measurement_status: "disabled" };
});
app.post("/api/product-feedback", async (request, reply) => {
  if (!sameOrigin(request, reply)) return;
  const input = z.object({ categories: z.array(z.enum(["bug", "search_miss", "unclear_docs", "good_result", "slow", "other"])).min(1).max(3), details: z.string().trim().min(1).max(4000),
    diagnostics: z.object({ page_path: z.string().max(1000).regex(/^\/docs(?:\/|$)/).refine((value) => !/[?#]/.test(value)), viewport_width: z.number().int().min(320).max(10000), viewport_height: z.number().int().min(200).max(10000) }).strict().optional()
  }).strict().parse(request.body);
  if (!measurementStore) return { feedback_id: null, measurement_status: "disabled" };
  const id = measurementStore.productFeedback(auth.identity(request)!, input);
  return id ? { feedback_id: id } : reply.code(429).send({ error: "feedback_rate_limit", message: "오늘 보낸 의견이 많습니다. 내일 다시 보내 주세요." });
});
app.get("/api/product-feedback", async (request) => {
  const input = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
  return measurementStore ? { feedback: measurementStore.productFeedbackList(input.limit) } : { feedback: [], measurement_status: "disabled" };
});
app.addHook("onSend", async (request, reply) => {
  if (!request.url.startsWith("/health")) reply.header("Cache-Control", "private, no-store");
});
if (process.env.WIKI_WEB_URL) {
  for (const prefix of ["/docs", "/chat", "/_next"]) await app.register(proxy, { upstream: process.env.WIKI_WEB_URL, prefix, rewritePrefix: prefix });
} else {
  app.get("/docs", async (_request, reply) => reply.type("text/html; charset=utf-8").send("<h1>Framework Wiki</h1><p>문서 화면을 준비하고 있습니다.</p>"));
  app.get("/chat", async (_request, reply) => reply.type("text/html; charset=utf-8").send("<h1>Framework Wiki Chat</h1><p>대화 화면을 준비하고 있습니다.</p>"));
}

app.all("/mcp", async (request, reply) => {
  if (request.method !== "POST") {
    return reply.code(405).send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer(wiki, measurements ? async (feature, task) => (await measure(request, "mcp", feature, task)).value : undefined);
  await server.connect(transport);
  reply.hijack();
  await transport.handleRequest(request.raw, reply.raw, request.body);
  reply.raw.on("close", () => { void transport.close(); void server.close(); });
});

if (vector) {
  let timer: ReturnType<typeof setInterval>;
  app.addHook("onReady", async () => {
    void vector.sync();
    timer = setInterval(() => { void vector.sync(); }, 60_000);
    timer.unref();
  });
  app.addHook("onClose", async () => { clearInterval(timer); });
}
return app;
}
