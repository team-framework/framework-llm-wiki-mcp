import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { WikiChatApp } from '@/components/wiki-chat';
import { WikiFeedbackWidget } from '@/components/wiki-feedback-widget';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Framework Wiki',
    template: '%s | Framework Wiki',
  },
  description: 'Framework 팀의 지식과 기술 문서를 검색하고 읽는 위키입니다.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ enabled: false }}>
          <WikiChatApp>{children}</WikiChatApp>
          <WikiFeedbackWidget />
        </RootProvider>
      </body>
    </html>
  );
}
