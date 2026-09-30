import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hashContent } from "./sections.js";
import { UpdateError, type UpdateProposal } from "./wiki-update.js";

class GitHubFailure extends Error { constructor(readonly status: number) { super("GitHub request failed"); } }
type Options = { clientId?: string; privateKeyPath?: string; repository?: string; trackingIssue?: number; appSlug?: string; fetchImpl?: typeof fetch };
export class WikiGitHub {
  readonly repository: string;
  readonly clientId: string;
  readonly privateKeyPath: string;
  readonly trackingIssue: number;
  constructor(readonly options: Options = {}) {
    this.repository = options.repository ?? process.env.WIKI_GITHUB_REPOSITORY ?? "team-framework/framework-llm-wiki";
    this.clientId = options.clientId ?? process.env.WIKI_GITHUB_APP_CLIENT_ID ?? "";
    this.privateKeyPath = options.privateKeyPath ?? process.env.WIKI_GITHUB_APP_PRIVATE_KEY_PATH ?? "";
    this.trackingIssue = options.trackingIssue ?? Number(process.env.WIKI_TRACKING_ISSUE ?? 0);
    if (!/^[\w.-]+\/[\w.-]+$/.test(this.repository)) throw new Error("Invalid wiki repository.");
  }
  get configured() { return Boolean(this.clientId && this.privateKeyPath && Number.isSafeInteger(this.trackingIssue) && this.trackingIssue > 0); }
  private async request(token: string, endpoint: string, method = "GET", body?: unknown): Promise<any> {
    const response = await (this.options.fetchImpl ?? fetch)(`https://api.github.com${endpoint}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "framework-wiki-agent", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new GitHubFailure(response.status);
    return response.status === 204 ? null : response.json();
  }
  private async credentials() {
    if (!this.configured) throw new UpdateError(503, "update_unavailable", "Framework Bot의 문서 PR 연결을 준비하고 있습니다.");
    const key = await readFile(this.privateKeyPath, "utf8"), now = Math.floor(Date.now() / 1000);
    const head = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.clientId })).toString("base64url");
    const signer = createSign("RSA-SHA256"); signer.update(`${head}.${body}`); signer.end();
    const jwt = `${head}.${body}.${signer.sign(key, "base64url")}`;
    const app = await this.request(jwt, "/app");
    const expectedSlug = this.options.appSlug ?? process.env.WIKI_GITHUB_APP_SLUG ?? "framework-harness-sync";
    if (app.slug !== expectedSlug || !Number.isSafeInteger(app.id) || typeof app.slug !== "string" || !/^[a-z0-9-]+$/.test(app.slug)) {
      throw new UpdateError(503, "wrong_wiki_bot", "Framework Bot의 GitHub App 연결을 확인해 주세요.");
    }
    const installation = await this.request(jwt, `/repos/${this.repository}/installation`);
    const token = await this.request(jwt, `/app/installations/${installation.id}/access_tokens`, "POST", {
      repositories: [this.repository.split("/")[1]], permissions: { contents: "write", pull_requests: "write" }
    });
    const bot = await this.request(token.token, `/users/${app.slug}[bot]`);
    if (bot.type !== "Bot" || !Number.isSafeInteger(bot.id) || bot.login !== `${app.slug}[bot]`) throw new Error("Invalid bot identity");
    return { token: token.token as string, author: { name: bot.login, email: `${bot.id}+${bot.login}@users.noreply.github.com` } };
  }
  async publish(proposal: UpdateProposal): Promise<string> {
    try { return await this.publishWithCredentials(proposal); }
    catch (error) {
      if (error instanceof UpdateError) throw error;
      throw new UpdateError(502, "wiki_pr_failed", "PR 생성 결과를 확인하지 못했습니다. 같은 변경안에서 다시 시도해 주세요.");
    }
  }
  private async publishWithCredentials(proposal: UpdateProposal) {
    const { token, author } = await this.credentials();
    const request = (endpoint: string, method = "GET", body?: unknown) => this.request(token, endpoint, method, body);
    const repo = `/repos/${this.repository}`;
    const branch = `feat/wiki-agent-${proposal.id}/#${this.trackingIssue}`;
    const marker = `<!-- framework-wiki-agent:${proposal.id}:${hashContent(JSON.stringify(proposal.changes))} -->`;
    const file = async (filePath: string, ref: string): Promise<string | null> => {
      try {
        const result = await request(`${repo}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
        if (result.type !== "file" || result.encoding !== "base64") throw new Error("Invalid Markdown blob");
        return Buffer.from(result.content, "base64").toString("utf8");
      } catch (error) { if (error instanceof GitHubFailure && error.status === 404) return null; throw error; }
    };
    const verifyAfter = async (ref: string) => {
      for (const change of proposal.changes) {
        const content = await file(change.path, ref);
        if (change.action === "delete" ? content !== null : content !== change.content) throw new UpdateError(409, "update_branch_changed", "기존 PR 브랜치의 내용이 변경안과 다릅니다. 새 변경안을 만들어 주세요.");
      }
    };
    const pulls = await request(`${repo}/pulls?state=all&head=${encodeURIComponent(`${this.repository.split("/")[0]}:${branch}`)}&per_page=100`);
    const existing = pulls.find((pull: any) => pull.body?.includes(marker));
    if (existing) { await verifyAfter(existing.head.sha); return this.pullUrl(existing.html_url); }
    const metadata = await request(repo);
    const currentHead = async () => (await request(`${repo}/git/ref/heads/${encodeURIComponent(metadata.default_branch)}`)).object.sha as string;
    const verifyBefore = async (ref: string) => {
      for (const change of proposal.changes) {
        const content = await file(change.path, ref);
        if ((content === null ? null : hashContent(content)) !== change.before_hash) throw new UpdateError(409, "stale_update", "원본 문서가 바뀌었습니다. /업데이트로 변경안을 다시 만들어 주세요.");
      }
    };
    const sha = await currentHead();
    await verifyBefore(sha);
    let branchRef: any;
    try { branchRef = await request(`${repo}/git/ref/heads/${encodeURIComponent(branch)}`); }
    catch (error) { if (!(error instanceof GitHubFailure) || error.status !== 404) throw error; }
    if (!branchRef) {
      const parent = await request(`${repo}/git/commits/${sha}`);
      const tree = await request(`${repo}/git/trees`, "POST", { base_tree: parent.tree.sha,
        tree: proposal.changes.map((change) => ({ path: change.path, mode: "100644", type: "blob", ...(change.action === "delete" ? { sha: null } : { content: change.content }) })) });
      const commit = await request(`${repo}/git/commits`, "POST", { message: "feat: Wiki Agent 대화 내용을 문서에 반영", tree: tree.sha, parents: [sha], author, committer: author });
      try { branchRef = await request(`${repo}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: commit.sha }); }
      catch (error) { if (!(error instanceof GitHubFailure) || error.status !== 422) throw error; branchRef = await request(`${repo}/git/ref/heads/${encodeURIComponent(branch)}`); }
    }
    await verifyAfter(branchRef.object.sha);
    await verifyBefore(await currentHead());
    const created = await request(`${repo}/pulls`, "POST", {
      title: `feat: wiki-agent-${proposal.id}/#${this.trackingIssue}`, head: branch, base: metadata.default_branch, draft: true,
      body: `${proposal.summary}\n\n${proposal.changes.map((change) => `- ${change.action}: ${change.path}`).join("\n")}\n\n요청자: @${proposal.identity}\n출처: ${process.env.PUBLIC_BASE_URL ?? "https://framework-wiki.chaeyn.com"}/chat?conversation=${proposal.conversation_id}\n\n대화에서 제안한 변경입니다. 코드·운영 검증은 별도입니다.\nRefs #${this.trackingIssue}\n${marker}`
    });
    return this.pullUrl(created.html_url);
  }
  private pullUrl(value: unknown) {
    if (typeof value !== "string" || !value.startsWith(`https://github.com/${this.repository}/pull/`) || !/^\d+$/.test(value.split("/").at(-1)!)) throw new Error("Invalid PR URL");
    return value;
  }
}
