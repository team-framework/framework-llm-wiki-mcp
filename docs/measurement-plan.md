# 위키 사용·토큰 계측 계약

계약 버전은 `wiki-metrics-v1`, SQLite schema version은 `1`이다. 이 문서는 `src/measurements.ts`, `src/app.ts`, `src/mcp.ts`의 구현과 확인된 평가 결과를 설명한다. 운영 배포·실제 사용자 확보·UI 검증 완료를 의미하지 않는다. 담당자는 위키 서비스 운영자이며 기본 검토 기간은 최근 30일이다.

## 핵심 KPI와 분모

| KPI | 계산 | 해석과 한계 |
| --- | --- | --- |
| 전달 payload 토큰 절감률 | 짝이 있는 표본에서 `1 - sum(new_tokens) / sum(legacy_tokens)` | 반환 형식·검색 예산을 조정하는 근거다. 전체 대화·GPT 과금 절감률이 아니다. replay와 운영 shadow의 비교 방법이 다르므로 따로 보고한다. |
| D7 재방문율 | 첫 관측일 D에 속한 사람 중 KST D+7일 활동자 / D+7일이 완전히 지난 코호트 사람 | D1도 같은 방법으로 계산한다. 당일이 끝나지 않은 코호트는 분모에서 제외한다. 첫 관측은 실제 가입일·평생 첫 사용일이 아니다. |
| 답변 유용함 비율 | 긍정 평가 수 / 긍정·부정 평가 수 | 평가 수와 응답률을 함께 표시한다. 무응답은 성공·실패로 계산하지 않는다. |

기능별 사용률은 같은 보고 기간·release·client의 활성 사람 중 해당 기능을 사용한 사람의 비율이다. 기능별 비율은 합해서 100%가 될 필요가 없다. 활성 사람은 production 이벤트를 남긴 인증 사용자이며 성공·오류 요청을 모두 포함한다. 서비스 호출과 validation 트래픽은 사람·재방문 집계에서 제외한다.

답변 평가의 분모는 production 웹 chat에 성공 응답을 받은 사람의 요청 수다. 평가를 수정해도 응답 수는 증가하지 않는다. 응답률은 평가된 요청 수 / 평가 가능한 성공 답변 수다. 제품 의견의 자유문장 제출 수는 답변 유용함 비율에 합산하지 않는다.

검색 후 열기 비율은 해당 기간의 성공한 `web.search` 이벤트 중 연결된 `web.search_open` 이벤트가 있는 검색의 비율이다. 같은 검색을 여러 번 열어도 분자는 한 번 센다. 문서 열기와 답변 인용 클릭은 관측된 행동이며 정답 판정이 아니다.

품질 guardrail은 고정 평가셋의 필수 근거 포함률과 완전한 근거를 찾은 질문 수다. 운영 guardrail은 기능별 오류 수와 성공 요청 P50/P95 지연이다. `latency_samples`를 함께 표시하고 N<20이면 P95는 `null`, `p95_status=insufficient_samples`다. 이 20개 기준은 표시 정책이며 통계적 유의성을 보장하지 않는다. 성공 표본이 없으면 P50도 `null`이다. 오류 지연은 이벤트에 남지만 현재 보고서는 별도 quantile로 집계하지 않는다.

## 현재 확보한 replay 근거

2026-09-29 세션에서 비공개 고정 평가 10질문·필수 사실 11개를 같은 로컬 snapshot과 전용 벡터 색인으로 재실행했다. 색인 manifest를 원문으로 재계산해 확인하고 검증한 immutable collection을 직접 조회했다. 기존 기준은 검색 5개 결과와 상위 문서 3개 전체 읽기다. 새 흐름은 첫 페이지 8개 구간·12,000자 예산이다. 직렬화한 반환 payload를 `o200k_base`로 계산했다.

| 방식 | payload 토큰 합 | 기준 대비 절감 | 필수 사실 포함 | 완전한 근거가 있는 질문 |
| --- | ---: | ---: | ---: | ---: |
| 기존 검색 + 전체 문서 읽기 | 278,972 | 기준 | 6/11 | 5/10 |
| 구간 lexical 검색 | 54,448 | 80.48% | 8/11 | 7/10 |
| 구간 hybrid 검색 | 54,502 | 80.46% | 9/11 | 8/10 |

이는 작은 수동 평가셋의 replay 결과다. 실제 운영 사용자 수·재방문·만족도·과거 과금 토큰을 측정한 결과가 아니다. 구간 반환·예산·metadata·중복 제거를 함께 바꿨다. lexical에서 이미 80.48%가 줄었고, hybrid는 54토큰을 더 사용하면서 필요한 사실 1개를 더 찾았다. 2개 필수 사실을 찾지 못했으며 후속 검색·읽기를 포함한 전체 과업 비용도 아니다.

초기 live hybrid 실행의 53,991토큰·80.65% 값은 대체했다. 사후 검증에서 evidence 65개 중 3개가 로컬 snapshot의 문서 hash와 달랐고 당시 서버 전체 corpus commit도 저장하지 않았다. 이 혼합 결과를 동일 snapshot의 통제된 개선 효과로 인용하면 안 된다. 해당 자료는 `docs/benchmarks/2026-09-29/retrieval-quality-mixed-superseded.json`에 한계와 함께 보존했다.

최종 고정 결과는 `docs/benchmarks/2026-09-29/retrieval-quality.json`과 같은 이름의 CSV다. 로컬 snapshot의 선언 commit은 `ed4256e0625b4e63a1a4d8d90bf73cfc373ad9f3`, content manifest hash는 `34842b9d109b6dab42711b8cde21b858dd94c58668668fc36ec4c1ba57d60c95`다. 1,475개 section·1,774개 vector chunk로 만든 전용 색인의 signature는 `69388ddcb7d94545f534612a37ca9c5b792a5c7fd73733fff7b5ba0368eb0ecb`다. 압축 snapshot에 git 디렉터리가 없으므로 실제 `git_commit`은 null, 선언 commit과 검증한 content hash를 구분했다.

공개 자료에는 질문 ID·평가·토큰·지연과 재현용 hash만 저장한다. 비공개 질문·정답 원문·응답 payload는 저장소 밖 별도 파일에 둔다. 같은 근거를 반환해도 무작위 cursor 문자열 때문에 토큰 수가 소폭 달라질 수 있다. 최종 보고서의 실행 시각·코드 hash·tokenizer 버전을 함께 보존한다.

## replay·shadow·provider usage 구분

- **Replay:** 고정 평가셋 재실행 자료다. 운영 사용·재방문 집계에 넣지 않는다.
- **운영 shadow:** 반환된 evidence가 있는 요청 중 기본 20%를 샘플링한다. 해당 evidence와 같은 문서들의 전체 읽기 JSON을 메모리에서 계산하고 새 payload와 비교한다. 문서 `note_hash`가 다르면 그 짝을 제외한다. 비교는 `same_evidence_documents_legacy_full_read`로 표시한다. 기존 검색을 재실행하거나 검색 결과 반환 비용을 포함하지 않으며, 과거 사용자가 실제로 읽은 문서 수도 아니다. 원문이나 추가 LLM 요청은 저장·생성하지 않는다.
- **실제 기능 사용:** production 이벤트를 기록한다. 사람과 서비스의 요청 수를 구분한다. shadow는 같은 이벤트의 부가 숫자이며 별도 사용 횟수를 만들지 않는다.
- **Provider usage:** chat provider가 반환한 input/output/cache/reasoning 숫자다. `provider_actual`은 제공자가 보고한 usage를 뜻하며 실제 청구액 확인을 뜻하지 않는다. tokenizer로 계산한 반환 토큰과 더하지 않는다. input/output이 함께 제공된 표본과 cache/reasoning별 제공 표본 수를 분리한다. 제공되지 않은 항목은 `null`이다.

`payload_tokens`는 반환 객체의 직렬화된 JSON 토큰 수다. chat에서는 답변·출처 등이 포함된 반환 객체이며 LLM에 보낸 전체 입력이 아니다. 응답에 나중에 붙이는 계측 ID·HTTP/MCP envelope는 이 값에 포함되지 않는다. tokenizer는 `gpt-tokenizer`의 `o200k_base`이고 실제 의존성 버전은 lockfile에 고정한다.

shadow 표본 수와 합계를 보고한다. 샘플링에서 빠진 요청의 비용을 임의로 채우거나 팀 전체 절감량으로 외삽하지 않는다. 현재 저장에는 비교 실패 사유·표본 추출 확률 필드가 없어 자세한 sampling coverage는 후속 확장 대상이다.

## 실제 저장 구조

설정은 `WIKI_MEASUREMENT_PATH`, `WIKI_MEASUREMENT_SECRET`, `WIKI_MEASUREMENT_RELEASE`, `WIKI_MEASUREMENT_MODE`다. PATH·SECRET이 없거나 초기화에 실패하면 기능 요청은 계속 처리하고 계측은 disabled로 알린다. secret은 최소 32자다. release를 지정하지 않으면 `unversioned`이므로 배포 비교 전에 commit 식별자를 설정한다.

영속 SQLite의 테이블은 `metadata`, `events`, `feedback`, `product_feedback`다. WAL을 사용하고 DB 파일 권한은 0600으로 설정한다. 디렉터리를 새로 만들 때 권한은 0700이다. `metadata`에 시작 시각과 schema version을 저장한다.

| 위치 | 실제 필드 |
| --- | --- |
| events 공통 | `id`, `ts`(UTC epoch milliseconds), `day`(KST), `actor`(HMAC), `actor_kind`, `client`, `mode`, `release`, `feature`, `status`, `latency_ms`, `facts` |
| facts 재현·결과 | `corpus_commit`, `work_ms`, `result_count`, `truncated`, `retrieval_mode`, `document_hash`, `parent_event_id`, `reason` |
| facts 토큰 | `payload_tokens`, `legacy_tokens`, `baseline_method`, `provider_input`, `provider_output`, `provider_cached`, `provider_reasoning` |
| feedback | `event_id`, `actor`, `ts`, `rating`, `reason` |
| product_feedback | `id`, `ts`, `actor`, `mode`, `release`, `categories`, `details`, `diagnostics` |

`actor_kind`는 `person` 또는 `service`, `client`는 `web`, `mcp`, `discord`, `mode`는 `production` 또는 `validation`, `status`는 `ok` 또는 `error`다. 비production 설정과 `integration-smoke`, `local-development` 신원은 validation으로 분류한다. 빈 검색은 `ok`와 `result_count=0`으로 구분하며 취소 상태는 별도 enum으로 저장하지 않는다.

허용된 기능은 다음과 같다.

- Web: `web.search`, `web.chat`, `web.document_view`, `web.search_open`, `web.citation_open`
- MCP: `mcp.search_wiki`, `mcp.read_note`, `mcp.get_context`, `mcp.get_note_outline`, `mcp.read_sections`, `mcp.get_current_metrics`
- 서비스 조회: `discord.context`, `discord.note`, `discord.outline`

MCP는 tool 단위로 기록하며 HTTP 요청 수를 추가 집계하지 않는다. chat 내부 검색은 별도 사용으로 세지 않는다. 웹의 일반 note/tree 요청은 문서 화면 prefetch와 구분하기 어려워 그대로 조회수로 세지 않고 실제 탐색 이벤트를 사용한다. 인증 실패·입력 검증 단계에서 끝난 요청은 기능 wrapper 전에 반환될 수 있어 현재 기능 오류 집계의 범위 밖이다.

corpus commit은 최대 60초 캐시한 값이다. 따라서 이벤트의 commit이 반환된 모든 문서와 원자적으로 일치하는 snapshot임을 보장하지 않는다. shadow에서는 반환 evidence의 개별 문서 hash를 다시 비교한다. `work_ms`는 본 기능 완료까지, `latency_ms`는 부가 토큰 계산·shadow까지 마친 서버 wrapper 시간이다. SQLite INSERT 이후 응답 직렬화·네트워크·화면 렌더 시간은 포함하지 않는다. 클릭 이벤트의 latency 0은 응답 속도를 측정한 값이 아니므로 성능 비교에 사용하지 않는다.

부가 계산에 실패해도 기본 기능 outcome 기록을 남긴다. DB 저장 실패는 사용자 문서 접근을 막지 않고 프로세스 내 `dropped_events_this_process`를 증가시킨다. 이 counter는 재시작하면 초기화되며 영속적인 전체 누락률을 뜻하지 않는다. 새 UUID로 생성하는 이벤트는 일반 재시도에 대한 멱등 키가 없다. 답변 평가는 event ID로 upsert하지만 기능 재요청·클릭 재전송은 여러 행이 될 수 있다.

## 신원·원문·보관 정책

현재 인증은 GitHub login을 반환한다. 사람의 `actor`는 `HMAC-SHA256(secret, 'person:github:' + login)`으로 저장하고 raw login은 저장하지 않는다. numeric GitHub user ID를 쓰는 구현이 아니므로 계정명 변경이나 HMAC secret 교체는 신원을 끊어 새 첫 관측자로 잡힐 수 있다. 웹과 MCP에서 같은 GitHub login을 확인한 경우에는 같은 사람으로 집계한다.

서비스 키의 호출은 별도의 service HMAC 신원으로 기록한다. 현재 Discord는 봇 서비스 사용이며 실제 Discord 참여자의 사용·재방문을 식별하지 않는다. GitHub 사용자와 Discord 사용자를 연결하거나 둘의 고유 사용자 수를 합친 구현은 없다.

자동 계측 이벤트에는 원본 질문·답변·대화·문서, 로그인명, 이메일, IP, bearer/cookie, 전체 URL을 저장하지 않는다. 문서 탐색 경로는 별도 document namespace HMAC으로 남긴다. 허용 필드만 저장하고 수치의 finite·음수 여부, hash 형태, reason·retrieval·baseline enum을 검증한다. HMAC은 익명화 완료의 증명이 아닌 가명 처리다.

사용자가 직접 제출한 제품 의견은 별도 `product_feedback`에 **자유문장 원문**을 저장한다. 사용자가 진단 정보 첨부를 선택하면 `/docs` 아래 페이지 경로와 viewport 크기도 저장한다. query string·fragment·IP·user-agent는 수집하지 않는다. 문서 경로와 자유문장은 팀원이 읽을 수 있으므로 제출 화면에서 저장 내용·열람 범위를 안내해야 한다. 이 명시적 제출 예외를 자동 질문·문서 로그 저장으로 확대하지 않는다.

이벤트·의견의 삭제 기준은 90일이며 앱 실행 중 매시간 purge하고 기록·보고 시에도 정리한다. 중단된 프로세스는 삭제를 실행할 수 없으므로 장기 중단·백업 복원 시 만료 자료 정리를 운영 절차에 포함한다. 백업의 보존 정책은 운영자가 별도로 맞춰야 한다. 현재 기본 보고 기간은 30일이다.

재방문은 보관 중인 최대 90일의 첫 관측일을 매번 계산한다. 오래 쉬었던 기존 사용자도 첫 관측자로 잡힐 수 있고 오래된 이벤트 만료 후 재계산 값이 바뀔 수 있다. 확정 cohort 집계의 영구 보관은 아직 구현하지 않았다. 포트폴리오에 쓸 집계는 생성 시각·기간·schema·release·N을 함께 export해 해석 범위를 고정한다.

앱은 Fastify 자동 request logging을 끄고 warn 레벨을 사용한다. 이 설정만으로 reverse proxy·inference 서버의 로그까지 검증했다고 주장하지 않는다. 배포 검증에서 합성 비밀 표식을 사용해 계층별 query/body/exception 원문 노출을 확인한다.

## 실제 API 계약

아래 route는 위키에 로그인한 팀원이 사용한다. 별도 관리자 전용 route는 아니다. 서비스 읽기 key는 context/note/outline GET만 허용하므로 이 API의 접근 권한으로 사용할 수 없다. 쿠키 기반 POST에는 same-origin 확인을 적용한다. 집계에는 개인별 raw event를 반환하지 않는다.

| API | 입력·결과 |
| --- | --- |
| `GET /api/measurements?days=30` | days는 `7`, `30`, `90`. 기본 30. `schema_version`, `generated_at`, `started_at`, `range`, `status`, `active_people`, `requests`, `service_requests`, `retention`, `features`, `daily`, `feedback`, `search_to_open`, `instrumentation`, `caveats`를 반환한다. |
| `POST /api/events` | `feature`는 웹 문서 열기·검색 클릭·인용 클릭 3개만 허용한다. 선택적인 `path`, `parent_event_id`를 받는다. 경로는 실제 위키 outline으로 검증하고 hash로 저장한다. parent가 있으면 본인 검색/chat 성공 이벤트인지 확인한다. 임의 feature·raw payload 저장 route가 아니다. |
| `POST /api/feedback` | `{event_id, rating: 'positive' 또는 'negative', reason?}`. reason은 `correct`, `missing_context`, `outdated`, `irrelevant`, `slow`, `other`. 본인의 성공한 웹 chat 이벤트만 평가할 수 있다. 같은 event를 upsert해 기존 평가를 바꾼다. |
| `POST /api/product-feedback` | categories 1~3개(`bug`, `search_miss`, `unclear_docs`, `good_result`, `slow`, `other`), details 1~4,000자. 선택적인 diagnostics는 `/docs` 경로(최대 1,000자, query/fragment 금지)와 viewport width 320~10,000, height 200~10,000이다. 사람별 최근 24시간 10건 제한이며 초과하면 429다. |
| `GET /api/product-feedback?limit=20` | production 제품 의견 최근 20개, 최대 100개. 팀원이 categories·details·진단 정보·시각·release를 읽는다. 작성자 HMAC은 응답에 포함하지 않는다. |

chat 응답의 `measurement_id`와 검색 응답의 `X-Wiki-Event`로 평가·클릭을 연결한다. 계측 disabled 상태를 UI에서 구분한다. 계측·피드백 UI의 최종 동작은 배포 검증으로 별도 확인해야 한다.

보고 기간은 KST 오늘을 포함한 7/30/90일이며 `today_partial=true`다. 하루를 완전히 관측했다고 가정하지 않는다. 선택된 production 이벤트가 없으면 최상위 `status=not_collected`와 사용자·요청 합계 `null`을 반환한다. 분모 0의 비율도 `null`이다. 세부 표본 count 0은 기록된 표본이 없음을 나타낸다. 측정기가 정상 동작한 무사용 기간과 수집 중단 기간을 구분하는 health timeline은 아직 없으므로 빈 기간을 실제 사용량 0으로 단정하지 않는다.

## 배포 전후 보고와 후속 확장

현재 보고서는 release·client·feature별 행을 나누며 임의 from/to·release 필터, deployment 테이블, CSV export API는 제공하지 않는다. 배포 시 release를 지정하고 JSON 보고서와 배포 시각을 별도 보관한다. 전후 비교는 같은 길이·요일·관측 완료 여부를 맞추고 모델·corpus·client·사람/서비스 구성과 N을 함께 제시한다. 순차 배포 비교를 인과 효과로 표현하지 않는다. 계측 이전 기간을 replay 수치로 채우지 않는다.

후속 확장은 영속 `collection_health`·배포 이력, corpus 원자적 snapshot, sampling 상태·누락률, 이벤트 멱등 키·rate limit, numeric 신원, 확정 cohort 집계, 자유 기간 비교·CSV export다. Discord 제안·승인·거절·Draft PR 생성률은 봇의 상태 전이에서 별도로 계측해야 하며 현재 서비스 조회 수로 대체할 수 없다.

## 검증 기준

고정 평가를 다시 실행할 때는 비공개 corpus와 gold 파일을 별도로 준비한다.

```sh
npx tsx scripts/evaluate-retrieval.ts \
  --root /private/wiki-snapshot \
  --gold /private/retrieval-gold.json \
  --output /tmp/retrieval-aggregate.json
```

gold는 `[{"id":"q1","query":"synthetic question","expected":[{"path":"example.md","needle":"literal evidence"}]}]` 형식이다. 질문별 `includeHistory`, 각 사실의 허용 대안 `paths`·`needles` 배열을 선택적으로 지정한다. 한 반환 source에서 허용 경로와 허용 문자열을 함께 만족해야 그 사실을 찾았다고 판정한다. 문자열은 대소문자를 구분한다. source의 관련성을 사람이 확인한 정답 파일이며 자동 최종 답변 평가가 아니다.

hybrid 실행에는 `--qdrant-url`, `--embedding-url`, 선택적인 `--alias`를 추가한다. CLI는 기존 index만 읽으며 로컬 corpus로 재계산한 signature와 index manifest를 비교한다. 검증한 collection을 직접 조회해 평가 도중 alias 이동의 영향을 막는다. read-only adapter는 writer sync를 실행하지 않아 상태를 starting으로 보고할 수 있으므로 manifest 검증과 실제 hybrid mode·stale hit 0을 함께 확인한다. corpus·모델 revision·schema 불일치, stale hits, lexical fallback, 실행 중 corpus 변경은 평가 실패로 처리한다. `--corpus-commit`은 압축 snapshot의 선언값으로 별도 표시하며 실제 git commit과 content manifest hash를 대체하지 않는다.

결과에는 질문 ID·점수·토큰·지연·생략 여부·검색 상태, corpus hash, gold-file hash, code commit·수정 여부·소스 파일 hash, tokenizer 버전이 들어간다. 원문은 출력하지 않는다. 필요한 경우에만 `--private-output /private/payloads.json`을 지정하며 해당 파일은 저장소 밖에 0600 권한으로 쓴다. opaque cursor의 무작위 문자열 때문에 같은 반환 근거에서도 토큰 합계가 소폭 달라질 수 있다. 로컬 호출 지연은 cache가 섞인 값이며 HTTP/provider 성능 비교와 구분한다.

1. 서비스·validation 요청을 사람·재방문·답변 피드백에서 제외하고 GitHub 웹/MCP 신원과 서비스 신원을 분리한다.
2. KST 자정·당일 미성숙 D1/D7·분모 0·P95 N<20·90일 경계·계정명 변경 한계를 확인한다.
3. provider 미제공 수치와 tokenizer proxy를 구분하고 shadow hash 불일치·부가 계산 실패에서도 기본 요청을 기록한다.
4. 다른 사람의 event ID로 답변 평가·parent 클릭 연결을 할 수 없고, 평가 수정은 응답 수를 늘리지 않는다.
5. 자동 이벤트에서 합성 질문·문서 원문 표식이 발견되지 않는다. 제품 의견은 사용자가 제출한 원문과 선택한 진단 정보만 저장한다.
6. 제품 의견의 24시간 제한·진단 정보 opt-in·90일 정리·팀원 열람 범위를 검증한다.
7. DB 실패가 기능 요청을 막지 않고 계측 누락을 드러낸다. 실제 latency에 shadow 비용을 포함하고 클릭의 고정 0ms를 성능 수치로 해석하지 않는다.

근거는 고정 평가의 세션 집계와 현재 계측·인증·API 소스다. 이 문서만으로 운영 실사용, 유료 비용 절감, 장기 재방문 효과가 입증되지는 않는다.
