import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'cite-guard — answers you can check',
  description:
    'Question answering over your own documents where every sentence is traced back to a verbatim span in a source, and anything that cannot be traced is struck through.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfa' },
    { media: '(prefers-color-scheme: dark)', color: '#0e0e11' },
  ],
};

/**
 * The inline script applies a saved theme before first paint. Without it the
 * page renders in the system theme and then snaps to the chosen one, which is
 * the flash every theme toggle is judged by.
 */
const THEME_BOOTSTRAP = `
try {
  var saved = localStorage.getItem('cite-guard-theme');
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.setAttribute('data-theme', saved);
  }
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
