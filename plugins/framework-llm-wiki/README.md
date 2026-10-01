# Framework LLM Wiki Plugin

기존 Wiki MCP와 Wiki Web을 연결하는 비공개 플러그인입니다.

팀원은 [설치·GitHub 인증·사용 안내](https://github.com/team-framework/framework-llm-wiki-mcp/blob/main/docs/team-setup.md)를 따라 자신의 계정에 등록할 수 있습니다.

## 사용

플러그인을 설치하고 호스트의 연결 화면에서 팀 GitHub 계정으로 로그인합니다. `team-framework`의 활성 Member 또는 admin이 사용할 수 있습니다. OAuth 인증 정보는 호스트와 기존 서버가 관리합니다.

| 스킬 | 실행할 작업 |
| --- | --- |
| `wiki-answer` | 필요한 원문 섹션을 읽고 검증 상태와 출처 링크로 답변 |
| `wiki-metrics` | 위키에 기록된 수치·날짜와 마운트된 위키 commit 확인 |
| `wiki-change` | 검토할 문서 변경안 작성 및 Wiki Web의 Draft PR 흐름 안내 |

기존 MCP의 7개 도구를 유지합니다. 섹션 조회 스킬은 작은 근거 예산에서 시작하며, 부족할 때만 범위를 늘립니다. 정본 Markdown과 기존 GitHub OAuth 서버를 사용합니다.

- [문서 목록](https://framework-wiki.chaeyn.com/docs)
- [Wiki Agent](https://framework-wiki.chaeyn.com/chat)
- [사용법](https://framework-wiki.chaeyn.com/docs/bot-guide)

문서 링크는 Wiki Web의 `/docs/<구간별로 인코딩한 경로>.md` 규칙을 사용합니다. 별도 MCP App 화면은 포함하지 않습니다. Wiki Web에서 문서를 읽고 변경안을 검토할 수 있습니다.

## 패키징

저장소 루트에서 실행합니다.

```bash
python3 scripts/package-plugin.py --output /tmp/framework-llm-wiki-0.1.1.zip
```

ZIP은 플러그인 디렉터리 밖에 생성합니다. manifest, 스킬 이름, 아이콘 경로, 허용 파일, symlink, 인증 정보 포함 여부를 검사한 뒤 패키징합니다. 생성한 ZIP을 Plugin Creator의 `create_plugin`에 전달해 계정에 저장할 수 있습니다. 이후에는 저장된 정확한 plugin ID와 current release ID로 `update_plugin`을 사용합니다.
