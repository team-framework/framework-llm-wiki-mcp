# Framework LLM Wiki web

Next.js 16 and Fumadocs render Markdown returned by the authenticated wiki API. The app fetches the page tree and note body at request time; it does not copy wiki documents into the frontend build.

## Local development

```bash
cd web
npm ci
cp .env.example .env.local
npm run dev
```

Set `WIKI_API_URL` to the Fastify service base URL. It defaults to `http://127.0.0.1:3100` for local development. Next.js development mode proxies browser `/api/*` and `/auth/*` requests there, so the frontend and API share one browser origin. In Compose, use the API service name and port, such as `http://wiki-api:3100`.

Run `npm run check` for TypeScript validation and `npm run build` for the production build. The Docker image uses Next.js standalone output and listens on port 3000.

## API and authentication

The browser calls same-origin `/api/search` and `/api/chat`. The server-rendered docs layout and note route call `GET /api/tree` and `GET /api/note?path=...` on `WIKI_API_URL`. They forward the incoming `Cookie` and `Authorization` headers so Fastify can validate its existing GitHub session or bearer token. The app does not forward identity headers such as `X-User` and does not add an authentication bypass.

Keep the public app and API on the same origin. The reverse proxy should send `/docs`, `/_next/*`, and the root redirect to this app; keep `/api/*`, `/auth/*`, `/oauth/*`, `/.well-known/*`, and `/mcp` on Fastify. Preserve the browser's cookie and authorization headers between the proxy and each service.

The docs routes use no-store fetches and dynamic rendering. Note paths map to `/docs/<each encoded path segment>`; for example, `기술/실시간 처리.md` maps to `/docs/%EA%B8%B0%EC%88%A0/%EC%8B%A4%EC%8B%9C%EA%B0%84%20%EC%B2%98%EB%A6%AC.md`. `/docs/bot-guide` is a dedicated guide route and does not require a Markdown file.

## Wiki and Agent UI

The docs sidebar is built from `GET /api/tree`. Search displays results from `/api/search?q=...` and labels the index as semantic and keyword search. Markdown renders GitHub Flavored Markdown without enabling raw HTML; `[[wikilinks]]` become links only when the API resolves them to a unique note.

The Agent panel posts the current question, prior chat turns, and a selectable reasoning level to `/api/chat`. It starts at `low`, displays source links from the response, and links unauthenticated users to `/auth/github/login`. The Bot guide is available from the docs navigation at `/docs/bot-guide`.
