# Framework LLM Wiki MCP

`framework-llm-wiki` 정본을 읽기 전용으로 검색하는 MCP 서버입니다.

- 문서 수정은 정본 위키 저장소에서 PR로 합니다.

## 연결

사람은 [framework-wiki.chaeyn.com](https://framework-wiki.chaeyn.com)에 접속해 GitHub로 로그인합니다. `team-framework`의 활성 Member 또는 admin만 볼 수 있습니다.

에이전트는 환경 변수나 개인 액세스 토큰 없이 한 번만 브라우저에서 GitHub 로그인을 승인합니다.

```bash
# Codex
codex mcp add framework-wiki --url https://framework-wiki.chaeyn.com/mcp
codex mcp login framework-wiki

# Claude Code
claude mcp add --transport http framework-wiki https://framework-wiki.chaeyn.com/mcp
claude mcp login framework-wiki
```

연결을 해제하려면 `codex mcp logout framework-wiki` 또는 `claude mcp logout framework-wiki`를 실행합니다.

## 로컬 실행

```bash
npm install
WIKI_ROOT=/path/to/framework-llm-wiki
npm run dev
```
