---
name: wiki-metrics
description: Check metrics recorded in the Framework or InnoLive wiki and the exact wiki checkout served by MCP. Use for current values, verification dates, document counts, commit freshness, and distinguishing recorded measurements from live system state.
---

# 현행 수치와 위키 상태 확인

수치 질문은 `get_current_metrics`로 `_현행_수치.md`를 읽는다. 위키 동기화나 최신 반영 여부를 묻는 질문은 `get_wiki_status`로 `wiki_commit`과 `note_count`를 읽는다. 두 도구가 모두 필요한 질문에만 둘 다 호출한다.

수치는 단위, 측정 조건, 출처, 기록·검증 날짜와 함께 답한다. 기록된 값을 현재 실시간 값으로 표현하지 않는다. 문서에 없는 날짜·측정 조건은 확인되지 않았다고 밝힌다. 한 수치의 맥락이 부족하면 `wiki-answer`의 섹션 조회 흐름으로 연결 문서를 읽는다.

`get_wiki_status`는 서버가 마운트한 정본 위키 checkout을 보고한다. 이를 MCP 서버 코드 버전, Git pull 성공, PR 병합, 배포 완료의 증거로 사용하지 않는다. 사용자가 비교할 위키 commit을 제공했으면 정확히 비교한다. 대상 commit을 확인하지 못했으면 최신 여부를 단정하지 않는다.

답변에는 [현행 수치](https://framework-wiki.chaeyn.com/docs/_%ED%98%84%ED%96%89_%EC%88%98%EC%B9%98.md) 또는 실제 읽은 문서 링크를 붙인다. 실시간 확인이 필요하면 사용자가 지정한 시스템에서 추가 확인하고, 위키 기록과 직접 확인한 값을 구분한다.
