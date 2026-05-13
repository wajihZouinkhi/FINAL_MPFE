import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "FINAL_MPFE — Syllabus Agent",
  description:
    "AI-orchestrated syllabus & lesson generator. Watch the agent research, plan, and write — inline.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`dark ${inter.variable} ${jetbrains.variable}`}
    >
      <body className="bg-[var(--background)] text-[var(--foreground)]">
        {children}
        <Toaster
          theme="dark"
          position="top-right"
          richColors
          closeButton
          toastOptions={{
            classNames: {
              toast: "border border-[var(--border)]",
            },
          }}
        />
      </body>
    </html>
  );
}
