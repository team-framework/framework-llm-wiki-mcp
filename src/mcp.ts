import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WikiService, type ResolvedNote } from "./wiki.js";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
// Human Markdown is returned once. Web rendering still uses WikiService.getNote().
export function compactNote(note: ResolvedNote) { const { body: _duplicate, ...source } = note; return source; }
const filters = {
  domain: z.string().optional(), owner: z.string().optional(), verification: z.string().optional(),
  include_history: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional()
};
const budget = z.number().int().min(1).max(128_000).optional();

export function createMcpServer(wiki: WikiService) {
  const server = new McpServer({ name: "framework-llm-wiki", version: "0.1.0" });
  server.registerTool("search_wiki", {
    title: "Search Framework Wiki",
    description: "Find current wiki notes and matching section IDs, hashes and previews. Use get_context for bounded evidence, get_note_outline for headings, and read_sections for exact source sections.",
    inputSchema: {
      query: z.string(),
      ...filters
    }
  }, async ({ query, domain, owner, verification, include_history, limit }) => text(await wiki.search(query, {
    domain, owner, verification, includeHistory: include_history ?? false, limit: limit ?? 10
  })));

  server.registerTool("read_note", {
    title: "Read Wiki Note",
    description: "Read one complete Markdown note once, with resolved links and note hash. Prefer read_sections or get_context when only a part is needed.",
    inputSchema: { path: z.string().min(1) }
  }, async ({ path }) => text(compactNote(await wiki.getNote(path))));

  server.registerTool("get_context", {
    title: "Get Bounded Wiki Context",
    description: "Retrieve relevant sections with exact source paths, verification, hashes and bounded evidence JSON (default 12000 characters). Hybrid search falls back explicitly when vectors are unavailable. Never clips tables or fenced code; continue with read_sections using next_cursor.",
    inputSchema: { query: z.string().min(1), ...filters, max_chars: budget }
  }, async ({ query, domain, owner, verification, include_history, limit, max_chars }) => text(await wiki.getContext(query, {
    domain, owner, verification, includeHistory: include_history ?? false, limit, maxChars: max_chars
  })));

  server.registerTool("get_note_outline", {
    title: "Get Wiki Note Outline",
    description: "Return headings, exact section IDs, source line numbers, sizes and hashes without sending the Markdown body.",
    inputSchema: { path: z.string().min(1) }
  }, async ({ path }) => text(await wiki.getOutline(path)));

  server.registerTool("read_sections", {
    title: "Read Wiki Sections",
    description: "Read selected Markdown sections, optionally checking their hashes. max_chars bounds evidence JSON. Pass next_cursor with an empty refs array to continue; a stale hash requires a new outline. Oversized tables/code report required_chars instead of being clipped.",
    inputSchema: { refs: z.array(z.object({ path: z.string().min(1), section_id: z.string().min(1), hash: z.string().optional() })).max(64).default([]), max_chars: budget, cursor: z.string().optional() }
  }, async ({ refs, max_chars, cursor }) => text(await wiki.readSections(refs, { maxChars: max_chars, cursor })));

  server.registerTool("get_current_metrics", {
    title: "Get Current Metrics",
    description: "Read the wiki singleton _현행_수치.md for the currently recorded InnoLive metrics. Verify separately against live systems when needed.",
    inputSchema: {}
  }, async () => text(compactNote(await wiki.getNote("_현행_수치.md"))));

  server.registerTool("get_wiki_status", {
    title: "Get Wiki Status",
    description: "Return the exact local wiki checkout commit and note count read by this server. This reports the mounted checkout; it does not pull or synchronize Git.",
    inputSchema: {}
  }, async () => text(await wiki.status()));

  return server;
}
