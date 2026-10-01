---
name: wiki-change
description: Prepare a source-backed Framework or InnoLive wiki create, update, or delete proposal from user-provided decisions or conversations. Present a reviewable Markdown change and use the existing Wiki Web Agent for its Draft PR workflow.
---

# 위키 변경안 작성

사용자가 위키 반영을 요청하면 대상과 변경 범위를 정하고 `wiki-answer`의 조회 흐름으로 기존 문서와 관련 근거를 읽는다. 명시적인 신규 문서 요청에는 유사 문서를 검색해 중복을 확인한다. 기존 문서 변경은 MCP가 반환한 정확한 경로를 사용한다.

사용자가 제공한 결정과 확인한 출처를 바탕으로 변경안을 작성한다. 확인되지 않은 값은 비워 두거나 미확인으로 남긴다. 한 문서의 원문을 다시 쓸 때는 관련 없는 내용과 frontmatter를 보존한다.

검토할 결과에 다음을 포함한다.

- 작업: 생성·수정·삭제
- 정확한 문서 경로와 변경 이유
- 현재 원문에서 바꿀 전체 Markdown 블록과 변경 후 블록 또는 새 문서 원문
- 근거 링크, 검증 상태, 미확인 항목
- 조회한 `note_hash` 또는 section hash가 있으면 원문 기준값

삭제는 삭제할 문서와 이유를 명확히 보여준다. 표, 목록, 코드 블록을 중간에서 잘라 변경안을 만들지 않는다. 문서가 바뀌면 새 원문으로 변경안을 다시 만든다.

## Wiki Web에서 검토

기존 MCP 7개 도구는 읽기 전용이다. 이 스킬은 변경안을 작성한다. Draft PR 발행은 [Wiki Agent](https://framework-wiki.chaeyn.com/chat)의 기존 흐름을 사용한다.

사용자에게 변경안과 함께 붙여 넣을 요청을 제공한다.

```text
/업데이트
작업: 수정
문서: <확인한 정확한 경로>
변경 이유: <확인한 결정과 근거>
변경 내용: <검토할 Markdown 변경안>
```

현재 Codex 대화는 Wiki Web에 자동으로 전달되지 않는다. 사용자가 제공한 반영 범위만 요청에 담는다. 웹 조작이 가능하고 사용자가 전달을 요청했다면 `/업데이트`를 보내 변경안을 생성한다. Wiki Web은 팀원이 공유하는 대화 기록이므로 사용자가 승인한 내용과 대상만 전송한다.

Wiki Web에서 현재 원문과 변경 후 내용을 검토한다. 기존 승인 흐름에 따라 요청한 팀원이 `PR 열기`를 선택하면 Framework Bot이 Draft PR을 만든다. 사용자가 구체적인 변경안을 승인하지 않았다면 대신 승인하지 않는다. 병합은 별도 요청과 저장소 지침에 따른다.

변경안 작성, 웹 전달, Draft PR 생성, 병합, 위키 동기화를 각각 확인한 단계까지만 보고한다. [Agent 사용법](https://framework-wiki.chaeyn.com/docs/bot-guide)을 연결한다.
