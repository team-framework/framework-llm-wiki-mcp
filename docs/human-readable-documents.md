# 사람이 읽는 제목과 본문

위키 Markdown의 YAML frontmatter에 선택 항목을 넣는다. 웹은 `DisplayTitle`을 제목으로, `DisplayContent`를 읽기 쉬운 설명으로 표시한다. 원문은 같은 페이지의 원문 보기에서 확인한다. 기존 문서에는 필드를 강제로 추가하지 않는다.

```yaml
DisplayTitle: 브랜치와 이슈 작성 규칙
DisplayContent: |
  작업을 시작할 때 이슈를 먼저 만들고, 이슈 번호를 넣어 브랜치를 만든다.

  1. 변경할 내용과 확인 방법을 이슈에 적는다.
  2. `feat/english-slug/#번호` 형식으로 브랜치를 만든다.
  3. 한 작업씩 커밋하고 Draft PR로 검토를 시작한다.
DisplaySourceHash: 원문_body의_SHA256
```

`display_title`, `display_content`, `display_source_hash`도 지원한다. 두 표기가 함께 있으면 PascalCase를 우선한다. 제목은 200자, 표시 본문은 30,000자까지다. 실행 코드가 없는 Markdown으로 렌더링한다.

`DisplaySourceHash`는 frontmatter를 뺀 원문 body의 SHA256이다. 원문이 바뀌어 hash가 맞지 않으면 웹에서 표시 본문이 오래되었음을 알리고 원문을 기본으로 보여준다. 자동으로 작성한 표시 본문에는 hash를 함께 기록한다. 원문의 조건·날짜·수치·검증 상태를 바꾸거나 새로운 사실을 추가하지 않는다.

검색·임베딩은 원문을 사용한다. 표시 본문은 단락 검색 metadata와 벡터 입력에서 제외해 같은 내용을 두 번 전달하지 않는다. 전체 원문 읽기는 Git에 저장한 frontmatter도 그대로 포함한다. 표시 필드 변경도 일반 위키 변경과 같은 Draft PR 검토를 거친다.
