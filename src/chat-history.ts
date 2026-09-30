import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatInput } from "./chat.js";

export type Conversation = { id: string; title: string; created_at: number; updated_at: number; version: number; message_count: number };
export type SavedMessage = { id: string; seq: number; role: "user" | "assistant"; content: string; created_at: number; author?: string; sources?: unknown[]; measurement_id?: string | null; can_feedback?: boolean; update_id?: string };
type RequestRow = { request_id: string; conversation_id: string; identity: string; fingerprint: string; status: string; response: string | null };

export class HistoryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const conflict = () => new HistoryError(409, "conversation_conflict", "대화가 갱신되었습니다. 새 기록을 확인해 주세요.");
const notFound = () => new HistoryError(404, "conversation_not_found", "대화를 찾을 수 없습니다.");
const hashRequest = (identity: string, value: unknown) => createHash("sha256").update(JSON.stringify([identity, value])).digest("hex");

export class ChatHistoryStore {
  readonly db: DatabaseSync;
  constructor(readonly filename: string, readonly now = Date.now) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL,
        pending_request_id TEXT, pending_until INTEGER);
      CREATE INDEX IF NOT EXISTS conversations_recent ON conversations(updated_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL,
        author TEXT, sources TEXT, measurement_id TEXT,
        UNIQUE(conversation_id, seq));
      CREATE INDEX IF NOT EXISTS messages_page ON messages(conversation_id, seq DESC);
      CREATE TABLE IF NOT EXISTS chat_requests (
        request_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, identity TEXT NOT NULL,
        fingerprint TEXT NOT NULL, status TEXT NOT NULL, response TEXT);
      CREATE INDEX IF NOT EXISTS chat_requests_conversation ON chat_requests(conversation_id);`);
    if (!this.db.prepare("PRAGMA table_info(messages)").all().some((column) => column.name === "update_id")) this.db.exec("ALTER TABLE messages ADD COLUMN update_id TEXT");
  }

  close() { this.db.close(); }

  private transaction<T>(task: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = task(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private conversation(id: string): Conversation {
    const row = this.db.prepare("SELECT id,title,created_at,updated_at,version,message_count FROM conversations WHERE id=?").get(id) as Conversation | undefined;
    if (!row) throw notFound();
    return row;
  }

  create(identity: string): Conversation {
    return this.transaction(() => {
      const id = randomUUID(), at = this.now();
      const recent = this.db.prepare("SELECT count(*) AS n FROM conversations WHERE created_by=? AND created_at>?").get(identity, at - 86_400_000) as { n: number };
      if (recent.n >= 50) throw new HistoryError(429, "conversation_limit", "오늘 만든 대화가 많습니다. 기존 대화를 이용해 주세요.");
      this.db.prepare("INSERT INTO conversations(id,title,created_at,updated_at,version,message_count,created_by) VALUES(?,?,?,?,0,0,?)").run(id, "새 대화", at, at, identity);
      return this.conversation(id);
    });
  }

  list(limit: number, cursor?: string): { conversations: Conversation[]; next_cursor: string | null } {
    let before: { updated_at: number; id: string } | null = null;
    if (cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Number.isSafeInteger(parsed.updated_at) || typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/.test(parsed.id)) throw Error();
        before = parsed;
      } catch { throw new HistoryError(400, "invalid_cursor", "대화 목록 위치를 확인해 주세요."); }
    }
    const rows = (before
      ? this.db.prepare("SELECT id,title,created_at,updated_at,version,message_count FROM conversations WHERE updated_at < ? OR (updated_at = ? AND id < ?) ORDER BY updated_at DESC,id DESC LIMIT ?").all(before.updated_at, before.updated_at, before.id, limit + 1)
      : this.db.prepare("SELECT id,title,created_at,updated_at,version,message_count FROM conversations ORDER BY updated_at DESC,id DESC LIMIT ?").all(limit + 1)) as Conversation[];
    const conversations = rows.slice(0, limit);
    const last = conversations.at(-1);
    return { conversations, next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ updated_at: last.updated_at, id: last.id })).toString("base64url") : null };
  }

  read(id: string, limit: number, beforeSeq?: number): { conversation: Conversation; messages: SavedMessage[]; next_before_seq: number | null } {
    const conversation = this.conversation(id);
    const rows = (beforeSeq
      ? this.db.prepare("SELECT * FROM messages WHERE conversation_id=? AND seq < ? ORDER BY seq DESC LIMIT ?").all(id, beforeSeq, limit + 1)
      : this.db.prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT ?").all(id, limit + 1)) as Record<string, unknown>[];
    const page = rows.slice(0, limit);
    const messages = page.reverse().map((row) => this.publicMessage(row));
    return { conversation, messages, next_before_seq: rows.length > limit && messages.length ? messages[0].seq : null };
  }

  private publicMessage(row: Record<string, unknown>): SavedMessage {
    return { id: row.id as string, seq: row.seq as number, role: row.role as SavedMessage["role"], content: row.content as string,
      created_at: row.created_at as number, ...(row.author ? { author: row.author as string } : {}),
      ...(row.sources ? { sources: JSON.parse(row.sources as string) as unknown[] } : {}),
      ...(row.measurement_id ? { measurement_id: row.measurement_id as string } : {}), ...(row.update_id ? { update_id: row.update_id as string } : {}) };
  }

  context(id: string): { history: ChatInput["history"]; truncated: boolean } {
    const rows = this.db.prepare("SELECT role,content,update_id FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 13").all(id) as { role: "user" | "assistant"; content: string; update_id: string | null }[];
    let remaining = 24_000;
    const result: ChatInput["history"] = [];
    let truncated = rows.length > 12;
    for (const row of rows.slice(0, 12)) {
      if (remaining <= 0) break;
      let full = row.content;
      if (row.update_id) {
        const update = this.db.prepare("SELECT proposal FROM wiki_updates WHERE id=?").get(row.update_id) as { proposal: string } | undefined;
        if (update) {
          const proposal = JSON.parse(update.proposal) as { changes: { action: string; path: string; content?: string }[]; status: string };
          const changes = proposal.changes.map(({ action, path, content }) => ({ action, path, ...(content === undefined ? {} : { content }) }));
          full += `\n\n[제안한 문서 변경안. PR 상태: ${proposal.status}. 병합 여부는 별도 확인]\n${JSON.stringify(changes)}`;
        }
      }
      const content = full.slice(0, Math.min(6_000, remaining));
      if (content.length < full.length) truncated = true;
      result.push({ role: row.role, content }); remaining -= content.length;
    }
    if (result.length < Math.min(rows.length, 12)) truncated = true;
    return { history: result.reverse(), truncated };
  }

  reserve(id: string, version: number, requestId: string, identity: string, message: string, reasoning: string): { history: ChatInput["history"]; history_truncated: boolean; completed?: Record<string, unknown> } {
    const fingerprint = hashRequest(identity, { id, version, message, reasoning });
    return this.transaction(() => {
      const row = this.db.prepare("SELECT version,pending_request_id,pending_until FROM conversations WHERE id=?").get(id) as { version: number; pending_request_id: string | null; pending_until: number | null } | undefined;
      if (!row) throw notFound();
      if (row.pending_request_id && (row.pending_until ?? 0) <= this.now()) {
        this.db.prepare("DELETE FROM chat_requests WHERE request_id=? AND status='pending'").run(row.pending_request_id);
        this.db.prepare("UPDATE conversations SET pending_request_id=NULL,pending_until=NULL WHERE id=?").run(id);
        row.pending_request_id = null;
      }
      const prior = this.db.prepare("SELECT * FROM chat_requests WHERE request_id=?").get(requestId) as RequestRow | undefined;
      if (prior) {
        if (prior.identity !== identity || prior.fingerprint !== fingerprint || prior.conversation_id !== id) throw conflict();
        if (prior.status === "done" && prior.response) return { history: [], history_truncated: false, completed: JSON.parse(prior.response) };
        throw conflict();
      }
      if (row.version !== version || row.pending_request_id) throw conflict();
      const { history, truncated } = this.context(id);
      this.db.prepare("UPDATE conversations SET pending_request_id=?,pending_until=? WHERE id=?").run(requestId, this.now() + 4 * 60_000, id);
      this.db.prepare("INSERT INTO chat_requests VALUES(?,?,?,?,?,NULL)").run(requestId, id, identity, fingerprint, "pending");
      return { history, history_truncated: truncated };
    });
  }

  release(id: string, requestId: string) {
    this.transaction(() => {
      this.db.prepare("UPDATE conversations SET pending_request_id=NULL,pending_until=NULL WHERE id=? AND pending_request_id=?").run(id, requestId);
      this.db.prepare("DELETE FROM chat_requests WHERE request_id=? AND status='pending'").run(requestId);
    });
  }

  complete(id: string, requestId: string, identity: string, message: string, answer: string, sources: unknown[], measurementId: string | null, result: Record<string, unknown>): Record<string, unknown> {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT version,message_count,pending_request_id FROM conversations WHERE id=?").get(id) as { version: number; message_count: number; pending_request_id: string | null } | undefined;
      if (!row || row.pending_request_id !== requestId) throw conflict();
      const at = this.now(), seq = row.message_count;
      const user = { id: randomUUID(), seq: seq + 1, role: "user" as const, content: message, created_at: at, author: identity };
      const update = result.wiki_update as { id: string } | undefined;
      const assistant = { id: randomUUID(), seq: seq + 2, role: "assistant" as const, content: answer, created_at: at, sources,
        ...(update ? { wiki_update: update } : {}),
        ...(measurementId ? { measurement_id: measurementId } : {}) };
      this.db.prepare("INSERT INTO messages(id,conversation_id,seq,role,content,created_at,author,sources,measurement_id,update_id) VALUES(?,?,?,?,?,?,?,?,?,?)").run(user.id,id,user.seq,user.role,user.content,at,identity,null,null,null);
      this.db.prepare("INSERT INTO messages(id,conversation_id,seq,role,content,created_at,author,sources,measurement_id,update_id) VALUES(?,?,?,?,?,?,?,?,?,?)").run(assistant.id,id,assistant.seq,assistant.role,assistant.content,at,null,JSON.stringify(sources),measurementId,update?.id ?? null);
      this.db.prepare("UPDATE conversations SET title=CASE WHEN message_count=0 THEN ? ELSE title END,updated_at=?,version=version+1,message_count=message_count+2,pending_request_id=NULL,pending_until=NULL WHERE id=?")
        .run(message.slice(0, 80), at, id);
      const response = { ...result, conversation: this.conversation(id), messages: [user, { ...assistant, can_feedback: Boolean(measurementId) }] };
      this.db.prepare("UPDATE chat_requests SET status='done',response=? WHERE request_id=?").run(JSON.stringify(response), requestId);
      return response;
    });
  }
}
