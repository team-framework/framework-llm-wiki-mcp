import { verify } from "node:crypto";

export function githubFixture(publicKey: string, initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const commits = new Map<string, Map<string, string>>([["base", new Map(files)]]);
  const refs = new Map<string, string>([["main", "base"]]);
  const pulls: any[] = [], calls: { endpoint: string; method: string; body: any }[] = [];
  let tree: Map<string, string>;
  let lostResponse = false;
  const fetchImpl: typeof fetch = async (url, init) => {
    const endpoint = new URL(String(url)).pathname;
    const method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ endpoint, method, body });
    const headers = new Headers(init?.headers), token = headers.get("Authorization")?.replace(/^Bearer /, "");
    if (["/app", "/repos/team-framework/framework-llm-wiki/installation", "/app/installations/1/access_tokens"].includes(endpoint)) {
      const [head, payload, signature] = token!.split(".");
      if (!verify("RSA-SHA256", Buffer.from(`${head}.${payload}`), publicKey, Buffer.from(signature, "base64url"))) throw new Error("Invalid app JWT");
    } else if (token !== "installation-token") throw new Error("Personal credentials are forbidden");
    if (endpoint === "/app") return Response.json({ name: "Framework Bot", slug: "framework-harness-sync", id: 1 });
    if (endpoint.endsWith("/installation")) return Response.json({ id: 1 });
    if (endpoint.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
    if (endpoint.endsWith("[bot]")) return Response.json({ type: "Bot", id: 42, login: "framework-harness-sync[bot]" });
    if (endpoint === "/repos/team-framework/framework-llm-wiki") return Response.json({ default_branch: "main" });
    if (endpoint.endsWith("/pulls")) {
      if (method === "GET") return Response.json(pulls);
      const pull = { ...body, head: { sha: refs.get(body.head) }, html_url: `https://github.com/team-framework/framework-llm-wiki/pull/${pulls.length + 1}` };
      pulls.push(pull);
      if (lostResponse) { lostResponse = false; throw new Error("Response lost after PR creation"); }
      return Response.json(pull);
    }
    if (endpoint.includes("/contents/")) {
      const target = decodeURIComponent(endpoint.split("/contents/")[1]), ref = new URL(String(url)).searchParams.get("ref")!;
      const content = commits.get(ref)?.get(target);
      return content === undefined ? new Response("", { status: 404 }) : Response.json({ type: "file", encoding: "base64", content: Buffer.from(content).toString("base64") });
    }
    if (endpoint.includes("/git/ref/heads/")) {
      const sha = refs.get(decodeURIComponent(endpoint.split("/git/ref/heads/")[1]));
      return sha ? Response.json({ object: { sha } }) : new Response("", { status: 404 });
    }
    if (endpoint.endsWith("/git/trees") && method === "POST") {
      tree = new Map(commits.get("base")!);
      for (const change of body.tree) { if (change.sha === null) tree.delete(change.path); else tree.set(change.path, change.content); }
      return Response.json({ sha: "updated-tree" });
    }
    if (endpoint.endsWith("/git/commits") && method === "POST") { commits.set("new-commit", tree!); return Response.json({ sha: "new-commit" }); }
    if (endpoint.includes("/git/commits/")) return Response.json({ tree: { sha: "base-tree" } });
    if (endpoint.endsWith("/git/refs") && method === "POST") { refs.set(body.ref.replace("refs/heads/", ""), body.sha); return Response.json({ object: { sha: body.sha } }); }
    throw new Error(`Unexpected endpoint: ${method} ${endpoint}`);
  };
  return { fetchImpl, files, commits, refs, pulls, calls, loseNextPrResponse: () => { lostResponse = true; }, changeBase: (filePath: string, content: string) => { commits.get("base")!.set(filePath, content); } };
}
