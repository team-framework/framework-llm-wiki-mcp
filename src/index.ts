import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify from "fastify";
import { GitHubAuth } from "./auth.js";
import { createMcpServer } from "./mcp.js";
import { WikiService } from "./wiki.js";

const wikiRoot = process.env.WIKI_ROOT ?? "/wiki";
const port = Number(process.env.PORT ?? 3100);
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const wiki = new WikiService(wikiRoot);
const auth = new GitHubAuth();
auth.assertConfigured();
const app = Fastify({ logger: true });

app.addHook("onRequest", async (request, reply) => {
  if (request.url.startsWith("/health") || request.url.startsWith("/auth/github/")) return;
  const origin = request.headers.origin;
  if (origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
    return reply.code(403).send({ error: "Origin is not allowed." });
  }
  if (!(await auth.authorize(request, reply))) {
    if (request.url === "/" && !request.headers.authorization) return auth.startLogin(reply);
    return reply.code(401).send({ error: "Authentication required." });
  }
});

app.get("/health", async () => ({ ok: true, ...(await wiki.status()) }));
app.get("/auth/github/login", async (_request, reply) => auth.startLogin(reply));
app.get("/auth/github/callback", async (request, reply) => auth.finishLogin(request, reply));
app.post("/auth/github/logout", async (_request, reply) => auth.logout(reply));
app.get("/api/status", async () => wiki.status());
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
  const query = request.query as Record<string, string | undefined>;
  if (!query.path) throw new Error("path is required");
  return wiki.getNote(query.path);
});

app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(page));

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

await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });

const page = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Framework Wiki</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:0 16px;background:#fafafa;color:#1f2937}input,button{font:inherit;padding:9px}input{width:min(520px,65vw)}button{cursor:pointer}article{background:white;border:1px solid #e5e7eb;border-radius:8px;margin:12px 0;padding:16px}small{color:#6b7280}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#2563eb;text-decoration:none}</style></head><body><h1>Framework Wiki</h1><p>중앙 위키 읽기 전용 검색입니다.</p><form id="search"><input id="q" autofocus placeholder="예: WebRTC 연결 해제" required><button>검색</button></form><main id="result"></main><script>const result=document.querySelector('#result');document.querySelector('#search').onsubmit=async(e)=>{e.preventDefault();const q=document.querySelector('#q').value;const r=await fetch('/api/search?q='+encodeURIComponent(q));if(!r.ok){result.textContent='검색에 실패했습니다.';return}const notes=await r.json();result.innerHTML=notes.length?notes.map(n=>'<article><a href="#" data-path="'+encodeURIComponent(n.path)+'"><h2>'+escape(n.title)+'</h2></a><small>'+escape(n.path)+' · '+escape(n.domain||'미분류')+' · '+escape(n.verification||'')+'</small><p>'+escape(n.excerpt)+'</p></article>').join(''):'검색 결과가 없습니다.'};result.onclick=async(e)=>{const a=e.target.closest('a[data-path]');if(!a)return;e.preventDefault();const r=await fetch('/api/note?path='+a.dataset.path);const n=await r.json();result.innerHTML='<article><p><a href="/">← 검색으로</a></p><h2>'+escape(n.title)+'</h2><pre>'+escape(n.content)+'</pre></article>'};function escape(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</script></body></html>`;
