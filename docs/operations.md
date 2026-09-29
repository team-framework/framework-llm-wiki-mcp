# 위키 검색·웹 운영

Markdown 정본은 별도 Git checkout에 보관한다. API 컨테이너는 읽기 전용으로 연결한다. Qdrant와 임베딩 캐시는 정본에서 다시 만들 수 있다.

## 서비스와 인증

| 서비스 | 기본 주소 | 접근 |
|---|---|---|
| API·MCP·웹 진입점 | `127.0.0.1:3100` | 기존 reverse proxy, 팀 GitHub 로그인 |
| Fumadocs | `127.0.0.1:3101` | API가 인증 후 전달 |
| Qdrant | `127.0.0.1:6336` | 서버 내부 |
| 로컬 임베딩 | `127.0.0.1:8091` | 서버 내부 |
| Hermes OAuth 추론 | `127.0.0.1:8647` | 별도 공유 key |

Linux host network를 사용하므로 API와 Fumadocs의 수신 주소를 loopback으로 유지한다. 외부에는 API 진입점만 연결한다. 문서 응답은 `private, no-store`이며 웹 빌드에 위키 원문을 포함하지 않는다.

`.env.example`을 참고해 기존 GitHub 인증 설정에 `HERMES_WIKI_KEY`, `WIKI_SERVICE_KEY`를 추가한다. 서로 다른 32자 이상의 난수를 사용하며 `.env` 권한은 `600`으로 둔다. Discord에는 `WIKI_SERVICE_KEY`만 전달한다. 이 key는 `GET /api/context`, `/api/outline`, `/api/note`에만 쓸 수 있다. 문서 화면, 챗봇, MCP의 사용자 인증을 대신하지 않는다.

추론 서비스는 `deploy/hermes/framework-wiki-inference.service`로 실행한다. 서비스 파일의 경로에 Hermes 설치와 OAuth 로그인이 필요하다. 추론 key는 `~/apps/framework-wiki-inference/.env`의 `HERMES_WIKI_KEY`와 API `.env`에서 같아야 한다. 토큰과 key를 Git·로그·브라우저에 넣지 않는다.

## 색인 갱신과 복구

- 시작 시와 60초마다 원문을 확인한다. 같은 입력은 임베딩 캐시를 재사용한다.
- 새 collection에 모든 벡터와 manifest를 쓴 뒤 원문 hash를 다시 확인하고 `framework_wiki` alias를 바꾼다.
- 실패하면 이전 alias를 유지한다. 검색 응답의 `retrieval.semantic_status`와 인증된 `/api/status`에서 상태를 확인한다. `ready`일 때만 색인 완료로 판단한다.
- 첫 실행은 고정 revision의 모델을 내려받는다. 이후 모델 volume을 재사용한다. 원문 임베딩은 서버 CPU에서 수행한다.
- 모델·분할 규칙 변경은 새 generation을 만든다. 이전 collection은 자동 삭제하지 않는다. rollback 기간이 지난 collection만 alias 사용 여부를 확인한 뒤 운영자가 정리한다.
- 원문 hash가 달라진 벡터 후보는 검색 근거에서 제외한다. 벡터 서비스 장애 때 키워드 검색을 제공하며 응답에 상태를 표시한다.

`docker compose up -d --build` 후 `/health`, 인증된 `/api/status`, 한국어 `/api/context`, 문서 화면, 출처가 있는 챗봇 응답을 확인한다. 컨테이너 시작만으로 검증을 끝내지 않는다. 재배포 전 `.env`와 이전 이미지·collection 이름을 보관한다.

검증 환경의 volume을 운영으로 옮길 때 `.env`의 `QDRANT_VOLUME`, `EMBEDDING_MODELS_VOLUME`, `EMBEDDING_CACHE_VOLUME`에 기존 volume 이름을 지정할 수 있다. 두 Qdrant 인스턴스가 같은 volume을 동시에 열지 않도록 이전 서비스를 먼저 중지한다. volume을 삭제하지 않는다.

## 읽기 예산과 기록

`max_chars`는 반환할 원문 근거 JSON의 문자 예산이다. 전체 HTTP 응답이나 모델 추론 토큰 한도가 아니다. 큰 표·코드블록에는 `required_chars`가 나올 수 있다. `truncated`와 `next_cursor`를 확인하고 필요한 근거를 이어 읽는다. cursor는 해당 프로세스에서 10분간 유효하므로 만료·재시작 뒤에는 검색부터 다시 시작한다.

토큰 비교는 고정된 위키 commit과 tokenizer를 기록한다. 신규 내용 작성량, 검색 recall, 실제 provider 사용량을 응답 크기와 구분한다. 비공개 원문과 평가 payload는 공개 코드 저장소에 올리지 않는다.
