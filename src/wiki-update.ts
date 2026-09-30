import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { WikiChat, ChatError, type ChatInput, type Evidence } from "./chat.js";
import { hashContent, parseSections } from "./sections.js";
import type { WikiService } from "./wiki.js";
import { WikiGitHub } from "./wiki-github.js";

export class UpdateError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export const isUpdateCommand = (message: string) => /^\/업데이트(?:\s|$)/u.test(message.trim());
const notePath = z.string().min(1).max(500).refine((value) => value.endsWith(".md") && !/[\\\x00-\x1f\x7f]/.test(value)
  && value.split("/").every((part) => part && !part.startsWith(".") && !part.includes(":"))
  && !/^(AGENTS|CLAUDE|SKILL)\.md$/i.test(value.split("/").at(-1)!), "문서 경로를 확인해 주세요.");
const changeInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), path: notePath, content: z.string().min(1).max(30_000).refine((value) => Boolean(value.trim())) }).strict(),
  z.object({ action: z.literal("update"), path: notePath, content: z.string().min(1).max(30_000).refine((value) => Boolean(value.trim())) }).strict(),
  z.object({ action: z.literal("delete"), path: notePath }).strict()
]);
const modelPlan = z.object({ summary: z.string().trim().min(1).max(1000), changes: z.array(changeInput).max(4) }).strict()
  .refine((plan) => new Set(plan.changes.map((change) => change.path)).size === plan.changes.length)
  .refine((plan) => plan.changes.reduce((sum, change) => sum + ("content" in change ? change.content.length : 0), 0) <= 50_000);
export type UpdateChange = z.infer<typeof changeInput> & { before: string | null; before_hash: string | null };
export type UpdateProposal = { id: string; conversation_id: string; identity: string; summary: string; changes: UpdateChange[];
  created_at: number; status: "pending" | "published"; pr_url?: string; request_hash: string };

export class WikiUpdates {
  private publishing = new Set<string>();
  private proposing = new Set<string>();
  private requests = new Map<string, number[]>();
  constructor(readonly db: DatabaseSync, readonly wiki: WikiService, readonly github = new WikiGitHub()) {
    db.exec(`CREATE TABLE IF NOT EXISTS wiki_updates (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, identity TEXT NOT NULL, request_id TEXT UNIQUE NOT NULL, proposal TEXT NOT NULL);`);
  }
  get(id: string): UpdateProposal {
    const row = this.db.prepare("SELECT proposal FROM wiki_updates WHERE id=?").get(id) as { proposal: string } | undefined;
    if (!row) throw new UpdateError(404, "update_not_found", "변경안을 찾을 수 없습니다.");
    return JSON.parse(row.proposal);
  }
  forRequest(requestId: string) {
    const row = this.db.prepare("SELECT proposal FROM wiki_updates WHERE request_id=?").get(requestId) as { proposal: string } | undefined;
    return row ? JSON.parse(row.proposal) as UpdateProposal : undefined;
  }
  async propose(input: ChatInput, identity: string, conversationId: string, requestId: string) {
    if (!this.github.configured) throw new UpdateError(503, "update_unavailable", "Framework Bot의 문서 PR 연결을 준비하고 있습니다.");
    const prior = this.forRequest(requestId);
    const requestHash = hashContent(JSON.stringify({ input, identity, conversationId }));
    if (prior) {
      if (prior.request_hash !== requestHash) throw new UpdateError(409, "update_request_conflict", "변경안 요청이 달라졌습니다. 새 요청으로 보내 주세요.");
      return prior;
    }
    if (this.proposing.has(identity) || this.proposing.size >= 3) throw new UpdateError(429, "update_busy", "진행 중인 변경안이 끝난 뒤 다시 요청해 주세요.");
    const now = Date.now();
    for (const [key, times] of this.requests) if (!times.some((time) => time > now - 60_000)) this.requests.delete(key);
    const recent = (this.requests.get(identity) ?? []).filter((time) => time > now - 60_000);
    if (recent.length >= 6) throw new UpdateError(429, "update_rate_limit", "요청이 많습니다. 잠시 뒤 다시 시도해 주세요.");
    this.requests.set(identity, [...recent, now]); this.proposing.add(identity);
    try { return await this.prepare(input, identity, conversationId, requestId, requestHash); }
    finally { this.proposing.delete(identity); }
  }
  private async prepare(input: ChatInput, identity: string, conversationId: string, requestId: string, requestHash: string) {
    const query = [input.message.replace(/^\/업데이트\s*/u, ""), ...input.history.filter((message) => message.role === "user").slice(-4).map((message) => message.content)].join(" ").slice(0, 4000);
    const context = await this.wiki.getContext(query || "위키", { maxChars: 12_000, limit: 8 });
    const evidence: Evidence[] = [];
    let remaining = 40_000;
    const explicit = [...query.matchAll(/(?:^|\s|["'`])([^\s"'`]+\.md)(?=$|\s|["'`,])/g)].map((match) => match[1]).filter((filePath) => notePath.safeParse(filePath).success);
    const targets = new Set([...explicit, ...context.evidence.map((item) => item.path)]);
    for (const filePath of targets) {
      let note;
      try { note = await this.wiki.getNote(filePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const item = { path: note.path, title: note.title, content: note.content, content_hash: note.note_hash, metadata: note.metadata };
      // The bridge accepts 150 KB of UTF-8 JSON. Leave room for instructions and escaping.
      const wireBytes = Buffer.byteLength(JSON.stringify({ input: JSON.stringify({ question: input.message, history: input.history, evidence: [...evidence, item] }) }));
      if (note.content.length > remaining || wireBytes > 130_000) continue;
      evidence.push(item);
      remaining -= note.content.length;
    }
    const chat = new WikiChat(async () => ({ evidence, truncated: context.truncated || evidence.length < targets.size }));
    const result = await chat.answer(input, identity, "update");
    let plan: z.infer<typeof modelPlan>;
    try { plan = modelPlan.parse(JSON.parse(result.answer)); }
    catch { throw new ChatError(502, "invalid_update_response", "문서 변경안을 확인하지 못했습니다. 대상과 변경 내용을 구체적으로 적어 주세요."); }
    if (!plan.changes.length) return { clarification: plan.summary };
    const known = new Map(evidence.map((item) => [item.path, item]));
    const changes: UpdateChange[] = [];
    for (const change of plan.changes) {
      if (change.action === "delete" && !/삭제|지워|지우|제거|\bdelete\b|\bremove\b/i.test(query)) throw new UpdateError(400, "delete_not_requested", "삭제할 문서와 이유를 명시해 주세요.");
      let before: string | null = null;
      if (change.action === "create") {
        try { await this.wiki.getNote(change.path); throw new UpdateError(409, "create_collision", "같은 경로에 문서가 있습니다. 수정 요청으로 다시 보내 주세요."); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      } else {
        const original = known.get(change.path);
        if (!original) throw new UpdateError(400, "unknown_update_target", "대상 문서의 전체 원문을 확인하지 못했습니다. 문서 경로와 변경 내용을 다시 적어 주세요.");
        before = original.content;
      }
      if ("content" in change) {
        try { parseSections(change.content); } catch { throw new UpdateError(400, "invalid_markdown", "문서의 YAML 형식을 확인해 주세요."); }
        if (change.content === before) throw new UpdateError(400, "empty_update", "기존 문서와 변경안의 내용이 같습니다.");
      }
      changes.push({ ...change, before, before_hash: before === null ? null : hashContent(before) });
    }
    const proposal: UpdateProposal = { id: randomUUID(), conversation_id: conversationId, identity, summary: plan.summary, changes, created_at: Date.now(), status: "pending", request_hash: requestHash };
    this.db.prepare("INSERT INTO wiki_updates VALUES(?,?,?,?,?)").run(proposal.id, conversationId, identity, requestId, JSON.stringify(proposal));
    return proposal;
  }
  async publish(id: string, identity: string) {
    const proposal = this.get(id);
    if (proposal.identity !== identity) throw new UpdateError(403, "update_owner_required", "변경안을 요청한 팀원이 PR을 열 수 있습니다.");
    if (proposal.pr_url) return proposal;
    if (this.publishing.has(id)) throw new UpdateError(409, "update_busy", "PR을 만들고 있습니다. 잠시 뒤 다시 확인해 주세요.");
    this.publishing.add(id);
    try {
      const pr_url = await this.github.publish(proposal);
      const published: UpdateProposal = { ...proposal, status: "published", pr_url };
      this.db.prepare("UPDATE wiki_updates SET proposal=? WHERE id=?").run(JSON.stringify(published), id);
      return published;
    } finally { this.publishing.delete(id); }
  }
}
