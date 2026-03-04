import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  webpack: (config, { isServer }) => {
    // Add encoding to externals to prevent "Module not found: Can't resolve 'encoding'" warning
    // This is often needed for SDKs that have Node.js specific dependencies.
    if (!isServer) {
      // For client-side bundles, if encoding is truly not needed or polyfilled elsewhere.
      // config.resolve.fallback = { ...config.resolve.fallback, encoding: false };
    } else {
      // For server-side bundles, treat it as external.
      config.externals.push('encoding');
    }
    return config;
  },
};

export default nextConfig;
