# Framework LLM Wiki MCP

`framework-llm-wiki` 정본을 읽기 전용으로 검색하는 MCP 서버입니다.

- 문서 수정은 정본 위키 저장소에서 PR로 합니다.
- 웹 Wiki Agent에서 `/업데이트`로 문서 생성·수정·삭제 변경안을 확인하고 Framework Bot의 Draft PR을 열 수 있습니다.

[이번 개선 작업 안내](docs/implementation-overview.md)에서 위키 UI, Discord Bot, 사용 현황, 토큰 절약 방법과 측정 결과를 읽을 수 있습니다.

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

## Plugin

[Framework LLM Wiki Plugin](plugins/framework-llm-wiki/README.md)은 기존 MCP를 연결하고 질문에 필요한 섹션 조회, 현행 수치 확인, 문서 변경안 작성 스킬을 제공합니다. 출처와 변경안 검토는 기존 Wiki Web으로 연결합니다.

```bash
python3 scripts/package-plugin.py --output /tmp/framework-llm-wiki-0.1.0.zip
```

생성한 ZIP을 Plugin Creator로 계정에 저장하고 설치할 수 있습니다. 팀 GitHub OAuth 연결은 호스트의 연결 화면에서 진행합니다.

## 로컬 실행

```bash
npm install
WIKI_ROOT=/path/to/framework-llm-wiki
npm run dev
```
