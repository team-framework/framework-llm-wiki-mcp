import assert from "node:assert/strict";
import test from "node:test";
import { GitHubAuth } from "../src/auth.js";

function createAuth(now?: () => number) {
  process.env.AUTH_MODE = "enabled";
  process.env.GITHUB_CLIENT_ID = "test-client";
  process.env.GITHUB_CLIENT_SECRET = "test-secret";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.PUBLIC_BASE_URL = "https://framework-wiki.example.com";
  return new GitHubAuth(now);
}

test("publishes MCP OAuth metadata", () => {
  const auth = createAuth();
  assert.deepEqual(auth.protectedResourceMetadata(), {
    resource: "https://framework-wiki.example.com/mcp",
    authorization_servers: ["https://framework-wiki.example.com"]
  });
  assert.equal(auth.authorizationServerMetadata().registration_endpoint, "https://framework-wiki.example.com/oauth/register");
  assert.deepEqual(auth.authorizationServerMetadata().code_challenge_methods_supported, ["S256"]);
});

test("registers only HTTPS and local callback clients", () => {
  const auth = createAuth();
  assert.ok(auth.registerClient({ redirect_uris: ["https://app.example.com/callback"] }));
  assert.ok(auth.registerClient({ redirect_uris: ["http://localhost:3333/callback"] }));
  assert.equal(auth.registerClient({ redirect_uris: ["http://app.example.com/callback"] }), null);
  assert.equal(auth.registerClient({ redirect_uris: [] }), null);
});

test("accepts only self-issued access tokens for the MCP resource", async () => {
  const auth = createAuth();
  const issueTokens = (auth as unknown as { issueTokens(login: string, audience: string): { access_token: string } }).issueTokens.bind(auth);
  const valid = issueTokens("chaeyn", auth.resourceUrl).access_token;
  const wrongAudience = issueTokens("chaeyn", "https://other.example.com/mcp").access_token;
  const request = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as never;
  assert.equal(await auth.authorize(request(valid)), true);
  assert.equal(await auth.authorize(request(wrongAudience)), false);
  assert.equal(await auth.authorize(request("github-user-token")), false);
});


test("service credentials authorize only scoped read APIs", () => {
  const auth = createAuth();
  process.env.WIKI_SERVICE_KEY = "test-service-key-with-at-least-32-chars";
  const request = (method: string, url: string, key = process.env.WIKI_SERVICE_KEY) => ({ method, url, headers: { authorization: `Bearer ${key}` } }) as never;
  assert.equal(auth.authorizeServiceRead(request("GET", "/api/context?q=question")), true);
  assert.equal(auth.authorizeServiceRead(request("GET", "/api/note?path=a.md")), true);
  assert.equal(auth.authorizeServiceRead(request("POST", "/api/chat")), false);
  assert.equal(auth.authorizeServiceRead(request("POST", "/mcp")), false);
  assert.equal(auth.authorizeServiceRead(request("GET", "/docs/private")), false);
  assert.equal(auth.authorizeServiceRead(request("GET", "/api/note", "wrong")), false);
  delete process.env.WIKI_SERVICE_KEY;
});

const hour = 3_600_000;
const day = 24 * hour;
function tokenBody(token: string) { return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")); }
async function exchange(auth: GitHubAuth, body: Record<string, string>) {
  let status = 200; let payload: any;
  const reply: any = { code(value: number) { status = value; return this; }, send(value: any) { payload = value; return this; } };
  await auth.exchangeToken({ body } as never, reply);
  return { status, payload };
}

test("refresh rotations keep the first login deadline and clip the last access token to 24 hours", async () => {
  const initial = Date.parse("2026-09-29T00:00:00Z"); let now = initial;
  const auth = createAuth(() => now); const issued = (auth as any).issueTokens("member", auth.resourceUrl);
  const first = tokenBody(issued.refresh_token); assert.equal(first.reauthenticateAt, initial + day); assert.equal(first.expiresAt, initial + day); assert.equal(issued.expires_in, 3600);
  now += 6 * hour;
  const rotated = await exchange(auth, { grant_type: "refresh_token", refresh_token: issued.refresh_token });
  assert.equal(rotated.status, 200); assert.equal(tokenBody(rotated.payload.refresh_token).reauthenticateAt, first.reauthenticateAt);
  now = initial + day - hour / 2;
  const last = await exchange(auth, { grant_type: "refresh_token", refresh_token: rotated.payload.refresh_token });
  assert.equal(last.status, 200); assert.equal(last.payload.expires_in, 1800); assert.equal(tokenBody(last.payload.access_token).expiresAt, initial + day);
  now = initial + day;
  assert.equal(await auth.authorize({ headers: { authorization: `Bearer ${last.payload.access_token}` } } as never), false);
  const expired = await exchange(auth, { grant_type: "refresh_token", refresh_token: last.payload.refresh_token });
  assert.equal(expired.status, 400); assert.equal(expired.payload.error, "invalid_grant"); assert.equal(expired.payload.access_token, undefined);
});

test("legacy, overlong and wrong audience refresh tokens require a new GitHub login", async () => {
  const now = Date.parse("2026-09-29T00:00:00Z"); const auth = createAuth(() => now);
  const base = { login: "member", audience: auth.resourceUrl, expiresAt: now + day, type: "refresh_token" };
  for (const value of [base, { ...base, expiresAt: now + 30 * day, reauthenticateAt: now + 30 * day }, { ...base, reauthenticateAt: now + day, audience: "https://other.example/mcp" }]) {
    const result = await exchange(auth, { grant_type: "refresh_token", refresh_token: (auth as any).sign(value) });
    assert.equal(result.status, 400); assert.equal(result.payload.error, "invalid_grant"); assert.match(result.payload.error_description, /fresh GitHub login/);
  }
});

test("OAuth login fixes the deadline at GitHub verification and a later login rejects inactive membership", async () => {
  const initial = Date.parse("2026-09-29T00:00:00Z"); let now = initial; let active = true; let membershipChecks = 0;
  const auth = createAuth(() => now); const { createHash } = await import("node:crypto"); const verifier = "test-proof-key";
  const authorization = { clientId: "registered-client", redirectUri: "https://client.example/callback", codeChallenge: createHash("sha256").update(verifier).digest("base64url"), resource: auth.resourceUrl, expiresAt: initial + 10 * 60_000 };
  const request = () => ({ query: { code: "synthetic-github-code", state: "csrf-state" }, headers: { cookie: `framework_wiki_oauth_state=${(auth as any).sign({ state: "csrf-state", flow: { kind: "oauth", authorization: (auth as any).sign(authorization) }, expiresAt: now + 10 * 60_000 })}` } }) as never;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("login/oauth/access_token")) return Response.json({ access_token: "synthetic-github-token" });
    if (String(url).includes("memberships/orgs")) { membershipChecks++; return Response.json({ state: active ? "active" : "inactive", role: "member" }); }
    return Response.json({ login: "member" });
  };
  try {
    let status = 200; let redirect = "";
    const reply: any = { header() { return this; }, code(value: number) { status = value; return this; }, type() { return this; }, send() { return this; }, redirect(value: string) { redirect = value; return this; } };
    await auth.finishLogin(request(), reply); const code = new URL(redirect).searchParams.get("code")!;
    assert.equal(tokenBody(code).reauthenticateAt, initial + day); now += 2 * 60_000;
    const result = await exchange(auth, { grant_type: "authorization_code", code, client_id: authorization.clientId, redirect_uri: authorization.redirectUri, code_verifier: verifier });
    assert.equal(result.status, 200); assert.equal(tokenBody(result.payload.refresh_token).reauthenticateAt, initial + day);
    active = false; now = initial + day; await auth.finishLogin(request(), reply); assert.equal(status, 403); assert.equal(membershipChecks, 2);
  } finally { globalThis.fetch = original; }
});

test("browser login retains its existing one hour cookie limit", async () => {
  const initial = Date.parse("2026-09-29T00:00:00Z"); let now = initial; const auth = createAuth(() => now);
  const original = globalThis.fetch; globalThis.fetch = async (url) => String(url).includes("login/oauth/access_token") ? Response.json({ access_token: "synthetic-token" }) : String(url).includes("memberships/orgs") ? Response.json({ state: "active", role: "member" }) : Response.json({ login: "member" });
  try {
    const state = (auth as any).sign({ state: "csrf-state", flow: { kind: "web" }, expiresAt: now + 10 * 60_000 }); let cookie = "";
    const reply: any = { header(_key: string, value: string) { cookie = value; return this; }, redirect() { return this; } };
    await auth.finishLogin({ query: { code: "code", state: "csrf-state" }, headers: { cookie: `framework_wiki_oauth_state=${state}` } } as never, reply);
    assert.match(cookie, /Max-Age=3600/); const header = cookie.split(";", 1)[0];
    now = initial + hour - 1; assert.equal(auth.identity({ headers: { cookie: header } } as never), "member");
    now++; assert.equal(auth.identity({ headers: { cookie: header } } as never), null);
  } finally { globalThis.fetch = original; }
});

test("refresh and authorization artifacts cannot bypass re-login by being used as browser cookies", () => {
  const now = Date.parse("2026-09-29T00:00:00Z"); const auth = createAuth(() => now);
  const signed = (value: object) => (auth as any).sign(value);
  const cookieRequest = (token: string) => ({ headers: { cookie: `framework_wiki_session=${token}` } }) as never;
  const legacyRefresh = signed({ login: "member", audience: auth.resourceUrl, expiresAt: now + 30 * day, type: "refresh_token" });
  const freshRefresh = (auth as any).issueTokens("member", auth.resourceUrl).refresh_token;
  const nearExpiryRefresh = signed({ login: "member", audience: auth.resourceUrl, expiresAt: now + 30_000, reauthenticateAt: now + 30_000, type: "refresh_token" });
  const authorizationCode = signed({ login: "member", expiresAt: now + 30_000, type: "authorization_code" });
  for (const token of [legacyRefresh, freshRefresh, nearExpiryRefresh, authorizationCode]) assert.equal(auth.identity(cookieRequest(token)), null);
  assert.equal(auth.identity(cookieRequest(signed({ login: "member", expiresAt: now + hour }))), "member");
  assert.equal(auth.identity(cookieRequest(signed({ login: "member", expiresAt: now + 30 * day }))), null);
});
