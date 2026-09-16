import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Documents are held in memory only; keep request bodies well under the
    // 4.5 MB Vercel serverless limit. See src/lib/limits.ts for the hard cap.
    serverActions: { bodySizeLimit: '2mb' },
  },
};

export default nextConfig;
