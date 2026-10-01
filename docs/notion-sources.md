# Notion 원문 연결

Framework 상위 페이지 `30cba097c65980b5bddbfd0a67de936a`와 그 하위 문서를 읽는다. 노션 원문은 Notion에 남고 Git 위키 문서는 기존 PR 절차로 수정한다.

## 서버 연결

1. Framework 워크스페이스에 팀용 Internal connection을 만들고 `Read content`만 활성화한다.
2. Framework 상위 페이지를 이 연결에 공유한다. 연결이 읽을 수 있는 문서는 팀 GitHub 로그인 사용자와 인증된 Discord 서비스에서 조회할 수 있다.
3. 서버에서 토큰을 숨긴 입력으로 등록한다. 토큰을 채팅, 명령 인자, Git에 넣지 않는다.

```sh
python3 deploy/configure-notion.py --env .env
```

기존 배포 설정에 `NOTION_TOKEN`, `NOTION_ROOT_PAGE_IDS`를 저장한다. 서비스는 별도 배포 때 설정을 읽는다. Docker Compose가 Notion 토큰을 Wiki 서비스에만 전달한다. Hermes와 Discord 봇에는 Notion 토큰을 전달하지 않는다.

## 읽기 도구

| 도구 | 용도 |
| --- | --- |
| `search_notion` | 접근 범위 안의 페이지 제목 검색 |
| `read_notion_page` | ID 또는 URL로 원문 조회 |
| `get_sources_context` | 위키와 노션의 관련 원문 구간 조회 |

원문 조회는 [Notion Markdown API](https://developers.notion.com/reference/retrieve-page-markdown), API 버전 `2026-03-11`을 사용한다. ID를 추출한 뒤 고정된 Notion API로 요청한다. 입력 URL의 웹페이지를 직접 요청하지 않는다.

원문 결과에는 URL, 수정 시각, 조회 시각, 해시, 누락 여부가 있다. 조회 성공은 문서 내용의 사실 검증을 뜻하지 않는다. 권한과 상위 페이지 경로는 캐시를 사용하더라도 재확인한다.

`content_truncated`이면 `start_block=next_block`, `expected_hash=content_hash`로 이어 읽는다. 긴 표와 코드를 자르지 않으며 필요한 `required_chars`를 반환한다. 원문이 바뀌면 `notion_stale_cursor`를 반환하므로 첫 구간부터 다시 읽는다.

`unknown_block_ids`는 추가 조회 후보다. `subtree_id`에 후보 하나를 넘겨 구간을 별도로 읽는다. 권한과 상위 페이지 경로를 다시 확인한다. 원문 순서를 바꾸지 않도록 추가 구간을 원문 끝에 붙이지 않는다. 지원하지 않는 임베드 등은 `<unknown>`으로 남을 수 있다.

## 본문 검색

설정된 연결이 있으면 시작 시와 기본 10분 간격으로 페이지를 수집한다. 기본 수집 상한은 100개이며 `NOTION_INDEX_MAX_PAGES`로 조절한다. `/api/status`의 `notion.index.truncated`로 수집 상한 도달 여부를 확인한다. 갱신 중에는 이전 수집 결과를 검색 후보로 사용하고, 답변에 넣기 전에 원문 접근 권한과 변경 내용을 다시 읽는다. 삭제되거나 접근 권한을 잃은 후보는 제외한다.

본문 키워드 검색과 별도 `framework_notion` Qdrant 인덱스를 사용한다. Vector 서비스가 없으면 키워드 검색을 사용한다. 인덱스가 준비되지 않았을 때는 제목 검색을 사용하고 `notion_title_search_only`를 반환한다. 토큰이 없으면 기존 위키 조회와 답변 경로를 사용한다.

## 웹과 Discord

웹 챗봇은 붙여 넣은 Notion URL을 우선 조회한다. 일반 질문은 위키와 노션 본문에서 후보를 찾는다. 인용 링크는 Notion 원문으로 연결되며 `Notion` 표시를 붙인다. `/업데이트`에 노션 링크를 전달하면 참고 근거로 읽고 Git 위키 문서 변경안을 만든다.

인증된 서비스는 기존 `WIKI_SERVICE_KEY`로 아래 읽기 경로를 호출한다.

```text
GET /api/notion/search?q=서버&limit=10
GET /api/notion/page?id=페이지ID&max_chars=6000
GET /api/context?q=질문&sources=all&max_chars=12000
```

`/api/context`의 기본은 기존 위키 조회다. 혼합 조회에는 기존 위키 cursor를 사용하지 않는다. 자세한 원문은 각 출처의 읽기 도구로 이어 읽는다. 서비스 키에는 변경 API 접근 권한이 없다.

## 검증

```sh
npm test
npm run check
npm run build
npm --prefix web run build
npm run test:notion-ui
```

자동 검증은 Notion API 응답을 대체한 테스트다. 운영 확인에는 실제 연결 토큰으로 MCP·웹·Discord에서 읽기, 원문 링크, 수정 반영, 접근 제한을 각각 확인해야 한다.
