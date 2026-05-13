const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@mpfe/shared"],
  typedRoutes: false,
  // Standalone output bundles a minimal Node server + only the needed
  // node_modules into .next/standalone so the Docker runtime layer can be
  // small. outputFileTracingRoot points at the monorepo root so the tracer
  // includes the workspace-linked @mpfe/shared package.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../../"),
};
module.exports = nextConfig;
