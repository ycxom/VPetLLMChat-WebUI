import type { NextConfig } from "next";

// 纯浏览器端应用：静态导出为 out/，可由 Go relay 用 embed 直接托管，
// 目标服务器无需 Node。安全响应头（CSP 等）改由托管方（Go relay 或反向代理）下发，
// 因为 next 的 headers() 在 output:"export" 下不生效。
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default nextConfig;
