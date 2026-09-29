import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const apiBaseUrl = (process.env.WIKI_API_URL?.trim() || 'http://127.0.0.1:3100').replace(/\/+$/, '');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  turbopack: {
    root: appRoot,
  },
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];
    return [
      { source: '/api/:path*', destination: `${apiBaseUrl}/api/:path*` },
      { source: '/auth/:path*', destination: `${apiBaseUrl}/auth/:path*` },
    ];
  },
};

export default nextConfig;
