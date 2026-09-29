# 2026-09-29 운영 배포 검증

## 적용한 범위

공개 진입점은 `https://framework-wiki.chaeyn.com/docs`다. 팀 GitHub 인증 뒤 Fumadocs·문서 챗봇·Bot 사용법·사용 현황·제품 의견 창을 제공한다. API 3100, 웹 3101, Qdrant 6336, 로컬 임베딩 8091, Hermes 추론 8647은 서버 loopback에 둔다.

운영 원문 157문서는 기존 private Git checkout을 읽기 전용으로 연결했다. 기존 운영 이미지와 앱 디렉터리·환경, 봇 runtime을 전환 전에 백업했다. preview의 모델·색인 volume을 보존해 운영에서 재사용하며 이전 Qdrant를 먼저 중지했다. 위키·Bot 코드의 Draft PR을 유지하고 자동 병합하지 않는다.

## 실제 확인

- 인증 없는 외부 `/docs`: 302 로그인 이동. 기존 로그인 세션의 운영 브라우저에서 문서 목록·챗봇·추론 수준 선택·의견 창을 열었다.
- 검증 신원의 `/docs`, `/docs/bot-guide`, `/docs/insights`, `/api/status`, `/api/measurements`: 200, `private, no-store`.
- 운영 벡터 색인: ready, 1,481개 section·1,785개 chunk. 한국어/식별자 문맥 조회는 hybrid, stale hit 0.
- 실제 Hermes ChatGPT OAuth GPT-6 Luna low 문서 응답: 출처 포함, provider 입력 5,611·출력 109·합계 5,720 tokens. 답변 평가·제품 의견 저장 200. 이 값은 당시 검증 호출 한 번의 usage이며 전체 팀 비용이 아니다.
- 검증 요청은 `integration-smoke`로 구분했다. SQLite에 validation chat·제품 의견을 확인했으며 운영 사람·재방문 지표에 넣지 않는다. 배포 전 사용자 활동은 관측하지 않았으므로 0이나 추정치로 채우지 않는다.
- API 컨테이너의 최근 요청 로그 0행, 위키 Caddy virtual host에 access-log 설정 없음. 이 확인을 서버 전체 로그 정책이나 모든 upstream 로그 검증으로 확대하지 않는다.
- Discord 명령 2개 등록, Gateway 연결, 기존 알림 서비스 healthy, runtime 재시작 보존을 확인했다.
- 정기 수집을 켠 첫 catch-up은 47개 대상·469개 메시지·14개 범위를 처리했다. 모두 no_update, 차단·backlog 0건이었다. 승인·PR 대기 outbox는 0건이다.
- API/MCP 타입 검사와 테스트 61개, 웹 타입 검사·production build를 통과했다. 일별 미관측 값, 서비스만 사용한 날, 실패 요청, validation 제외, KST 날짜 경계를 검증했다. 세션 사용량 집계 테스트 6개도 통과했다.

## 검증 범위의 경계

실제 Discord 참여자가 Agent를 멘션·회신하고 제안을 승인해 PR을 만드는 전 과정을 대신 실행하지 않았다. 멘션 정책·신규 문서·승인자·원문 변경·중복·재시도 경로는 합성 테스트로 확인했다. 최초 catch-up에는 반영할 결정이 없어서 실제 제안 게시도 발생하지 않았다.

사람용 DisplayTitle·DisplayContent는 서버와 웹에 구현했고, 예시 두 문서는 private Wiki Draft PR #75로 제안했다. 원래 본문을 보존했으며 파서의 hash·stale=false를 검증했다. Draft PR 병합 전에는 운영 정본에 그 필드가 없다. 로컬 preview는 해당 제안 문서로 화면을 확인한다.

공통 스킬 개선은 harness Draft PR #26에 있다. 진입 지침 토큰을 줄이고 부분 읽기·CAS patch를 안내하지만, 팀원의 설치본은 병합·기존 동기화 절차 뒤 갱신된다. 운영 기능 배포와 원문·공통 스킬 PR 병합을 구분한다.

위키 로그인은 브라우저 1시간, MCP는 최초 GitHub 팀 자격 확인 뒤 최대 24시간의 고정 갱신 범위다. 팀 탈퇴 직후 즉시 철회하는 구조는 아니다. 자세한 경계는 `auth-session-policy.md`를 따른다.

## 측정 자료

고정 원문 평가는 `benchmarks/2026-09-29/`에 JSON·CSV·방법을 보존한다. private 질문·응답·원문 snapshot은 서버의 접근 제한 평가 폴더에 보관했다. 운영 이벤트와 의견은 영속 SQLite volume에 보존하며 원문 이벤트 보관 기간은 90일이다. 장기 비교에 사용할 집계는 웹에서 생성 시각·기간·release·표본 수가 포함된 JSON으로 내보낸다.
