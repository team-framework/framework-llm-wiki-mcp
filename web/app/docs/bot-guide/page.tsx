import type { Metadata } from 'next';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { headingId } from '@/lib/links';

export const metadata: Metadata = {
  title: 'Bot 사용법',
  description: 'Discord 논의에서 위키 Agent와 대화하는 방법',
};

const sections = [
  'Discord에서 Agent와 대화하기',
  '논의 요약과 위키 제안하기',
  '정기 요약과 위키 반영',
  '추론 수준 조절하기',
  '위키 화면에서 질문하기',
];

export default function BotGuidePage() {
  return (
    <DocsPage toc={sections.map((title) => ({ title, url: `#${headingId(title)}`, depth: 2 }))}>
      <DocsTitle>Bot 사용법</DocsTitle>
      <DocsDescription>Discord에서 논의하고, 팀 위키를 바탕으로 답을 확인하는 방법입니다.</DocsDescription>
      <DocsBody>
        <h2 id={headingId(sections[0])}>{sections[0]}</h2>
        <p>논의 중 Agent의 Discord 계정을 멘션하면 대화에 참여합니다. Agent가 남긴 답글에 회신해도 이어서 답합니다. Agent는 이 두 경우에만 대화에 참여합니다.</p>
        <div className="wiki-guide-callout">
          질문에 필요한 배경과 원하는 결과를 같은 메시지에 적으면 Agent가 논의 흐름에 맞춰 답하기 쉽습니다.
        </div>

        <h2 id={headingId(sections[1])}>{sections[1]}</h2>
        <p>다른 팀원에게 논의를 전달하려면 스레드에서 <code>/스레드-정리</code>를 실행하세요. 위키에 반영할 결론은 대상 채널이나 공개 스레드에서 <code>/위키-제안</code>으로 요청하세요.</p>
        <p>기본 범위는 최근 100개 메시지입니다. <code>개수</code>로 줄이거나 <code>시작</code>·<code>끝</code>에 메시지 ID를 넣어 범위를 선택할 수 있습니다. Discord 개발자 모드를 켜면 메시지 메뉴에서 ID를 복사할 수 있습니다.</p>
        <p>Bot이 원래 논의 공간에 결론과 변경안 파일을 올립니다. 파일에서 읽은 범위, 빠진 정보, 문서 diff와 적용 후 원문을 확인하세요. 첨부파일 본문은 자동으로 읽지 않습니다.</p>
        <ul>
          <li><strong>결론과 변경안 승인</strong>: 표시된 내용으로 위키 Draft PR을 만듭니다.</li>
          <li><strong>결론 수정</strong>: 결론을 고치면 새 변경안을 만듭니다. 새 내용을 다시 확인하고 승인하세요.</li>
          <li><strong>반영하지 않기</strong>: 해당 제안을 취소합니다.</li>
        </ul>
        <p>선택된 범위에서 메시지를 남긴 팀원 누구나 승인할 수 있습니다. 명령 실행자나 관리자라도 해당 논의에 참여하지 않았다면 승인할 수 없습니다. 대화나 대상 문서가 바뀌면 제안을 다시 생성해야 합니다.</p>

        <h2 id={headingId(sections[2])}>{sections[2]}</h2>
        <p>매일 자정(KST)에 <code>innolive</code> 카테고리의 일반 채널, <code>branding</code> 채널·포럼, <code>global</code> 채널과 이들의 공개 스레드를 확인합니다. 이전에 저장한 범위 이후의 메시지를 처리하고, 첫 실행은 최근 자정 이전 24시간을 확인합니다.</p>
        <p>대화가 길면 범위를 나눠 남은 메시지를 다음 실행에 처리합니다. 기술 결정이나 새 사실이 없으면 변경안을 만들지 않습니다. 비공개 스레드와 DM은 이 수집 범위에 포함하지 않습니다.</p>
        <p>정기 요약도 사람이 결론과 변경안을 승인해야 Draft PR을 만듭니다. 팀원이 PR을 검토·병합하고 서버가 동기화한 뒤 웹과 MCP 검색에 반영됩니다.</p>

        <h2 id={headingId(sections[3])}>{sections[3]}</h2>
        <p>Discord에서는 Hermes의 <code>/reasoning</code> 명령에서 추론 수준을 선택합니다. 웹 챗봇에서는 질문 입력창 위의 선택 메뉴를 사용하세요. 기본값은 <code>low</code>입니다.</p>

        <h2 id={headingId(sections[4])}>{sections[4]}</h2>
        <p>팀 GitHub 계정으로 로그인하고 <strong>위키 Agent</strong>를 열어 질문하세요. 답변의 문서 출처를 열어 근거를 확인할 수 있습니다. 수정 요청에는 변경할 내용과 이유를 제안하며, 웹 챗봇이 원문을 직접 수정하지는 않습니다.</p>
      </DocsBody>
    </DocsPage>
  );
}
