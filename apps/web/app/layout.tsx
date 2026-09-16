import type { Metadata, Viewport } from 'next';
import type { ReactElement, ReactNode } from 'react';
import { Manrope } from 'next/font/google';
import { Providers } from '@/components/providers';
import './globals.css';

const manrope = Manrope({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-ui',
});

export const metadata: Metadata = {
  title: 'Цветок CRM',
  description: 'Внутренняя CRM/ERP-система цветочного магазина',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Do not set maximumScale / userScalable=false — accessibility over lock-zoom.
};

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="ru">
      <body className={`${manrope.variable} min-h-screen font-sans`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
