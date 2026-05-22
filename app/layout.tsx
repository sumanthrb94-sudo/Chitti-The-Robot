import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Chitti — Autonomous AI',
  description:
    'Chitti is a voice-first autonomous AI assistant with live database intelligence. Jarvis-inspired interface.',
  applicationName: 'Chitti',
  keywords: ['AI', 'voice assistant', 'Jarvis', 'autonomous', 'Claude'],
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
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
