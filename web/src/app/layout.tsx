import type { Metadata } from "next";
import { Be_Vietnam_Pro } from "next/font/google";
import "@/styles/globals.css";

// Be Vietnam Pro được thiết kế riêng cho tiếng Việt — dấu không bị chồng hay
// lệch như các phông Latin phổ thông. Giao diện này toàn tiếng Việt nên đây là
// lựa chọn đúng, không phải Inter.
const font = Be_Vietnam_Pro({
    subsets: ["latin", "vietnamese"],
    weight: ["400", "500", "600", "700"],
    display: "swap",
});

export const metadata: Metadata = {
    title: "Bắn bot TALPHA",
    description: "Công cụ vận hành chiến dịch nhắn tin Messenger",
    robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <html lang="vi" suppressHydrationWarning>
            <body className={font.className} suppressHydrationWarning>
                {children}
            </body>
        </html>
    );
}
