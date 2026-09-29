# 개발 세션 토큰과 API 가격 환산

이 자료는 위키 구현에 사용한 Codex 루트·하위 에이전트 로그의 수치 집계다. 위키 사용자 운영 지표, 검색 payload 평가, Hermes 서버의 별도 추론 사용량과 구분한다. 현재 결과는 작업 중간 checkpoint이며 [집계 JSON](benchmarks/2026-09-29/session-usage-checkpoint.json)의 시각 이후 사용량은 포함하지 않는다.

## 집계 방법

`scripts/report-session-usage.py`는 각 파일의 마지막 `token_count.info.total_token_usage`를 한 번만 더한다. 같은 누적값을 여러 번 알리는 이벤트를 사용량처럼 합산하지 않는다. 첫 누적값과 마지막 누적값의 차이도 사용하지 않는다. 첫 값에는 그 파일의 최초 요청 비용이 이미 포함되기 때문이다.

파일의 실제 경로·inode로 중복 입력을 제거한다. `session_meta.id`로 전체 파일을 중복 제거하지 않는다. 하위 에이전트 파일 안에 부모의 metadata가 복사될 수 있다. root는 `--root-file`로 지정한 실제 파일이며, directory 모드는 각 파일의 **첫 metadata**에 있는 부모 관계를 따라 root와 후손을 선택한다. 뒤에 복사된 metadata는 이 관계를 바꾸지 않는다. 선택한 파일 수와 root/subagent 수를 결과에서 확인한다.

파일마다 읽기 시작 시 byte 크기를 고정한다. 마지막 JSON 행을 쓰는 중이면 그 불완전한 행만 제외하고 개수를 기록한다. 완성된 행이 잘못되었거나 누적 counter가 감소하면 실패한다. 한 파일에서 여러 모델을 발견하면 누적량을 마지막 모델에 몰아넣지 않고 모델별 세부 분석이 필요하다는 오류를 낸다.

| 수치 | 정의 |
| --- | --- |
| input_tokens | 파일별 누적 입력 합. 반복 요청의 context와 cached input을 포함한다. 고유하게 작성한 텍스트 크기가 아니다. |
| cached_input_tokens | input에 포함된 캐시 입력 부분집합 |
| uncached_input_tokens | input − cached input |
| output_tokens | 누적 출력. reasoning output을 포함한다. |
| reasoning_output_tokens | output 안의 추론 부분집합. 총량·가격에 다시 더하지 않는다. |
| total_tokens | input + output |
| uncached_input_plus_output_tokens | input − cached input + output. 캐시를 제외한 보조량이며 Codex goal 화면의 집계 정의와 같다고 보장하지 않는다. |

같은 모델의 파일들을 합쳐 모델별 결과를 만들고 root/subagent 합계도 제공한다. 원본 대화·도구 출력·파일 경로·session ID·사용자 ID는 public JSON과 표준 출력에 넣지 않는다. 미지원 모델명·예외 원문도 출력하지 않는다.

## 가격 환산 가정

2026-09-29에 확인한 [OpenAI 공식 API 가격표](https://developers.openai.com/api/docs/pricing)의 short-context 단가를 사용한다. 단위는 100만 토큰당 USD다.

| 모델 | Standard 입력 | 캐시 입력 | 출력 |
| --- | ---: | ---: | ---: |
| GPT-6 Astra | $10 | $1 | $50 |
| GPT-6 Sol | $2 | $0.20 | $10 |
| GPT-6 Luna | $0.10 | $0.01 | $0.50 |

Fast 가정은 위 단가의 2배다. [공식 Astra 모델 문서](https://developers.openai.com/api/docs/models/gpt-6-astra)는 272K를 넘는 요청에 long-context 가산을 적용하고 Fast를 해당 단가의 2배로 설명한다. 도구는 모든 관측 `last_token_usage.input_tokens`의 최대값과 누락 여부를 검사한다. 현재 checkpoint의 최대 단일 입력은 225,145로 272,000 이하다. cache-write tokens는 0이다.

모델별 Standard 환산식은 다음과 같다.

```text
((input − cached_input) × input_rate
 + cached_input × cached_input_rate
 + output × output_rate) / 1,000,000
```

작업 요청에 Fast라는 표현이 있어도 로그의 처리 등급 증거로 간주하지 않는다. 현재 `turn_context`에 service tier가 없어 Standard와 Fast를 각각 가정했다. 장문 요청·누락된 요청별 입력 관측·0이 아닌 cache writes가 있으면 이 단순 환산을 중단하고 가격을 null로 남긴다. 모델별 사용량 자체는 계속 보고한다.

이 값은 **API 토큰 가격에 대응시킨 추정액**이다. ChatGPT OAuth 실제 청구액·구독료·구매 크레딧 사용액을 뜻하지 않는다. 도구 호출 요금, 서버·임베딩 비용, 세금, 데이터 지역 가산, rollout 밖 Hermes 추론은 포함하지 않는다. 가격은 자동 갱신하지 않으므로 재실행 시 공식 단가 변경 여부를 확인하고 `PRICING.verified_date`와 표를 함께 갱신한다.

## 현재 checkpoint

2026-09-29 12:17:16 UTC에 관측한 root 1개·subagent 4개 파일의 결과다. 이후 작업으로 증가할 수 있다.

| 항목 | 수치 |
| --- | ---: |
| 입력 | 106,637,012 |
| 입력에 포함된 캐시 | 103,962,112 |
| 출력 | 573,436 |
| 출력에 포함된 추론 | 221,483 |
| input + output | 107,210,448 |
| input − cache + output | 3,248,336 |
| Standard 가정 | $83.47659378 |
| Fast 가정 | $166.95318756 |

집계 파일은 model별 input/cache/output과 가격을 함께 보존한다. 현재 수치를 최종 비용으로 인용하지 않는다. 최종 보고 직전에 다시 실행하고 보고서의 snapshot 시각을 함께 적는다.

## 재실행

로그 폴더와 root 경로는 로컬에서 선택한다. 명령의 placeholder를 실제 비공개 경로로 대체하되 그 경로나 session ID를 공개 문서에 붙이지 않는다.

```sh
python3 scripts/report-session-usage.py \
  --directory /private/session-directory \
  --root-file /private/session-directory/root-rollout.jsonl \
  --output /tmp/session-usage-checkpoint.json
```

관계 metadata에 의존하지 않고 명시한 파일만 집계하려면 다음 형태를 사용한다.

```sh
python3 scripts/report-session-usage.py \
  --files /private/root.jsonl /private/agent-a.jsonl /private/agent-b.jsonl \
  --root-file /private/root.jsonl \
  --output /tmp/session-usage-checkpoint.json
```

`--final`은 작업자가 최종 관측을 요청했다는 `final_requested` 표시만 남긴다. 프로세스를 종료하거나 세션이 끝났음을 검증하는 옵션이 아니다. 파일은 순차로 읽으므로 snapshot 시작·완료 시각 범위를 기록한다. 이 보고를 생성하는 중에도 root나 에이전트가 작업하면 추가 토큰이 생긴다.

검증은 `python3 -m unittest discover -s test -p 'test_session_usage.py' -v`로 실행한다. 합성 fixture로 누적 이벤트 중복, 복사된 parent metadata, reasoning 부분집합, 중복 경로, 불완전한 마지막 행, 장문 요청의 환산 중단, 비공개 식별자 출력 방지를 확인한다.
