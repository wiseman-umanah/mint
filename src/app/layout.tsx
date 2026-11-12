import type { Metadata } from "next";
import localFont from "next/font/local";
import "remixicon/fonts/remixicon.css";
import "./globals.css";

const creato = localFont({
  variable: "--font-creato",
  display: "swap",
  src: [
    { path: "./fonts/CreatoDisplay-Regular.otf", weight: "400", style: "normal" },
    { path: "./fonts/CreatoDisplay-Medium.otf", weight: "500", style: "normal" },
    { path: "./fonts/CreatoDisplay-Bold.otf", weight: "700", style: "normal" },
  ],
});

const machina = localFont({
  variable: "--font-machina",
  display: "swap",
  src: [
    { path: "./fonts/NeueMachina-Regular.otf", weight: "400", style: "normal" },
    { path: "./fonts/NeueMachina-Ultrabold.otf", weight: "800", style: "normal" },
  ],
});

export const metadata: Metadata = {
  title: "MINT",
  description: "AI-guarded payments and trading on Stellar.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${creato.variable} ${machina.variable}`}>
      <body>{children}</body>
    </html>
  );
}
