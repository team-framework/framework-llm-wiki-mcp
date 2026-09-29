# 필요한 문단을 조회하고 수정하기

Markdown과 Git PR을 문서의 원본으로 사용한다. 검색 서버는 섹션 색인과 Vector DB로 관련 문단을 찾고, 원본에서 현재 문단을 읽어 반환한다. Vector DB가 연결되지 않으면 `retrieval.semantic_status`에 상태를 표시하고 키워드 검색을 사용한다. 서버는 오래된 섹션 hash를 가진 벡터 결과를 버린다.

## 조회 도구

| MCP 도구 | 입력 | 반환 |
| --- | --- | --- |
| `search_wiki` | `query`, 선택 필터·`limit` | 문서 후보, 일치 부분 preview, 섹션 ID와 hash |
| `get_context` | `query`, 선택 필터·`max_chars`·`limit` | 관련 섹션의 본문·출처·검증 등급·hash |
| `get_note_outline` | `path` | 제목, 섹션 ID·크기·hash·원본 줄 번호 |
| `read_sections` | `refs`, 선택 `max_chars`·`cursor` | 지정한 섹션의 원문과 이어 읽기 정보 |
| `read_note` | `path` | 문서 전체를 한 번 반환하는 호환 조회 |

필터는 `domain`, `owner`, `verification`, `include_history`다. 사건기록은 기본 검색에서 제외한다. `read_note`와 `get_current_metrics` 응답은 본문을 `content`에 한 번 담는다. 웹 렌더러는 내부 `getNote()`의 `body`를 사용할 수 있다.

`get_context`와 `read_sections`의 기본 `max_chars`는 12,000이다. 제한은 `evidence` 배열을 compact JSON으로 직렬화한 문자 수에 적용한다. 응답의 query·상태·cursor와 MCP 봉투는 별도 크기다. `limit`은 관련 섹션 후보 수이며, 기본값은 8이다.

```json
{"query":"배포 권한","max_chars":12000,"limit":8}
```

각 evidence에는 `path`, `title`, `section_id`, `heading`, `headings`, `content`, `verification`, `content_hash`, `hash`, `note_hash`, `source`가 있다. `source`는 문서 경로와 원본 줄 번호다. `content_hash`와 `hash`는 전체 섹션의 SHA256이며, 이어 읽기의 일부 본문만 계산한 hash가 아니다.

응답의 `truncated: true`는 관련 섹션을 덜 읽었다는 뜻이다. 다음 호출에 `next_cursor`를 전달한다. 표와 fenced code는 중간에서 자르지 않는다. 한 블록이 예산보다 크면 `required_chars`를 확인하고 예산을 늘린다. 최대값은 128,000이다.

```json
{"refs":[],"cursor":"이전 응답의 next_cursor","max_chars":12000}
```

cursor에 기록한 섹션이 바뀌면 서버는 `Stale section hash` 오류를 반환한다. 새 outline이나 검색 결과로 다시 읽는다. 직접 읽을 때도 `refs`의 `hash`를 함께 보내면 검색 후 수정된 문서를 감지할 수 있다.

## 로컬 부분 수정

쓰기 도구는 원격 MCP에 등록하지 않는다. 팀원의 로컬 위키 Git checkout에서 patch CLI로 수정한 뒤 기존 검증·커밋·Draft PR 흐름을 따른다.

```json
{
  "path":"운영/배포.md",
  "expected_note_hash":"문서 SHA256",
  "operations":[{
    "section_id":"outline에서 받은 ID",
    "expected_hash":"섹션 SHA256",
    "replacement":"## 배포 권한\n승인된 배포 계정으로 실행한다.\n\n"
  }]
}
```

`replacement`는 해당 제목을 포함한 섹션 전체다. 변경하지 않은 frontmatter·이웃 섹션은 원래 바이트를 보존한다. `expected_note_hash`는 선택값이지만 사람에게 최종 diff 승인을 받은 제안에서는 사용한다. 섹션 hash는 필수다. 중복된 섹션 ID, stale hash, 경로 탈출과 symlink 경로를 거부한다.

```sh
npx tsx src/patch-cli.ts --root /local/framework-llm-wiki --input /tmp/patch.json
npx tsx src/patch-cli.ts --root /local/framework-llm-wiki --input /tmp/patch.json --apply
```

첫 호출은 dry-run이다. compact diff와 변경 전후 hash를 확인한 뒤 `--apply`를 사용한다. 긴 diff는 `diff_truncated`를 표시하므로 실제 Git diff를 확인한다. 같은 CLI끼리 lock으로 충돌을 막고, 적용 직전에 원본 hash를 다시 검사한다. 다른 편집기는 이 lock을 사용하지 않으므로 Git diff와 PR 검토까지 완료한다.

새 문서는 `{"path":"운영/새 문서.md","create":"Markdown 전체"}`를 사용한다. 파일이 이미 있으면 생성에 실패한다. 새 지식을 작성할 때 필요한 본문 토큰은 남아 있으며, 기존 문서를 읽거나 다시 출력하는 비용을 줄이는 것이 이 방식의 절감 범위다.

## 재현 가능한 토큰 측정

```sh
npx tsx scripts/benchmark-tokens.ts --root /local/framework-llm-wiki --output /tmp/token-report.json --commit 실제-위키-커밋
```

기존 조회 응답과 새 bounded context, 기존 전체 수정과 새 섹션 patch를 `o200k_base`로 계산한다. 원본 문서를 수정하지 않는다. 보고서에는 원문을 담지 않고 문서 수·토큰 수·hash·제한 여부를 기록한다. 실제 모델 청구 토큰과 추론 토큰을 측정하지 않으며, 검색 품질은 별도 질문·정답 평가로 확인해야 한다. 이미 게시된 Vector DB를 포함하려면 `--qdrant-url`과 `--embedding-url`을 함께 지정한다.
