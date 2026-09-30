# Wiki Agent 문서 변경 PR

채팅에서 `/업데이트`를 보내면 최근 대화와 현재 문서를 바탕으로 생성·수정·삭제 변경안을 만든다. 문서별 변경 전후 내용을 펼쳐 확인하고 `PR 열기`를 누르면 Framework Bot이 정본 위키 저장소에 커밋하고 Draft PR을 연다. 팀원이 검토·병합한 뒤 정본 동기화로 위키에 반영한다.

```text
/업데이트 기술/연결.md의 연결 해제 설명을 방금 확인한 내용으로 수정해
/업데이트 기획/온보딩.md를 새로 만들고 방금 합의한 사용자 흐름을 정리해
/업데이트 사건기록/옛안내.md를 삭제해. 현재 운영 안내와 중복돼
```

명령만 보내면 최근 사용자 메시지를 참고한다. 대상이 불분명하면 추가 정보를 묻는다. 이전 변경안의 내용도 후속 요청의 문맥에 포함하며, PR 생성 상태와 병합 여부를 구분한다. 요청한 팀원만 해당 변경안의 PR을 열 수 있고, 팀원은 공유 대화에서 변경안과 생성된 PR을 확인할 수 있다.

## 변경 검증

생성·수정·삭제는 Markdown 문서에만 적용한다. 숨김 경로, 경로 이탈, 에이전트 지침 파일, 중복 경로, 비어 있는 본문, 잘못된 YAML을 거부한다. 수정·삭제는 모델에 전체 원문을 제공한 문서로 제한한다. 삭제 요청이 없는 대화에서는 삭제 변경안을 거부한다.

PR 생성 전에 GitHub 기본 브랜치의 대상 문서 hash를 확인한다. 다른 팀원이 원본을 수정하거나 같은 경로에 문서를 만들면 새 변경안을 요청한다. 고정된 제안 브랜치와 PR 표식을 사용하며, GitHub 응답 유실·재시작 뒤에도 기존 PR과 변경 내용을 검증하고 재사용한다. 삭제는 Git tree의 `sha: null`로 처리한다.

Bot은 GitHub App JWT로 저장소 하나에 한정한 Contents write·Pull requests write 설치 토큰을 받는다. 기존 Framework Bot의 GitHub 계정은 `framework-harness-sync[bot]`이다. App slug와 Bot 신원을 확인하고 커밋 author·committer에도 해당 Bot을 지정한다. 개인 토큰 fallback은 제공하지 않는다. [GitHub App 인증 문서](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app), [설치 토큰 문서](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)

OpenAI 디자인의 기존 흑백 색상·작은 모서리·타이포그래피를 사용한다. 문서 동작은 생성·수정·삭제로 표시하고, 변경 전후 원문과 Draft PR 버튼을 채팅 안에 둔다. 좁은 화면에서도 문서 경로를 줄바꿈하고 원문을 스크롤해 확인할 수 있다. 운영 설정은 [운영 문서](./operations.md)의 웹 Wiki Agent 문서 PR 항목을 따른다.

## 2026-09-30 검증

- API·MCP·문서 관련 테스트 80개 통과. 업데이트 전용 테스트 11개는 생성·수정·삭제, JWT·Bot 신원, 작성자 권한, CSRF, 서비스 key 거부, 원본 충돌, 응답 유실, 중복 발행, 재시작·저장 복원, 후속 변경안 문맥을 확인했다.
- API 타입 검사·빌드, 웹 타입 검사·배포용 빌드 통과. 기본 Compose와 Bot key mount override의 구성을 `.env.example`로 검증했다.
- 실제 배포용 웹과 API를 연결한 Playwright 검증 통과. 1440×1000 데스크톱, 390×844 모바일, 명령 버튼, 세 가지 문서 동작, 변경 전후 원문, PR 생성, 새로고침 후 복원, 원본 충돌, 생성 경로 충돌 안내를 확인했다. 브라우저 페이지 오류는 0개였다. 이 검증의 모델·GitHub 응답은 합성 fixture다.
- 별도 임시 API 인스턴스에서 실제 Hermes `gpt-6-luna`로 합성 문서 변경안을 생성하고, 실제 Bot으로 [검증 PR #81](https://github.com/team-framework/framework-llm-wiki/pull/81)을 열었다. GitHub에서 PR 작성자와 커밋 author·committer가 `framework-harness-sync[bot]`인지 확인했다. 재시도·앱 재시작 후 동일 PR 반환을 확인했다. PR은 병합하지 않고 닫았으며 테스트 브랜치를 삭제했다. 실제 GitHub 검증은 문서 생성에 한정하고 수정·삭제는 API·UI fixture로 확인했다.

재실행:

```bash
npm ci
npm --prefix web ci
npm run check
npm test
npm run build
npm --prefix web run check
# Playwright Chromium을 설치한 환경
npx playwright install chromium
npm run test:ui
# macOS 등 기존 Chrome을 사용하는 환경
WIKI_TEST_BROWSER_CHANNEL=chrome npm run test:ui
```

UI 테스트는 임시 문서·채팅 DB와 합성 Bot을 사용하며 loopback에서 실행한다. 결과 화면은 `test-results/wiki-update-ui/`에 저장하고 Git에서 제외한다. 검증 중 운영 설정이나 서비스를 변경하지 않았다. 운영 적용에는 구현 PR 병합, Bot 환경 설정, key mount 활성화, 재배포가 필요하다.
