/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
  webpack: (config, { isServer }) => {
    // Treat .sql files as raw text so we can `import seed from '@/data/seed.sql'`.
    // This guarantees the seed is bundled into serverless functions (Vercel)
    // instead of relying on fragile filesystem tracing.
    config.module.rules.push({
      test: /\.sql$/,
      type: 'asset/source',
    });

    if (isServer) {
      config.externals = [
        ...(config.externals || []),
        { 'better-sqlite3': 'commonjs better-sqlite3' },
      ];
    }
    return config;
  },
};

export default nextConfig;
