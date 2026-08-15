import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";

const execFileAsync = promisify(execFile);

export type Note = {
  path: string;
  title: string;
  content: string;
  body: string;
  metadata: Record<string, unknown>;
  links: string[];
};

export type SearchOptions = {
  domain?: string;
  owner?: string;
  verification?: string;
  includeHistory?: boolean;
  limit?: number;
};

export class WikiService {
  constructor(readonly root: string) {}

  async listNotes(): Promise<Note[]> {
    const files = await this.markdownFiles(this.root);
    return Promise.all(files.map((file) => this.readFile(file)));
  }

  async search(query: string, options: SearchOptions = {}) {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const notes = await this.listNotes();
    return notes
      .filter((note) => options.includeHistory || !note.path.split("/").includes("사건기록"))
      .filter((note) => this.matches(note, options))
      .map((note) => ({ note, score: this.score(note, normalized, tokens) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.note.path.localeCompare(b.note.path, "ko"))
      .slice(0, options.limit ?? 10)
      .map(({ note, score }) => this.summary(note, score));
  }

  async getNote(relativePath: string): Promise<Note> {
    const normalized = relativePath.replace(/^\/+/, "");
    const fullPath = path.resolve(this.root, normalized);
    if (!fullPath.startsWith(`${path.resolve(this.root)}${path.sep}`) || path.extname(fullPath) !== ".md") {
      throw new Error("Invalid wiki note path.");
    }
    return this.readFile(fullPath);
  }

  async status() {
    let commit: string | null = null;
    try {
      const result = await execFileAsync("git", ["-C", this.root, "rev-parse", "HEAD"]);
      commit = result.stdout.trim();
    } catch {
      // A non-git directory remains valid for local development.
    }
    const notes = await this.listNotes();
    return { wiki_root: this.root, wiki_commit: commit, note_count: notes.length };
  }

  private async markdownFiles(directory: string): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === ".git" || entry.name === ".obsidian" ? [] : this.markdownFiles(full);
      return entry.isFile() && entry.name.endsWith(".md") ? [full] : [];
    }));
    return nested.flat();
  }

  private async readFile(fullPath: string): Promise<Note> {
    const content = await fs.readFile(fullPath, "utf8");
    const { metadata, body } = parseFrontmatter(content);
    const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.basename(fullPath, ".md");
    const relativePath = path.relative(this.root, fullPath).split(path.sep).join("/");
    const links = [...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((match) => match[1].trim());
    return { path: relativePath, title, content, body, metadata, links };
  }

  private matches(note: Note, options: SearchOptions) {
    return (!options.domain || includesMetadataValue(note.metadata.domain, options.domain))
      && (!options.owner || includesMetadataValue(note.metadata.owner, options.owner))
      && (!options.verification || note.metadata.verification === options.verification);
  }

  private score(note: Note, query: string, tokens: string[]) {
    const title = note.title.toLocaleLowerCase();
    const question = String(note.metadata.question ?? "").toLocaleLowerCase();
    const body = note.body.toLocaleLowerCase();
    const filePath = note.path.toLocaleLowerCase();
    let score = 0;
    if (title.includes(query)) score += 12;
    if (question.includes(query)) score += 10;
    if (filePath.includes(query)) score += 8;
    if (body.includes(query)) score += 4;
    for (const token of tokens) {
      if (title.includes(token)) score += 4;
      if (question.includes(token)) score += 3;
      if (filePath.includes(token)) score += 2;
      if (body.includes(token)) score += 1;
    }
    return score;
  }

  private summary(note: Note, score: number) {
    const text = note.body.replace(/^#.+$/m, "").replace(/\s+/g, " ").trim();
    return {
      path: note.path,
      title: note.title,
      question: note.metadata.question ?? null,
      domain: note.metadata.domain ?? null,
      owner: note.metadata.owner ?? null,
      verification: note.metadata.verification ?? null,
      last_verified: note.metadata.last_verified ?? null,
      score,
      excerpt: text.slice(0, 280)
    };
  }
}

function includesMetadataValue(value: unknown, expected: string) {
  return Array.isArray(value) ? value.includes(expected) : value === expected;
}

function parseFrontmatter(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { metadata: {}, body: content };
  const parsed = YAML.parse(match[1]);
  return { metadata: parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}, body: match[2] };
}
