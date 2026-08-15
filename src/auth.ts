import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const cookieName = "framework_wiki_session";
const stateCookieName = "framework_wiki_oauth_state";
const oneHour = 60 * 60 * 1000;
const thirtyDays = 30 * 24 * oneHour;
const tenMinutes = 10 * 60 * 1000;

type Session = { login: string; expiresAt: number };
type GitHubMembership = { state: string; role: string };
type RegisteredClient = { redirectUris: string[]; issuedAt: number };
type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  resource?: string;
  scope?: string;
  expiresAt: number;
};
type AuthorizationCode = AuthorizationRequest & { login: string; type: "authorization_code" };
type AccessToken = { login: string; audience: string; scope?: string; expiresAt: number; type: "access_token" };
type RefreshToken = { login: string; audience: string; scope?: string; expiresAt: number; type: "refresh_token" };

export class GitHubAuth {
  readonly clientId = process.env.GITHUB_CLIENT_ID;
  readonly clientSecret = process.env.GITHUB_CLIENT_SECRET;
  readonly sessionSecret = process.env.SESSION_SECRET;
  readonly publicUrl = (process.env.PUBLIC_BASE_URL ?? "https://framework-wiki.chaeyn.com").replace(/\/$/, "");
  readonly organization = process.env.GITHUB_ORG ?? "team-framework";
  private readonly usedAuthorizationCodes = new Set<string>();

  get enabled() {
    return process.env.AUTH_MODE !== "disabled";
  }

  get resourceUrl() {
    return `${this.publicUrl}/mcp`;
  }

  get authorizationServerMetadataUrl() {
    return `${this.publicUrl}/.well-known/oauth-authorization-server`;
  }

  assertConfigured() {
    if (this.enabled && (!this.clientId || !this.clientSecret || !this.sessionSecret)) {
      throw new Error("GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and SESSION_SECRET are required when AUTH_MODE is enabled.");
    }
  }

  async authorize(request: FastifyRequest) {
    if (!this.enabled) return true;
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) return Boolean(this.verifyAccessToken(bearer));
    const session = this.readCookie(request, cookieName);
    const payload = session && this.verify<Session>(session);
    return Boolean(payload && payload.expiresAt > Date.now());
  }

  rejectResourceRequest(reply: FastifyReply) {
    reply.header("WWW-Authenticate", `Bearer resource_metadata="${this.publicUrl}/.well-known/oauth-protected-resource/mcp"`);
    return reply.code(401).send({ error: "Authentication required." });
  }

  protectedResourceMetadata() {
    return { resource: this.resourceUrl, authorization_servers: [this.publicUrl] };
  }

  authorizationServerMetadata() {
    return {
      issuer: this.publicUrl,
      authorization_endpoint: `${this.publicUrl}/oauth/authorize`,
      token_endpoint: `${this.publicUrl}/oauth/token`,
      registration_endpoint: `${this.publicUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"]
    };
  }

  registerClient(input: unknown) {
    const redirectUris = Array.isArray((input as { redirect_uris?: unknown })?.redirect_uris)
      ? (input as { redirect_uris: unknown[] }).redirect_uris.filter((value): value is string => typeof value === "string")
      : [];
    if (redirectUris.length === 0 || redirectUris.some((uri) => !isSafeRedirectUri(uri))) return null;
    return this.sign<RegisteredClient>({ redirectUris, issuedAt: Date.now() });
  }

  startAuthorization(request: FastifyRequest, reply: FastifyReply) {
    const query = request.query as Record<string, string | undefined>;
    const client = query.client_id && this.verify<RegisteredClient>(query.client_id);
    if (query.response_type !== "code" || !client || !query.redirect_uri || !client.redirectUris.includes(query.redirect_uri) || query.code_challenge_method !== "S256" || !query.code_challenge || !isSafeRedirectUri(query.redirect_uri)) {
      return reply.code(400).type("text/plain").send("Invalid OAuth authorization request.");
    }
    if (query.resource && query.resource !== this.resourceUrl) return reply.code(400).type("text/plain").send("Unknown OAuth resource.");
    const authorization = this.sign<AuthorizationRequest>({
      clientId: query.client_id!,
      redirectUri: query.redirect_uri!,
      codeChallenge: query.code_challenge,
      state: query.state,
      resource: query.resource,
      scope: query.scope,
      expiresAt: Date.now() + tenMinutes
    });
    return this.startGitHubLogin(reply, { kind: "oauth", authorization });
  }

  async exchangeToken(request: FastifyRequest, reply: FastifyReply) {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    if (body.grant_type === "authorization_code") {
      const code = body.code;
      const authorization = code && this.verify<AuthorizationCode>(code);
      if (!code || !authorization || authorization.type !== "authorization_code" || authorization.expiresAt < Date.now() || this.usedAuthorizationCodes.has(code) || body.client_id !== authorization.clientId || body.redirect_uri !== authorization.redirectUri || !body.code_verifier || !safeEqual(pkceChallenge(body.code_verifier), authorization.codeChallenge)) {
        return reply.code(400).send({ error: "invalid_grant", error_description: "Authorization code validation failed." });
      }
      this.usedAuthorizationCodes.add(code);
      return reply.send(this.issueTokens(authorization.login, authorization.resource ?? this.resourceUrl, authorization.scope));
    }
    if (body.grant_type === "refresh_token") {
      const refresh = body.refresh_token && this.verify<RefreshToken>(body.refresh_token);
      if (!refresh || refresh.type !== "refresh_token" || refresh.expiresAt < Date.now() || refresh.audience !== this.resourceUrl) {
        return reply.code(400).send({ error: "invalid_grant", error_description: "Refresh token validation failed." });
      }
      return reply.send(this.issueTokens(refresh.login, refresh.audience, refresh.scope));
    }
    return reply.code(400).send({ error: "unsupported_grant_type" });
  }

  startLogin(reply: FastifyReply) {
    return this.startGitHubLogin(reply, { kind: "web" });
  }

  async finishLogin(request: FastifyRequest, reply: FastifyReply) {
    const query = request.query as { code?: string; state?: string; error?: string };
    const stored = this.readCookie(request, stateCookieName);
    const state = stored && this.verify<{ state: string; flow: GitHubFlow; expiresAt: number }>(stored);
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
    if (state.flow.kind === "oauth") {
      const authorization = this.verify<AuthorizationRequest>(state.flow.authorization);
      if (!authorization || authorization.expiresAt < Date.now()) return reply.code(400).type("text/plain").send("OAuth authorization expired.");
      const code = this.sign<AuthorizationCode>({ ...authorization, login, type: "authorization_code" });
      const redirect = new URL(authorization.redirectUri);
      redirect.searchParams.set("code", code);
      if (authorization.state) redirect.searchParams.set("state", authorization.state);
      return reply.redirect(redirect.toString());
    }
    this.setCookie(reply, cookieName, this.sign({ login, expiresAt: Date.now() + oneHour }), 3600);
    return reply.redirect("/");
  }

  logout(reply: FastifyReply) {
    this.clearCookie(reply, cookieName);
    return reply.redirect("/");
  }

  private startGitHubLogin(reply: FastifyReply, flow: GitHubFlow) {
    const state = randomBytes(32).toString("base64url");
    this.setCookie(reply, stateCookieName, this.sign({ state, flow, expiresAt: Date.now() + tenMinutes }), 600);
    const query = new URLSearchParams({ client_id: this.clientId!, redirect_uri: `${this.publicUrl}/auth/github/callback`, state });
    return reply.redirect(`https://github.com/login/oauth/authorize?${query}`);
  }

  private issueTokens(login: string, audience: string, scope?: string) {
    const now = Date.now();
    return {
      access_token: this.sign<AccessToken>({ login, audience, scope, expiresAt: now + oneHour, type: "access_token" }),
      token_type: "Bearer",
      expires_in: oneHour / 1000,
      refresh_token: this.sign<RefreshToken>({ login, audience, scope, expiresAt: now + thirtyDays, type: "refresh_token" }),
      scope: scope ?? ""
    };
  }

  private verifyAccessToken(token: string) {
    const payload = this.verify<AccessToken>(token);
    return payload && payload.type === "access_token" && payload.expiresAt > Date.now() && payload.audience === this.resourceUrl ? payload : null;
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

  private sign<T extends object>(value: T) {
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

type GitHubFlow = { kind: "web" } | { kind: "oauth"; authorization: string };

function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function isSafeRedirectUri(value: string) {
  try {
    const uri = new URL(value);
    return uri.protocol === "https:" || (uri.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(uri.hostname));
  } catch {
    return false;
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
