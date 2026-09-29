import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import proxy from "@fastify/http-proxy";
import { z } from "zod";
import { WikiChat, ChatError, chatInput } from "./chat.js";
import formbody from "@fastify/formbody";
import Fastify from "fastify";
import { GitHubAuth } from "./auth.js";
import { createMcpServer } from "./mcp.js";
import { WikiVectorIndex } from "./vector.js";
import { WikiService } from "./wiki.js";

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
const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.headers.cookie"] }, bodyLimit: 100_000 });
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

app.addHook("onRequest", async (request, reply) => {
  const pathname = request.url.split("?")[0];
  if (pathname === "/health" || pathname.startsWith("/auth/github/") || pathname.startsWith("/.well-known/") || pathname.startsWith("/oauth/")) return;
  const origin = request.headers.origin;
  if (origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
    return reply.code(403).send({ error: "Origin is not allowed." });
  }
  if (!auth.authorizeServiceRead(request) && !(await auth.authorize(request))) {
    if ((pathname === "/" || pathname === "/docs" || pathname.startsWith("/docs/")) && !request.headers.authorization) return auth.startLogin(reply);
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
app.get("/api/search", async (request) => {
  const query = request.query as Record<string, string | undefined>;
  return wiki.search(query.q ?? "", {
    domain: query.domain,
    owner: query.owner,
    verification: query.verification,
    includeHistory: query.include_history === "true"
  });
});
app.get("/api/note", async (request) => {
  const query = z.object({ path: z.string().min(1) }).parse(request.query);
  return wiki.getNote(query.path);
});

app.get("/", async (_request, reply) => reply.redirect("/docs"));
app.get("/api/tree", async (_request, reply) => {
  reply.header("Cache-Control", "private, no-store");
  return (await wiki.listNotes()).map((note) => ({ path: note.path, title: note.title, domain: note.metadata.domain ?? null }));
});
app.get("/api/outline", async (request) => {
  const query = z.object({ path: z.string().min(1) }).parse(request.query);
  return wiki.getOutline(query.path);
});
app.get("/api/context", async (request) => {
  const query = z.object({ q: z.string().min(1).max(4000), max_chars: z.coerce.number().int().min(1000).max(128000).optional(),
    domain: z.string().optional(), owner: z.string().optional(), verification: z.string().optional(),
    include_history: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(50).optional(), cursor: z.string().max(64000).optional()
  }).parse(request.query);
  return wiki.getContext(query.q, { maxChars: query.max_chars ?? 12000, domain: query.domain, owner: query.owner,
    verification: query.verification, includeHistory: query.include_history === "true", limit: query.limit, cursor: query.cursor });
});
app.post("/api/sections", async (request) => {
  const input = z.object({ refs: z.array(z.object({ path: z.string(), section_id: z.string(), hash: z.string().optional() })).min(1).max(30),
    max_chars: z.number().int().min(1000).max(24000).optional(), cursor: z.string().optional() }).parse(request.body);
  return wiki.readSections(input.refs, { maxChars: input.max_chars ?? 12000, cursor: input.cursor });
});
app.post("/api/chat", async (request, reply) => {
  // Browser sessions must present the same origin. Bearer clients do not rely on cookies.
  const origin = request.headers.origin;
  if (!request.headers.authorization && auth.enabled && origin !== new URL(auth.publicUrl).origin) {
    return reply.code(403).send({ error: "same_origin_required", message: "같은 위키 페이지에서 요청해 주세요." });
  }
  const parsed = chatInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_chat_input", message: "질문 또는 대화 기록의 길이를 확인해 주세요." });
  reply.header("Cache-Control", "private, no-store");
  try { return await chat.answer(parsed.data, auth.identity(request)!); }
  catch (error) {
    if (error instanceof ChatError) return reply.code(error.status).send({ error: error.code, message: error.message });
    throw error;
  }
});
app.addHook("onSend", async (request, reply) => {
  if (!request.url.startsWith("/health")) reply.header("Cache-Control", "private, no-store");
});
if (process.env.WIKI_WEB_URL) {
  for (const prefix of ["/docs", "/_next"]) await app.register(proxy, { upstream: process.env.WIKI_WEB_URL, prefix, rewritePrefix: prefix });
} else {
  app.get("/docs", async (_request, reply) => reply.type("text/html; charset=utf-8").send("<h1>Framework Wiki</h1><p>문서 화면을 준비하고 있습니다.</p>"));
}

app.all("/mcp", async (request, reply) => {
  if (request.method !== "POST") {
    return reply.code(405).send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer(wiki);
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
