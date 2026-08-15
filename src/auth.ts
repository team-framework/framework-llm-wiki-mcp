import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const cookieName = "framework_wiki_session";
const stateCookieName = "framework_wiki_oauth_state";
const oneHour = 60 * 60 * 1000;

type Session = { login: string; expiresAt: number };
type GitHubMembership = { state: string; role: string };

export class GitHubAuth {
  readonly clientId = process.env.GITHUB_CLIENT_ID;
  readonly clientSecret = process.env.GITHUB_CLIENT_SECRET;
  readonly sessionSecret = process.env.SESSION_SECRET;
  readonly publicUrl = (process.env.PUBLIC_BASE_URL ?? "https://framework-wiki.chaeyn.com").replace(/\/$/, "");
  readonly organization = process.env.GITHUB_ORG ?? "team-framework";

  get enabled() {
    return process.env.AUTH_MODE !== "disabled";
  }

  assertConfigured() {
    if (this.enabled && (!this.clientId || !this.clientSecret || !this.sessionSecret)) {
      throw new Error("GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and SESSION_SECRET are required when AUTH_MODE is enabled.");
    }
  }

  async authorize(request: FastifyRequest, reply: FastifyReply) {
    if (!this.enabled) return true;
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) return this.verifyGitHubToken(bearer);
    const session = this.readCookie(request, cookieName);
    const payload = session && this.verify<Session>(session);
    return Boolean(payload && payload.expiresAt > Date.now());
  }

  startLogin(reply: FastifyReply) {
    const state = randomBytes(32).toString("base64url");
    this.setCookie(reply, stateCookieName, this.sign({ state, expiresAt: Date.now() + 10 * 60 * 1000 }), 600);
    const query = new URLSearchParams({
      client_id: this.clientId!,
      redirect_uri: `${this.publicUrl}/auth/github/callback`,
      state
    });
    return reply.redirect(`https://github.com/login/oauth/authorize?${query}`);
  }

  async finishLogin(request: FastifyRequest, reply: FastifyReply) {
    const query = request.query as { code?: string; state?: string; error?: string };
    const stored = this.readCookie(request, stateCookieName);
    const state = stored && this.verify<{ state: string; expiresAt: number }>(stored);
    this.clearCookie(reply, stateCookieName);
    if (query.error || !query.code || !query.state || !state || state.expiresAt < Date.now() || !safeEqual(query.state, state.state)) {
      return reply.code(401).type("text/plain").send("GitHub login could not be verified.");
    }
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId!, client_secret: this.clientSecret!, code: query.code, redirect_uri: `${this.publicUrl}/auth/github/callback` })
    });
    const token = await tokenResponse.json() as { access_token?: string };
    if (!tokenResponse.ok || !token.access_token) return reply.code(401).type("text/plain").send("GitHub token exchange failed.");
    const login = await this.verifyGitHubToken(token.access_token);
    if (!login) return reply.code(403).type("text/plain").send(`Only active ${this.organization} members may access this wiki.`);
    this.setCookie(reply, cookieName, this.sign({ login, expiresAt: Date.now() + oneHour }), 3600);
    return reply.redirect("/");
  }

  logout(reply: FastifyReply) {
    this.clearCookie(reply, cookieName);
    return reply.redirect("/");
  }

  private async verifyGitHubToken(token: string): Promise<string | null> {
    const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
    const [userResponse, membershipResponse] = await Promise.all([
      fetch("https://api.github.com/user", { headers }),
      fetch(`https://api.github.com/user/memberships/orgs/${this.organization}`, { headers })
    ]);
    if (!userResponse.ok || !membershipResponse.ok) return null;
    const user = await userResponse.json() as { login?: string };
    const membership = await membershipResponse.json() as GitHubMembership;
    return user.login && membership.state === "active" && ["member", "admin"].includes(membership.role) ? user.login : null;
  }

  private sign(value: object) {
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }

  private verify<T>(value: string): T | null {
    const [body, signature] = value.split(".");
    if (!body || !signature || !safeEqual(signature, this.mac(body))) return null;
    try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T; } catch { return null; }
  }

  private mac(value: string) {
    return createHmac("sha256", this.sessionSecret!).update(value).digest("base64url");
  }

  private readCookie(request: FastifyRequest, name: string) {
    const entry = request.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
    return entry?.slice(name.length + 1);
  }

  private setCookie(reply: FastifyReply, name: string, value: string, seconds: number) {
    reply.header("Set-Cookie", `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`);
  }

  private clearCookie(reply: FastifyReply, name: string) {
    reply.header("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
