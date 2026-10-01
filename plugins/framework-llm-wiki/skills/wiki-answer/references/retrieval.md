# 조회와 연결

## 기존 MCP 도구

| 도구 | 용도 | 주요 입력 |
| --- | --- | --- |
| `get_context` | 관련 섹션의 원문과 검증 정보 | `query`, `limit`, `max_chars`, 검색 필터 |
| `get_sources_context` | Git 위키와 Notion의 근거를 함께 조회 | `query`, `sources`, `limit`, `max_chars`, 검색 필터 |
| `search_notion` | 허용된 페이지의 제목 검색 | `query`, `limit` |
| `read_notion_page` | Notion Markdown 원문과 이어 읽기 | `id`, `max_chars`, `start_block`, `expected_hash`, `subtree_id` |
| `search_wiki` | 후보 문서와 일치 섹션 찾기 | `query`, `limit`, 검색 필터 |
| `get_note_outline` | 본문 없이 제목·줄 번호·hash 확인 | `path` |
| `read_sections` | 선택 섹션과 이어 읽기 | `refs`, `max_chars`, `cursor` |
| `read_note` | 전체 Markdown과 연결 문서 확인 | `path` |
| `get_current_metrics` | `_현행_수치.md` 읽기 | 없음 |
| `get_wiki_status` | 서버가 읽는 위키 commit과 문서 수 | 없음 |

검색 필터는 `domain`, `owner`, `verification`, `include_history`다. `limit`은 1~50, `max_chars`는 1~128000이다. `max_chars`는 JSON 근거의 문자 수를 제한하며 토큰 수나 전체 응답 길이의 상한을 뜻하지 않는다. MCP가 반환한 text JSON을 구조로 읽는다.

## 이어 읽기

Notion 원문에서 `content_truncated: true`이면 `next_block`을 `start_block`으로, 반환된 `content_hash`를 `expected_hash`로 전달한다. 큰 블록은 `required_chars`에 맞춰 예산을 높인다. `unknown_block_ids`의 구간은 같은 페이지 ID에 `subtree_id`를 지정해 별도로 읽는다. 해당 구간을 읽지 못하면 전체 문서를 읽었다고 쓰지 않는다. 통합 context는 cursor를 지원하지 않으므로 필요한 문서를 `read_notion_page` 또는 Git 섹션 도구로 읽는다.

`truncated: true`와 `next_cursor`가 있으면 질문에 필요한 남은 근거를 `read_sections({refs: [], cursor: next_cursor, max_chars: 6000})`으로 이어 읽는다. cursor를 수정하지 않는다. 같은 cursor가 반복되거나 새 근거가 없으면 중단하고 빈 범위를 밝힌다.

표나 fenced code가 예산보다 크면 `required_chars`를 확인해 예산을 높인다. 상한보다 큰 블록은 현재 도구로 읽을 수 없는 범위로 표시하고 원문 링크를 제공한다. 일부만 읽은 표를 완전한 결과로 제시하지 않는다. stale hash 오류는 outline을 새로 읽고 새 hash로 재시도한다.

`retrieval.mode`와 `semantic_status`가 fallback을 나타내면 실제 검색 방식을 기준으로 설명한다. 벡터 검색을 사용했다고 추정하지 않는다. 연결된 호스트가 예전 4개 도구만 제공하면 `search_wiki` → `read_note`로 필요한 문서만 읽고, 섹션 조회를 사용할 수 없다고 밝힌다.

## Wiki Web 링크

- 문서 목록: https://framework-wiki.chaeyn.com/docs
- Wiki Agent: https://framework-wiki.chaeyn.com/chat
- 사용법: https://framework-wiki.chaeyn.com/docs/bot-guide
- MCP: https://framework-wiki.chaeyn.com/mcp

문서 URL은 반환된 `path`를 `/`로 나눈 뒤 각 구간에 `encodeURIComponent`를 적용해 `/`로 다시 합치고 `https://framework-wiki.chaeyn.com/docs/` 뒤에 붙인다. `.md` 확장자를 보존한다. 전체 경로의 `/`까지 인코딩하지 않는다. MCP의 `section_id`는 웹 heading anchor와 다를 수 있으므로 URL fragment로 붙이지 않는다.

예: `기획/InnoLive 차별점.md` → `https://framework-wiki.chaeyn.com/docs/%EA%B8%B0%ED%9A%8D/InnoLive%20%EC%B0%A8%EB%B3%84%EC%A0%90.md`.

정확한 문서 경로만 사용하고 absolute path, `..`, 임의 URL을 문서 링크로 변환하지 않는다. Wiki Web은 기존 GitHub 팀 로그인을 사용한다. 웹 세션과 MCP OAuth 연결은 별개이므로 각 호스트의 연결 흐름을 따른다. 연결 오류가 나면 호스트의 연결 화면을 안내하고 사용자에게 비밀번호나 토큰을 대화에 붙여 넣도록 요구하지 않는다.
