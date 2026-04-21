const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:4001";

const nextConfig = {
  async rewrites() {
    return [
      // Proxy all /api/* requests to the backend — same-origin, no CORS needed
      {
        source: '/api/:path*',
        destination: `${BACKEND_URL}/api/:path*`,
      },
      // Proxy WebSocket HTTP upgrade path
      {
        source: '/ws/:path*',
        destination: `${BACKEND_URL}/ws/:path*`,
      },
    ];
  },
};

export default nextConfig;

