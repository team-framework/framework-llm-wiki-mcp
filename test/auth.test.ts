import assert from "node:assert/strict";
import test from "node:test";
import { GitHubAuth } from "../src/auth.js";

function createAuth() {
  process.env.AUTH_MODE = "enabled";
  process.env.GITHUB_CLIENT_ID = "test-client";
  process.env.GITHUB_CLIENT_SECRET = "test-secret";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.PUBLIC_BASE_URL = "https://framework-wiki.example.com";
  return new GitHubAuth();
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
