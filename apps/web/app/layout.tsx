export const metadata = { title: "Washa", description: "Battery, sasa hivi." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#0b0b0b", color: "#f2f2f2" }}>{children}</body>
    </html>
  );
}
