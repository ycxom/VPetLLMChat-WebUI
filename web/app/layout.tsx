import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VPetLLM 远端聊天",
  description: "端到端加密的 VPetLLM 远端聊天客户端",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hans">
      <body>{children}</body>
    </html>
  );
}
