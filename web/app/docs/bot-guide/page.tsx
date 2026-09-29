import type { Metadata } from 'next';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { headingId } from '@/lib/links';

export const metadata: Metadata = {
  title: 'Bot 사용법',
  description: 'Discord 논의에서 위키 Agent와 대화하는 방법',
};

const sections = [
  'Discord에서 Agent와 대화하기',
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
        <p>매일 자정(KST)에 <code>innolive</code>, <code>branding</code>, <code>global</code> 카테고리의 채널 대화와 일반 채널의 공개 스레드를 요약 대상으로 수집합니다.</p>
        <p>요약의 최종 결론을 확인하고 위키 PR 생성을 승인할 수 있는 사람은 해당 논의 참여자 누구나입니다.</p>

        <h2 id={headingId(sections[2])}>{sections[2]}</h2>
        <p>Hermes에서 제공하는 <code>/reasoning</code> 명령으로 답변의 추론 수준을 바꿀 수 있습니다. 설정한 수준은 이후 Agent 답변에 적용됩니다.</p>

        <h2 id={headingId(sections[3])}>{sections[3]}</h2>
        <p>위키 화면 상단의 <strong>위키 Agent</strong>를 열고 질문을 입력하세요. 답변 아래에 표시된 문서 출처를 열어 근거를 확인할 수 있습니다.</p>
      </DocsBody>
    </DocsPage>
  );
}
