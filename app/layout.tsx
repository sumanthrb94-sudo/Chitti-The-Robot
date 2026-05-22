import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono, Orbitron } from 'next/font/google';

import './globals.css';

/*
 * next/font/google downloads these once at BUILD time and self-hosts them
 * from the same origin. No runtime CDN dependency on fonts.googleapis.com,
 * no privacy leak to Google on every page load.
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

const orbitron = Orbitron({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-display',
  weight: ['400', '500', '700', '900'],
});

export const metadata: Metadata = {
  title: 'Chitti — Autonomous AI',
  description:
    'Chitti is a voice-first autonomous AI assistant with live database intelligence. Jarvis-inspired interface.',
  applicationName: 'Chitti',
  keywords: ['AI', 'voice assistant', 'Jarvis', 'autonomous', 'open-source'],
};

export const viewport: Viewport = {
  themeColor: '#02060c',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${orbitron.variable}`}
    >
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
