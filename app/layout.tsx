export const metadata = {
  title: "J-Quants API backend",
  description: "Minimal Next.js App Router root layout",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
