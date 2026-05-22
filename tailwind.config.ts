import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        chitti: {
          // Jarvis-inspired cyan/blue palette
          50:  '#e6fbff',
          100: '#b3f1ff',
          200: '#80e7ff',
          300: '#4ddcff',
          400: '#1ad2ff',
          500: '#00b8e6',
          600: '#0090b3',
          700: '#006880',
          800: '#00404d',
          900: '#00181f',
        },
        signal: {
          // Accent for alerts/state
          red:    '#ff3860',
          amber:  '#ffb020',
          green:  '#00e5a8',
          violet: '#9b6bff',
        },
      },
      fontFamily: {
        // Resolved at runtime to next/font-injected CSS variables
        // (set on <html> in app/layout.tsx). Self-hosted, no CDN.
        display: ['var(--font-display)', '"Orbitron"', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
        sans: ['var(--font-sans)', '"Inter"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 24px rgba(0, 184, 230, 0.45)',
        'glow-lg': '0 0 60px rgba(0, 184, 230, 0.55)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 12s linear infinite',
        'spin-reverse': 'spin 8s linear infinite reverse',
        'orb-breathe': 'orbBreathe 4s ease-in-out infinite',
        'scan': 'scan 3s linear infinite',
        'scan-slow': 'scan 8s linear infinite',
        'flicker': 'flicker 1.8s linear infinite',
        'radiate': 'radiate 1.8s ease-out infinite',
        'tick-fade': 'tickFade 0.6s ease-out forwards',
      },
      keyframes: {
        orbBreathe: {
          '0%, 100%': { transform: 'scale(1)', filter: 'brightness(1)' },
          '50%':      { transform: 'scale(1.04)', filter: 'brightness(1.15)' },
        },
        scan: {
          '0%':   { transform: 'translateY(-100%)', opacity: '0' },
          '50%':  { opacity: '1' },
          '100%': { transform: 'translateY(100%)', opacity: '0' },
        },
        flicker: {
          '0%, 100%': { opacity: '1' },
          '7%':       { opacity: '0.55' },
          '9%':       { opacity: '1' },
          '53%':      { opacity: '1' },
          '55%':      { opacity: '0.4' },
          '57%':      { opacity: '1' },
        },
        radiate: {
          '0%':   { transform: 'scale(0.7)', opacity: '0.65' },
          '100%': { transform: 'scale(1.9)', opacity: '0' },
        },
        tickFade: {
          '0%':   { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
