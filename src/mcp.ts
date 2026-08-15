import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WikiService } from "./wiki.js";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

export function createMcpServer(wiki: WikiService) {
  const server = new McpServer({ name: "framework-llm-wiki", version: "0.1.0" });
  server.registerTool("search_wiki", {
    title: "Search Framework Wiki",
    description: "Search the centrally maintained InnoLive wiki. Search current knowledge by default; use read_note for the complete source note.",
    inputSchema: {
      query: z.string(),
      domain: z.string().optional(),
      owner: z.string().optional(),
      verification: z.string().optional(),
      include_history: z.boolean().optional(),
      limit: z.number().optional()
    }
  }, async ({ query, domain, owner, verification, include_history, limit }) => text(await wiki.search(query, {
    domain, owner, verification, includeHistory: include_history ?? false, limit: limit ?? 10
  })));

  server.registerTool("read_note", {
    title: "Read Wiki Note",
    description: "Read one exact Markdown note returned by search_wiki.",
    inputSchema: { path: z.string().min(1) }
  }, async ({ path }) => text(await wiki.getNote(path)));

  server.registerTool("get_current_metrics", {
    title: "Get Current Metrics",
    description: "Read the wiki singleton _현행_수치.md for the currently recorded InnoLive metrics. Verify separately against live systems when needed.",
    inputSchema: {}
  }, async () => text(await wiki.getNote("_현행_수치.md")));

  server.registerTool("get_wiki_status", {
    title: "Get Wiki Status",
    description: "Return the exact local wiki checkout commit and note count read by this server. This reports the mounted checkout; it does not pull or synchronize Git.",
    inputSchema: {}
  }, async () => text(await wiki.status()));

  return server;
}
