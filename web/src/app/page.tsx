"use client";
import BroadcastTab from "./broadcast";

export default function Home() {
    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50/30">
            <header className="sticky top-0 z-10 flex h-14 items-center border-b border-slate-200/60 bg-white/70 px-6 backdrop-blur-xl">
                <h1 className="text-lg font-bold text-slate-800 tracking-tight">✉️ Gửi tin hàng loạt</h1>
            </header>
            <main className="p-3">
                <BroadcastTab />
            </main>
        </div>
    );
}
