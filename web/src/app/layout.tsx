import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "@/styles/globals.css";
import { cn } from "@/lib/utils";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
    title: "Gửi tin hàng loạt",
    description: "Gửi tin hàng loạt — TALPHA Standalone Module",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" suppressHydrationWarning>
            <body className={cn(inter.className, "bg-background text-foreground antialiased")} suppressHydrationWarning>
                {children}
            </body>
        </html>
    );
}
