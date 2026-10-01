# 팀원용 Framework LLM Wiki 설정

Framework LLM Wiki Plugin은 위키 MCP 연결과 질문·수치 확인·변경안 작성 스킬 3개를 묶은 패키지다. 각 팀원은 자신의 ChatGPT 계정에 ZIP을 등록하고, 데스크톱에서 GitHub 인증을 진행한다.

| 사용할 환경 | 설정 방법 | 사용할 기능 |
| --- | --- | --- |
| ChatGPT 데스크톱의 Work·Codex, Codex 데스크톱 | [Plugin 등록](#1-plugin-등록) | 위키 MCP와 스킬 3개 |
| ChatGPT 웹 | [MCP 직접 등록](#4-chatgpt-웹에서-mcp-직접-등록) | 위키 MCP 도구 |
| Codex CLI·Claude Code | [MCP CLI 등록](#5-codex-cli와-claude-code) | 위키 MCP 도구 |
| 브라우저에서 위키 읽기·변경안 검토 | [Wiki Web](https://framework-wiki.chaeyn.com/docs) | 문서·위키 Agent·Draft PR |

현재 패키지는 원격 MCP를 `mcp.json`에 선언한다. ChatGPT 웹용 등록 앱 매핑인 `.app.json`은 포함하지 않으므로, 웹에서는 4번 절차로 MCP를 연결한다. MCP 직접 등록에는 Plugin의 스킬 3개가 포함되지 않는다.

## 시작 전 준비

- `team-framework` 조직의 활성 GitHub 계정. 역할은 `member` 또는 `admin`이어야 한다. 초대를 받았다면 먼저 수락한다.
- [이 저장소](https://github.com/team-framework/framework-llm-wiki-mcp)를 읽을 권한과 Git·Python 3. 패키징에는 Python 표준 라이브러리만 사용한다.
- Plugin을 실행할 데스크톱 앱과 자신의 ChatGPT 계정. [Plugins](https://chatgpt.com/plugins)에서 **Plugin Creator**를 설치한다.

먼저 [Wiki Web](https://framework-wiki.chaeyn.com/docs)에 같은 GitHub 계정으로 로그인해 문서 접근을 확인한다. 웹 로그인과 MCP OAuth 로그인은 별도 세션이므로, Plugin에서도 인증을 진행한다.

## 1. Plugin 등록

### ZIP 만들기

터미널에서 실행한다. 기존에 복제한 저장소가 있다면 새로 복제하는 대신 해당 폴더의 `main`을 최신 상태로 맞춘다.

```bash
git clone --branch main https://github.com/team-framework/framework-llm-wiki-mcp.git
cd framework-llm-wiki-mcp
python3 scripts/package-plugin.py --output "$HOME/Downloads/framework-llm-wiki.zip"
```

성공하면 출력에 ZIP 경로, Plugin 이름, 버전, 파일 수가 나온다. `Downloads/framework-llm-wiki.zip`을 등록에 사용한다. 저장소 전체를 압축한 ZIP과 구분한다. 서버 실행이나 `npm install`은 필요하지 않다.

### 자신의 계정에 저장

1. Plugin Creator를 사용할 수 있는 새 대화를 연다. 개인 계정에 설치하려면 개인 ChatGPT 공간에서 진행한다.
2. 생성한 ZIP을 첨부하거나, 로컬 파일을 읽을 수 있는 Codex 대화에 ZIP의 전체 경로를 전달한다.
3. **Plugin Creator**를 선택하고 아래와 같이 요청한다.

```text
첨부한 framework-llm-wiki.zip을 내 계정의 비공개 Plugin으로 등록해줘.
기존 plugin.json, mcp.json, 스킬과 이미지를 그대로 사용해.
등록 후 설치할 수 있는 플러그인 링크를 알려줘.
```

4. 반환된 플러그인 링크를 열고, 웹에 **Open in desktop app**이 보이면 눌러 데스크톱에서 설치·활성화한다.
5. 소개 화면에서 MCP 서버 `framework-wiki` 1개와 `wiki-answer`, `wiki-metrics`, `wiki-change` 스킬 3개를 확인한다.

각 팀원은 자신의 계정에 저장된 플러그인 링크를 사용한다. 제작자의 개인 비공개 플러그인 링크는 팀 공용 설치 링크로 배포할 수 없다. 같은 ChatGPT 워크스페이스에서 공유하려면 [관리자 배포](#7-같은-chatgpt-워크스페이스에-배포)를 따른다.

## 2. GitHub 인증과 연결 확인

호스트의 `framework-wiki` 연결 안내에서 OAuth 로그인을 진행한다. 설치 때 인증 창이 열리지 않으면 첫 질문을 보낼 때 나오는 인증 안내를 따른다. GitHub에서는 `team-framework`에 가입한 본인 계정으로 로그인한다.

| 항목 | 값 |
| --- | --- |
| 서버 이름 | `framework-wiki` |
| MCP URL | `https://framework-wiki.chaeyn.com/mcp` |
| 전송 방식 | Streamable HTTP |
| 인증 | GitHub OAuth |
| 개인이 입력할 API key·PAT·서버 환경 변수 | 없음 |

Plugin을 활성화한 새 대화에서 다음 질문을 보낸다.

```text
Framework LLM Wiki의 get_wiki_status를 호출해서 위키 연결 상태와 commit을 확인해줘.
그다음 InnoLive의 현재 구조를 위키 근거와 원문 링크로 설명해줘.
```

도구의 실제 반환값과 답변의 문서 링크를 확인한다. Plugin 목록에 이름이 뜨거나 MCP 토글이 켜진 것만으로 인증과 검색 성공을 판단하지 않는다.

MCP 서버는 다음 읽기 도구 7개를 제공한다.

```text
search_wiki, read_note, get_context, get_note_outline,
read_sections, get_current_metrics, get_wiki_status
```

## 3. 사용 예시

대화에서 `@Framework LLM Wiki`를 선택하거나 **Try now**로 대화를 시작한다. 데스크톱의 Work·Codex 대화에서 사용한다.

| 스킬 | 질문 예시 |
| --- | --- |
| `wiki-answer` | InnoLive의 현재 구조를 위키 근거와 원문 링크로 설명해줘. |
| `wiki-metrics` | 위키에 기록된 현행 수치와 검증 날짜를 확인해줘. |
| `wiki-change` | 이 대화를 위키 변경안으로 정리하고 Wiki Web에서 검토할 수 있게 해줘. |

수치 답변에서 위키에 기록한 값과 현재 시스템을 측정한 값을 구분하고, 검증 날짜와 출처를 함께 확인한다.

문서 변경은 [Wiki Agent](https://framework-wiki.chaeyn.com/chat)에서 `/업데이트`로 요청한다. 변경 전후 내용을 검토한 뒤 **PR 열기**로 Draft PR을 생성하고 팀의 검토·병합 절차를 진행한다. MCP 도구는 읽기 전용이며, `wiki-change`는 검토할 변경안을 작성하고 Wiki Web으로 연결한다.

## 4. ChatGPT 웹에서 MCP 직접 등록

웹에서 MCP 도구를 쓰려면 자신의 계정에 개발자 모드 연결을 만든다. 현재 패키지의 데스크톱 Plugin 설치와 별도 절차다.

1. [ChatGPT](https://chatgpt.com)의 **Settings → Security and login → Developer mode**를 켠다.
2. [Plugins](https://chatgpt.com/plugins)에서 **+**를 눌러 개발자 모드 앱을 만든다.
3. 이름은 `Framework Wiki`, MCP URL은 `https://framework-wiki.chaeyn.com/mcp`, 인증은 **OAuth**로 설정한다. 전송 방식 선택지가 있으면 **Streamable HTTP**를 선택한다.
4. OAuth 등록 방식 선택지가 있으면 **DCR / Dynamic Client Registration**을 선택한다. Client ID·Client Secret을 직접 입력하지 않는다. 서버가 `registration_endpoint`를 제공해 클라이언트를 등록한다.
5. GitHub 인증을 완료하고 앱을 저장한다. 새 대화의 **+ → Developer mode**에서 `Framework Wiki`를 선택한다.
6. 2번 절차의 연결 확인 질문을 보내 실제 도구 응답과 출처를 확인한다.

개발자 모드는 공식 문서 기준 ChatGPT 웹의 Pro·Plus·Business·Enterprise·Education 계정에서 제공한다. 조직의 관리자 정책에 따라 메뉴가 제한될 수 있다. 메뉴 위치와 OAuth 옵션은 호스트 버전에 따라 달라질 수 있으며, [공식 개발자 모드 안내](https://developers.openai.com/api/docs/guides/developer-mode#how-to-use)를 따른다.

## 5. Codex CLI와 Claude Code

CLI에서 MCP 도구만 쓰려면 아래 방식으로 연결한다. 데스크톱 Plugin과 같은 MCP를 중복 등록하면 같은 도구가 두 연결로 표시될 수 있으므로 사용할 연결 하나를 선택한다.

### Codex

```bash
codex mcp add framework-wiki --url https://framework-wiki.chaeyn.com/mcp
codex mcp login framework-wiki
```

브라우저의 GitHub 인증을 완료한 뒤 새 Codex 대화에서 연결 확인 질문을 보낸다. `codex mcp list`로 등록 상태를 확인할 수 있다. 재로그인은 `codex mcp login framework-wiki`, 연결 삭제는 `codex mcp remove framework-wiki`로 진행한다.

### Claude Code

```bash
claude mcp add --scope user --transport http framework-wiki https://framework-wiki.chaeyn.com/mcp
```

`--scope user`는 다른 프로젝트에서도 같은 연결을 사용할 수 있게 한다. Claude Code를 실행하고 `/mcp`에서 `framework-wiki`를 선택해 인증한다. 새 대화에서 연결 확인 질문을 보낸다. 자세한 등록·인증 방법은 [Claude Code MCP 문서](https://code.claude.com/docs/en/mcp)를 따른다.

## 6. 문제 해결과 업데이트

| 증상 | 확인할 내용 |
| --- | --- |
| 저장소를 복제할 수 없음 | GitHub 저장소 읽기 권한과 본인 Git 인증을 확인한다. |
| `Only active team-framework members` 또는 403 | 조직 초대 수락 여부와 로그인한 GitHub 계정의 멤버십을 확인한다. |
| 401 또는 인증 만료 | 사용 중인 호스트의 MCP 연결 화면에서 GitHub OAuth에 다시 로그인한다. |
| Plugin 이름만 보이고 도구 호출이 없음 | Plugin·MCP 서버가 활성화돼 있는지 확인하고, 새 대화에서 `get_wiki_status` 호출을 요청한다. |
| ChatGPT 웹에서 Plugin이 열리지만 도구를 쓸 수 없음 | 데스크톱에서 설치한 패키지는 데스크톱에서 사용한다. 웹 MCP는 4번 절차로 등록한다. |
| 로고 대신 기본 아이콘이 나오거나 화면 미리보기가 없음 | 소개 화면의 이미지 표시와 MCP 인증·도구 호출을 각각 확인한다. 2026-10-01 v0.1.2 저장본에서는 이미지 파일을 등록해도 ChatGPT 웹 소개에 표시되지 않는 현상을 확인했다. [관련 이슈 #42](https://github.com/team-framework/framework-llm-wiki-mcp/issues/42)를 참고한다. |

현재 서버 정책은 GitHub 자격 확인부터 MCP 재로그인 상한을 14일로, 웹 로그인 세션을 1시간으로 둔다. 자세한 만료 기준은 [로그인 재검증 정책](auth-session-policy.md)에 있다.

새 Plugin 버전이 `main`에 병합되면 저장소를 갱신하고 ZIP을 다시 만든다.

```bash
git switch main
git pull --ff-only origin main
python3 scripts/package-plugin.py --output "$HOME/Downloads/framework-llm-wiki.zip"
```

Plugin Creator에 **본인 플러그인의 링크**와 새 ZIP을 함께 전달하고, 해당 플러그인을 업데이트해 달라고 요청한다. 업데이트 후 호스트에서 갱신된 버전을 확인하고 연결 확인 질문을 다시 보낸다. 문서 내용의 갱신은 서버의 정본 위키 동기화를 따르며, Plugin ZIP 교체와 별도로 이루어진다.

## 7. 같은 ChatGPT 워크스페이스에 배포

워크스페이스 관리자는 Plugin을 만든 뒤 [Plugins](https://chatgpt.com/plugins)의 **Personal → 플러그인 메뉴 → Publish**에서 사용할 워크스페이스 역할을 지정할 수 있다. 해당 워크스페이스의 팀원은 관리자가 배포한 Plugin을 설치하고 자신의 GitHub 계정으로 인증한다.

다른 개인 계정의 팀원에게는 1번 절차로 ZIP 등록을 안내한다. 공개 디렉터리 배포는 별도 제출·심사를 거치며, [OpenAI 배포 안내](https://developers.openai.com/plugins/build/plugins#publish-a-local-plugin-to-your-workspace)를 참고한다.

## 설정 근거

- 설치·패키징·워크스페이스 공유: [OpenAI Plugin 문서](https://developers.openai.com/plugins/build/plugins)
- ChatGPT 웹 MCP 등록: [OpenAI 개발자 모드 문서](https://developers.openai.com/api/docs/guides/developer-mode)
- 서버 URL·전송 방식: [Plugin MCP 설정](../plugins/framework-llm-wiki/mcp.json)
- 읽기 도구 7개: [MCP 구현](../src/mcp.ts)
- 조직 자격과 OAuth: [인증 구현](../src/auth.ts), [로그인 정책](auth-session-policy.md)

설치 절차는 2026-10-01의 공식 문서와 저장소 설정을 기준으로 작성했다. 새 팀원 계정에서의 설치·인증 결과는 각 팀원이 2번 절차로 확인한다.
