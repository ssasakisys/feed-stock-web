import "./globals.css";

export const metadata = {
  title: "Feed Stock Gauge",
  description: "酪農家向け飼料在庫管理",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
