"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    Send, Users, RefreshCw, CheckCircle2, XCircle, Loader2,
    ChevronDown, Search, CheckSquare, Square, MessageSquare,
    AlertTriangle, ShoppingBag, Phone, ExternalLink, ImagePlus, X,
    Clock, Timer, CalendarClock, Filter, Pencil
} from "lucide-react";

// ─── Timezone mapping ─────────────────────────────────────────────────────────
const SHOP_TIMEZONES: Record<string, { offset: number; label: string; flag: string }> = {
    "Saudi": { offset: 3, label: "Riyadh", flag: "🇸🇦" },
    "UAE": { offset: 4, label: "Dubai", flag: "🇦🇪" },
    "Kuwait": { offset: 3, label: "Kuwait City", flag: "🇰🇼" },
    "Oman": { offset: 4, label: "Muscat", flag: "🇴🇲" },
    "Qatar": { offset: 3, label: "Doha", flag: "🇶🇦" },
    "Bahrain": { offset: 3, label: "Manama", flag: "🇧🇭" },
    "Japan": { offset: 9, label: "Tokyo", flag: "🇯🇵" },
    "Taiwan": { offset: 8, label: "Taipei", flag: "🇹🇼" },
};

const SCHEDULE_HOURS = [6, 11, 17, 21];
const SCHEDULE_LABELS: Record<number, string> = {
    6: "🌅 Sáng sớm",
    11: "☀️ Trưa",
    17: "🌆 Chiều",
    21: "🌙 Tối",
};

function getNextScheduleTime(hour: number, utcOffset: number): Date {
    const now = new Date();
    // Current time in target timezone
    const targetNow = new Date(now.getTime() + utcOffset * 3600000 + now.getTimezoneOffset() * 60000);
    // Target time today in target timezone
    const target = new Date(targetNow);
    target.setHours(hour, 0, 0, 0);
    // If time already passed today, schedule for tomorrow
    if (target <= targetNow) {
        target.setDate(target.getDate() + 1);
    }
    // Convert back to local time
    const diff = target.getTime() - targetNow.getTime();
    return new Date(now.getTime() + diff);
}

function formatCountdown(ms: number): string {
    if (ms <= 0) return "00:00:00";
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function getCurrentTimeInTimezone(utcOffset: number): string {
    const now = new Date();
    const target = new Date(now.getTime() + utcOffset * 3600000 + now.getTimezoneOffset() * 60000);
    return target.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface Shop {
    name: string;
    shop_id: string;
}

interface PageInfo {
    pageId: string;
    name: string;
    platform: string;
    source?: string;
    shopName?: string;
}

interface Customer {
    id: string;
    customerName: string;
    customerPhone: string;
    fbId: string;
    psid: string;
    pageFbId: string;
    customerId: string;
    conversationLink: string;
    orderCount: number;
    messageCount: number;
    snippet: string;
    tags: string[] | number[];
    address: string;
    updatedAt: string;
    lastInteraction: string;
    source: "crm" | "pos";
}

interface SendResult {
    psid: string;
    name: string;
    success: boolean;
    error?: string;
    via?: 'pancake' | 'fb_graph_api';
}

// ─── Schedule types (synced with BigQuery via API) ───────────────────────────
type SegmentStatus = 'pending' | 'sending' | 'sent' | 'error';

interface ScheduleSegment {
    segIdx: number;   // 0-3
    hour: number;     // 6, 11, 17, 21
    message: string;
    media?: string[];
    status?: SegmentStatus;
    error?: string;
    sentAt?: string;
    totalRecipients?: number;
    successCount?: number;
    errorCount?: number;
}

interface BroadcastSchedule {
    id: string;
    shopId: string;
    shopName: string;
    pageId: string;
    pageName: string;
    hour: number;
    messages: string[];
    segments?: ScheduleSegment[];
    filterPurchase: string;
    filterTimeRange: string;
    isActive: boolean;
    createdAt: string;
    lastFiredAt: string | null;
    nextFireAt: string | null;
    note?: string;
    lastSegmentIndex?: number;
    lastRunDate?: string;
    firedDates?: string[];
    recipientCount?: number;
}

// ─── API helpers (thay thế localStorage) ─────────────────────────────────────
async function fetchSchedulesFromAPI(): Promise<BroadcastSchedule[]> {
    try {
        const res = await fetch('/api/broadcast/schedule');
        const data = await res.json();
        return data.schedules || [];
    } catch (err) {
        console.error('[broadcast] fetchSchedules error:', err);
        return [];
    }
}

async function saveScheduleToAPI(schedule: BroadcastSchedule): Promise<boolean> {
    try {
        const res = await fetch('/api/broadcast/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'save', schedule }),
        });
        return res.ok;
    } catch { return false; }
}

async function deleteScheduleFromAPI(scheduleId: string): Promise<boolean> {
    try {
        const res = await fetch('/api/broadcast/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', scheduleId }),
        });
        return res.ok;
    } catch { return false; }
}

async function toggleScheduleAPI(scheduleId: string): Promise<boolean> {
    try {
        const res = await fetch('/api/broadcast/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'toggle', scheduleId }),
        });
        return res.ok;
    } catch { return false; }
}

async function saveNoteAPI(scheduleId: string, note: string): Promise<boolean> {
    try {
        const res = await fetch('/api/broadcast/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'save_note', scheduleId, note }),
        });
        return res.ok;
    } catch { return false; }
}

function calcNextFireAt(hour: number, utcOffset: number): string {
    return getNextScheduleTime(hour, utcOffset).toISOString();
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function BroadcastTab() {
    const [shops, setShops] = useState<Shop[]>([]);
    const [selectedShopId, setSelectedShopId] = useState("");
    const [pages, setPages] = useState<PageInfo[]>([]);
    const [selectedPageId, setSelectedPageId] = useState("");
    const [isLoadingPages, setIsLoadingPages] = useState(false);
    const [customers, setCustomers] = useState<Customer[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [msg1, setMsg1] = useState("");
    const [msg2, setMsg2] = useState("");
    const [msg3, setMsg3] = useState("");
    const [msg4, setMsg4] = useState("");
    const [media1, setMedia1] = useState<string[]>([]);
    const [media2, setMedia2] = useState<string[]>([]);
    const [media3, setMedia3] = useState<string[]>([]);
    const [media4, setMedia4] = useState<string[]>([]);
    // Schedule states
    const [scheduledHour, setScheduledHour] = useState<number | null>(null);
    const [scheduleFireTime, setScheduleFireTime] = useState<Date | null>(null);
    const [countdown, setCountdown] = useState("");
    const [isPaused, setIsPaused] = useState(false);
    const [remainingMs, setRemainingMs] = useState(0);
    const scheduleTimerRef = useRef<NodeJS.Timeout | null>(null);
    const countdownRef = useRef<NodeJS.Timeout | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const [isLoadingShops, setIsLoadingShops] = useState(true);
    const [isLoadingCustomers, setIsLoadingCustomers] = useState(false);
    const [isSending, setIsSending] = useState(false);
    const [sendResults, setSendResults] = useState<SendResult[] | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [totalCustomers, setTotalCustomers] = useState(0);
    const [totalPages, setTotalPages] = useState(1);

    // Filter states
    const [filterPurchase, setFilterPurchase] = useState<'all' | 'no_purchase' | 'has_purchase'>('all');
    const [filterTimeRange, setFilterTimeRange] = useState<'all' | '24h' | '7d' | '30d' | '90d'>('all');
    const [filterGender, setFilterGender] = useState<'all' | 'male' | 'female'>('all');
    const [filterActive, setFilterActive] = useState(false);
    const [pageSearch, setPageSearch] = useState("");
    const [isPageDropdownOpen, setIsPageDropdownOpen] = useState(false);
    const [visibleCount, setVisibleCount] = useState(100);

    // ─── Schedule states ──────────────────────────────────────────────────────
    const [schedules, setSchedules] = useState<BroadcastSchedule[]>([]);
    const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
    const [editNote, setEditNote] = useState("");
    const [scheduleToast, setScheduleToast] = useState<string | null>(null);
    const sendingRef = useRef<Set<string>>(new Set());
    const [showSchedulePreview, setShowSchedulePreview] = useState(false);
    const [scheduledSegments, setScheduledSegments] = useState<Set<number>>(new Set());
    const [isGlobalPaused, setIsGlobalPaused] = useState(false);
    const [isLoadingSchedules, setIsLoadingSchedules] = useState(false);

    const toggleGlobalPause = () => {
        // Global pause: toggle isActive for ALL schedules via API
        setIsGlobalPaused(prev => {
            const next = !prev;
            setScheduleToast(next ? "⛔ Đã TẠM DỮNG tất cả lịch bắn bot" : "✅ Đã BẬT LẠI lịch bắn bot");
            setTimeout(() => setScheduleToast(null), 3000);
            // Toggle all schedules
            schedules.forEach(s => {
                if (next && s.isActive) toggleScheduleAPI(s.id);
                if (!next && !s.isActive) toggleScheduleAPI(s.id);
            });
            refreshSchedules();
            return next;
        });
    };

    // ─── Load schedules from BigQuery API on mount ────────────────────────────
    const refreshSchedules = useCallback(async () => {
        setIsLoadingSchedules(true);
        const list = await fetchSchedulesFromAPI();
        setSchedules(list);
        setIsLoadingSchedules(false);
    }, []);

    useEffect(() => { refreshSchedules(); }, [refreshSchedules]);

    // ─── Auto-refresh schedules every 60s to see cron updates ─────────────────
    useEffect(() => {
        const interval = setInterval(() => {
            fetchSchedulesFromAPI().then(list => setSchedules(list));
        }, 60_000);
        return () => clearInterval(interval);
    }, []);

    // ✅ Auto-fire giờ chạy trên SERVER qua Vercel Cron (/api/broadcast/cron)
    // Client chỉ polling để hiển thị trạng thái — KHÔNG cần giữ tab mở nữa!

    // Load shops
    useEffect(() => {
        fetch("/api/broadcast")
            .then((r) => r.json())
            .then((data) => { if (data.shops) setShops(data.shops); })
            .catch(console.error)
            .finally(() => setIsLoadingShops(false));
    }, []);

    // Load pages when shop changes (or ALL pages when no shop)
    const loadPages = useCallback(async (shopId: string) => {
        setIsLoadingPages(true);
        setPages([]);
        setSelectedPageId("");
        setCustomers([]);
        setSendResults(null);

        try {
            // If no shopId → fetch pages from ALL shops
            const url = shopId
                ? `/api/broadcast?shopId=${shopId}&getPages=true`
                : `/api/broadcast?getPages=true`;
            const res = await fetch(url);
            const data = await res.json();
            if (data.pages) {
                setPages(data.pages);
            }
        } catch (err) {
            console.error("Load pages error:", err);
        } finally {
            setIsLoadingPages(false);
        }
    }, []);

    // Auto-load ALL pages on mount (TH2: không cần chọn shop)
    useEffect(() => {
        loadPages("");
    }, [loadPages]);

    // CRM warning state
    const [crmWarning, setCrmWarning] = useState<string | null>(null);

    // Load customers (with optional page filter)
    const loadCustomers = useCallback(async (shopId: string, page = 1, pageFilter = "") => {
        if (!shopId && !pageFilter) return; // cho phép không chọn shop nếu có pageFilter
        setIsLoadingCustomers(true);
        setSelectedIds(new Set());
        setSendResults(null);
        setCrmWarning(null);

        try {
            let url = `/api/broadcast?page=${page}`;
            if (shopId) url += `&shopId=${shopId}`;
            if (pageFilter) url += `&pageFilter=${encodeURIComponent(pageFilter)}`;

            const res = await fetch(url);
            const data = await res.json();

            if (data.customers) {
                setCustomers(data.customers);
                setTotalCustomers(data.total || data.customers.length);
                setTotalPages(data.totalPages || 1);
                setCurrentPage(data.page || page);
                // Show CRM warning if present
                if (data.crmWarning) {
                    setCrmWarning(data.crmWarning);
                }
            } else if (data.error) {
                console.error("Load customers error:", data.error);
                setCustomers([]);
            }
        } catch (err) {
            console.error("Load customers error:", err);
            setCustomers([]);
        } finally {
            setIsLoadingCustomers(false);
        }
    }, []);

    // Toggle selection
    const toggleSelect = (id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    // ─── Purchase tag detection ─────────────────────────────────────
    // Tags liên quan đến đã mua/đã gửi hàng (check cả string và lowercase)
    const PURCHASE_TAGS = ['đã gửi', 'đã nhận', 'da gui', 'da nhan', 'mua hàng', 'mua hang', 'đã mua', 'da mua', 'shipped', 'delivered', 'đã gửi hàng', 'đã chốt', 'da chot', 'chốt đơn', 'chot don'];
    const hasPurchaseTag = (c: Customer): boolean => {
        const tagStr = (c.tags || []).map(t => String(t).toLowerCase()).join(' ');
        return PURCHASE_TAGS.some(pt => tagStr.includes(pt));
    };
    const isPurchasedCustomer = (c: Customer): boolean => {
        return !!c.customerPhone || c.orderCount > 0 || hasPurchaseTag(c);
    };

    // ─── Filter logic ─────────────────────────────────────────────
    const filteredCustomers = useMemo(() => {
        let result = customers;

        // ═══ LUÔN loại khách tương tác trong vòng 24h (tránh bắn dồn dập) ═══
        const now24h = Date.now();
        const cutoff24h = now24h - 86400000; // 24h ago
        const before24hFilter = result.length;
        result = result.filter(c => {
            const t = new Date(c.lastInteraction || c.updatedAt).getTime();
            return t < cutoff24h; // chỉ giữ khách tương tác > 24h trước
        });
        if (result.length !== before24hFilter) {
            console.log(`[filter] Loại ${before24hFilter - result.length} khách tương tác trong 24h (còn ${result.length})`);
        }

        // ═══ LUÔN áp dụng purchase filter (không cần filterActive) ═══
        if (filterPurchase === 'no_purchase') {
            // Chưa mua = KHÔNG có SĐT VÀ orderCount = 0 VÀ KHÔNG có tag mua hàng
            result = result.filter(c => !isPurchasedCustomer(c));
        } else if (filterPurchase === 'has_purchase') {
            // Đã mua = có SĐT HOẶC có orderCount > 0 HOẶC có tag mua hàng
            result = result.filter(c => isPurchasedCustomer(c));
        }

        // Các filter khác chỉ áp dụng khi filterActive
        if (!filterActive && filterPurchase === 'all') return result;

        // Time range filter (optional, thêm lọc theo khoảng thời gian)
        if (filterTimeRange !== 'all') {
            const now = Date.now();
            const msMap: Record<string, number> = { '24h': 86400000, '7d': 604800000, '30d': 2592000000, '90d': 7776000000 };
            const cutoff = now - (msMap[filterTimeRange] || 0);
            result = result.filter(c => {
                const t = new Date(c.lastInteraction || c.updatedAt).getTime();
                return t >= cutoff;
            });
        }

        // Gender filter (heuristic by name)
        if (filterGender !== 'all') {
            result = result.filter(c => {
                const name = c.customerName.toLowerCase();
                if (filterGender === 'female') {
                    return /^(chị|chi|ms|mrs|miss|cô|co|em gái|nữ|nu|bà|ba|madam)/i.test(name) || /\b(nữ|nu|chị|chi)\b/i.test(name);
                }
                return /^(anh|mr|ông|ong|bro|bác|bac)/i.test(name) || /\b(anh|nam)\b/i.test(name);
            });
        }

        return result;
    }, [customers, filterPurchase, filterTimeRange, filterGender, filterActive]);

    // ═══ 24h WINDOW STATS: tính số khách trong/ngoài 24h ═══
    const windowStats = useMemo(() => {
        const now = Date.now();
        const cutoff24h = now - 86400000; // 24h ago
        let within = 0;
        let outside = 0;
        const selectedCustomers = customers.filter(c => selectedIds.has(c.id));
        for (const c of selectedCustomers) {
            const t = new Date(c.lastInteraction || c.updatedAt).getTime();
            if (t >= cutoff24h) within++;
            else outside++;
        }
        return { within, outside, total: selectedCustomers.length };
    }, [customers, selectedIds]);

    const selectOnly24h = () => {
        const now = Date.now();
        const cutoff24h = now - 86400000;
        const ids = new Set(
            filteredCustomers
                .filter(c => {
                    const t = new Date(c.lastInteraction || c.updatedAt).getTime();
                    return t >= cutoff24h;
                })
                .map(c => c.id)
        );
        setSelectedIds(ids);
    };

    const toggleSelectAll = () => {
        // ═══ FIX: Select All chỉ chọn filteredCustomers, không phải tất cả ═══
        if (selectedIds.size === filteredCustomers.length && filteredCustomers.length > 0) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(filteredCustomers.map((c) => c.id)));
        }
    };

    // Combine 4 message boxes
    const messages = [msg1, msg2, msg3, msg4];
    const mediaArrays = [media1, media2, media3, media4];
    const setMediaArrays = [setMedia1, setMedia2, setMedia3, setMedia4];
    const setMessages = [setMsg1, setMsg2, setMsg3, setMsg4];
    const totalMediaCount = media1.length + media2.length + media3.length + media4.length;

    // Handle multi-media upload per box
    const handleMediaUpload = (boxIdx: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        const setter = setMediaArrays[boxIdx];
        Array.from(files).forEach(file => {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const dataUrl = ev.target?.result as string;
                setter(prev => [...prev, dataUrl]);
            };
            reader.readAsDataURL(file);
        });
        // Reset input so same file can be re-selected
        e.target.value = '';
    };

    const removeMedia = (boxIdx: number, mediaIdx: number) => {
        setMediaArrays[boxIdx](prev => prev.filter((_, i) => i !== mediaIdx));
    };

    // Get shop timezone (derived from selected page's shopName)
    const selectedPage = pages.find(p => p.pageId === selectedPageId);
    const shopName = selectedPage?.shopName || shops.find(s => s.shop_id === selectedShopId)?.name || "";
    const shopTz = SHOP_TIMEZONES[shopName] || { offset: 3, label: "UTC+3", flag: "🌍" };

    // ─── Schedule actions ────────────────────────────────────────────────────
    const handleSchedule = (hour: number) => {
        if (!selectedPageId) {
            setScheduleToast("⚠️ Chọn Page trước!");
            setTimeout(() => setScheduleToast(null), 3000);
            return;
        }
        const hasContent = messages.some(m => m.trim()) || mediaArrays.some(a => a.length > 0);
        if (!hasContent) {
            setScheduleToast("⚠️ Nhập ít nhất 1 tin nhắn trước!");
            setTimeout(() => setScheduleToast(null), 3000);
            return;
        }
        const pageName = pages.find(p => p.pageId === selectedPageId)?.name || selectedPageId;
        const existing = schedules.find(s => s.shopId === selectedShopId && s.pageId === selectedPageId);
        const tz = shopTz.offset;
        const entry: BroadcastSchedule = {
            id: existing?.id || `${selectedShopId}_${selectedPageId}_${Date.now()}`,
            shopId: selectedShopId,
            shopName: shopName,
            pageId: selectedPageId,
            pageName,
            hour,
            messages: messages.map(m => m.trim()),
            filterPurchase,
            filterTimeRange,
            isActive: true,
            createdAt: existing?.createdAt || new Date().toISOString(),
            lastFiredAt: existing?.lastFiredAt || null,
            nextFireAt: calcNextFireAt(hour, tz),
            note: existing?.note,
        };
        saveScheduleToAPI(entry).then(ok => {
            if (ok) {
                refreshSchedules();
                setScheduleToast(`✅ Đã lưu lịch ${SCHEDULE_LABELS[hour]} cho ${pageName}`);
            } else {
                setScheduleToast(`❌ Lỗi lưu lịch`);
            }
            setTimeout(() => setScheduleToast(null), 3000);
        });
    };

    // ─── Hẹn tất cả đoạn theo mapping cố định ───────────────────────────────
    // Đoạn 1 → 6h, Đoạn 2 → 11h, Đoạn 3 → 17h, Đoạn 4 → 21h
    const SEGMENT_HOUR_MAP = [6, 11, 17, 21];

    const handleScheduleAll = async () => {
        if (!selectedPageId) {
            setScheduleToast("⚠️ Chọn Page trước!");
            setTimeout(() => setScheduleToast(null), 3000);
            return;
        }
        // Tìm đoạn nào đã có nội dung
        const filledSegments = messages
            .map((m, i) => ({ idx: i, msg: m.trim(), media: mediaArrays[i] }))
            .filter(s => s.msg || s.media.length > 0);

        if (filledSegments.length === 0) {
            setScheduleToast("⚠️ Nhập ít nhất 1 đoạn tin nhắn trước!");
            setTimeout(() => setScheduleToast(null), 3000);
            return;
        }

        const pageName = pages.find(p => p.pageId === selectedPageId)?.name || selectedPageId;
        const tz = shopTz.offset;

        // ═══ UPLOAD ẢNH TRƯỚC: chuyển base64 → URL để tránh vượt 1MB Firestore limit ═══
        setScheduleToast("⏳ Đang upload ảnh...");
        console.log('[schedule] filledSegments media:', filledSegments.map(s => ({ idx: s.idx, mediaCount: s.media.length, mediaPreview: s.media.map(m => m.substring(0, 30)) })));
        
        const uploadedSegments = await Promise.all(filledSegments.map(async (seg) => {
            if (!seg.media || seg.media.length === 0) {
                console.log(`[schedule] Seg ${seg.idx}: no media`);
                return { ...seg, mediaUrls: [] as string[] };
            }
            
            console.log(`[schedule] Seg ${seg.idx}: uploading ${seg.media.length} images...`);
            const urls: string[] = [];
            for (const dataUrl of seg.media) {
                if (dataUrl.startsWith('http')) {
                    // Already a URL (from edit mode), keep as-is
                    urls.push(dataUrl);
                    console.log(`[schedule] Seg ${seg.idx}: URL passthrough: ${dataUrl.substring(0, 60)}`);
                    continue;
                }
                // base64 → upload to host
                try {
                    const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
                    if (!match) {
                        console.warn(`[schedule] Seg ${seg.idx}: invalid data URL format: ${dataUrl.substring(0, 40)}`);
                        continue;
                    }
                    const base64 = match[1];
                    
                    // Try freeimage.host first
                    let uploadedUrl: string | null = null;
                    try {
                        const fd = new FormData();
                        const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' });
                        fd.append('source', blob, 'image.png');
                        fd.append('type', 'file');
                        fd.append('action', 'upload');
                        const res = await fetch('https://freeimage.host/api/1/upload?key=6d207e02198a847aa98d0a2a901485a5', {
                            method: 'POST', body: fd,
                        });
                        const data = await res.json();
                        if (data?.image?.url) {
                            uploadedUrl = data.image.url;
                        } else {
                            console.warn('[schedule] freeimage.host failed:', JSON.stringify(data).substring(0, 200));
                        }
                    } catch (err) {
                        console.warn('[schedule] freeimage.host error:', err);
                    }
                    
                    // Fallback: imgbb
                    if (!uploadedUrl) {
                        try {
                            const fd2 = new FormData();
                            fd2.append('image', base64);
                            const res2 = await fetch('https://api.imgbb.com/1/upload?key=4e37bdbc3b6e2a84c28c47e0cce3e53f', {
                                method: 'POST', body: fd2,
                            });
                            const data2 = await res2.json();
                            if (data2?.data?.url) {
                                uploadedUrl = data2.data.url;
                                console.log('[schedule] imgbb fallback OK:', uploadedUrl);
                            }
                        } catch (err2) {
                            console.error('[schedule] imgbb fallback error:', err2);
                        }
                    }
                    
                    if (uploadedUrl) {
                        urls.push(uploadedUrl);
                        console.log(`[schedule] Seg ${seg.idx}: ✅ uploaded: ${uploadedUrl}`);
                    } else {
                        console.error(`[schedule] Seg ${seg.idx}: ❌ ALL uploads failed`);
                    }
                } catch (err) {
                    console.error('[schedule-upload] Error:', err);
                }
            }
            console.log(`[schedule] Seg ${seg.idx}: ${urls.length} URLs ready`);
            return { ...seg, mediaUrls: urls };
        }));

        // ═══ TẠO 1 ENTRY DUY NHẤT chứa tất cả segments ═══
        const scheduleId = `${selectedShopId}_${selectedPageId}_combined`;
        const existing = schedules.find(s => s.id === scheduleId);
        const segs: ScheduleSegment[] = uploadedSegments.map(seg => ({
            segIdx: seg.idx,
            hour: SEGMENT_HOUR_MAP[seg.idx],
            message: seg.msg,
            media: seg.mediaUrls || [],
        }));
        const firstHour = segs[0].hour;

        const entry: BroadcastSchedule = {
            id: scheduleId,
            shopId: selectedShopId,
            shopName: shopName,
            pageId: selectedPageId,
            pageName,
            hour: firstHour,
            messages: segs.map(s => s.message),
            segments: segs,
            filterPurchase,
            filterTimeRange,
            isActive: true,
            createdAt: existing?.createdAt || new Date().toISOString(),
            lastFiredAt: existing?.lastFiredAt || null,
            nextFireAt: calcNextFireAt(firstHour, tz),
            note: existing?.note,
            recipientCount: filteredCustomers.length,
        };

        setScheduledSegments(new Set(filledSegments.map(s => s.idx)));
        const hourList = segs.map(s => `${s.hour}h`).join(', ');

        saveScheduleToAPI(entry).then(ok => {
            if (ok) {
                refreshSchedules();
                setScheduleToast(`✅ Đã hẹn 1 lịch (${hourList}) cho ${pageName}`);
            } else {
                setScheduleToast(`❌ Lỗi lưu lịch`);
            }
            setTimeout(() => setScheduleToast(null), 4000);
        });
    };

    const toggleScheduleActive = async (id: string) => {
        await toggleScheduleAPI(id);
        refreshSchedules();
    };

    const handleDeleteSchedule = async (id: string) => {
        await deleteScheduleFromAPI(id);
        refreshSchedules();
    };

    // ✅ Auto-fire: gọi cron endpoint mỗi 5 phút để tự bắn khi đến giờ
    // Hoạt động cả local và Vercel (Vercel Cron cũng gọi endpoint này)
    useEffect(() => {
        const fireCron = async () => {
            try {
                const res = await fetch('/api/broadcast/cron');
                const data = await res.json();
                if (data.fired > 0) {
                    console.log(`[auto-fire] 🔥 Fired ${data.fired} segments`, data.results);
                    refreshSchedules();
                }
            } catch (err) {
                console.error('[auto-fire] Error:', err);
            }
        };
        // Fire immediately on mount
        fireCron();
        // Then every 5 minutes
        const interval = setInterval(fireCron, 5 * 60 * 1000);
        return () => clearInterval(interval);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const startEditNote = (s: BroadcastSchedule) => {
        setEditingScheduleId(s.id);
        setEditNote(s.note || "");
    };

    const saveNote = async (id: string) => {
        await saveNoteAPI(id, editNote);
        refreshSchedules();
        setEditingScheduleId(null);
    };

    // ═══ SỬA NỘI DUNG: Load schedule vào 4 ô message + media ═══
    const handleEditScheduleContent = (s: BroadcastSchedule) => {
        // Load messages vào 4 ô
        const msgs = s.messages || [];
        setMsg1(msgs[0] || '');
        setMsg2(msgs[1] || '');
        setMsg3(msgs[2] || '');
        setMsg4(msgs[3] || '');
        
        // Load media vào 4 ô
        const segs = s.segments || [];
        setMedia1(segs[0]?.media || []);
        setMedia2(segs[1]?.media || []);
        setMedia3(segs[2]?.media || []);
        setMedia4(segs[3]?.media || []);
        
        // Select đúng shop + page
        if (s.shopId && s.shopId !== selectedShopId) setSelectedShopId(s.shopId);
        if (s.pageId && s.pageId !== selectedPageId) setSelectedPageId(s.pageId);
        
        // Scroll lên đầu
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setScheduleToast(`✏️ Đang sửa lịch "${s.pageName}" — chỉnh sửa xong bấm "Hẹn lịch" để lưu`);
        setTimeout(() => setScheduleToast(null), 5000);
    };

    const handleCancelSchedule = () => {
        if (scheduleTimerRef.current) clearTimeout(scheduleTimerRef.current);
        if (countdownRef.current) clearInterval(countdownRef.current);
        setScheduledHour(null);
        setScheduleFireTime(null);
        setCountdown("");
        setIsPaused(false);
        setRemainingMs(0);
    };


    // Cleanup timers on unmount
    useEffect(() => {
        return () => {
            if (scheduleTimerRef.current) clearTimeout(scheduleTimerRef.current);
            if (countdownRef.current) clearInterval(countdownRef.current);
        };
    }, []);

    // Send a specific box's message
    const sendingLockRef = useRef(false);
    const lastSentTimeRef = useRef(0); // Cooldown tracker
    const [batchProgress, setBatchProgress] = useState<{ sent: number; total: number } | null>(null);
    const [sendingLog, setSendingLog] = useState<{ name: string; status: 'pending' | 'sending' | 'success' | 'error'; error?: string }[]>([]);
    const logScrollRef = useRef<HTMLDivElement>(null);
    const [sendDropdownOpen, setSendDropdownOpen] = useState(false);
    const [forceGraphAPI, setForceGraphAPI] = useState(false);
    // ═══ AUTO-BATCH: Chia nhỏ recipients thành từng đợt ═══
    const BATCH_SIZE = 50; // Mỗi đợt gửi 50 người
    const BATCH_DELAY_SEC = 60; // Delay 60s giữa các đợt
    const [autoBatchInfo, setAutoBatchInfo] = useState<{ currentBatch: number; totalBatches: number; totalSent: number; totalRecipients: number } | null>(null);
    const [batchCountdown, setBatchCountdown] = useState(0); // Countdown giữa các đợt

    const handleSendBox = async (boxIdx: number) => {
        // ═══ NUCLEAR GUARD: window-level global flag ═══
        // Không bị reset khi React re-render, không bị bypass bởi multiple component instances
        if ((window as unknown as Record<string, boolean>).__broadcastSending) {
            console.warn('[broadcast] BLOCKED by window flag');
            return;
        }
        if (sendingLockRef.current) {
            console.warn('[broadcast] BLOCKED by ref lock');
            return;
        }
        const cooldownLeft = 10000 - (Date.now() - lastSentTimeRef.current);
        if (cooldownLeft > 0) {
            console.warn(`[broadcast] BLOCKED: cooldown ${Math.ceil(cooldownLeft/1000)}s`);
            return;
        }
        const msg = messages[boxIdx]?.trim();
        const boxMedia = mediaArrays[boxIdx];
        if (selectedIds.size === 0 || (!msg && boxMedia.length === 0)) return;

        // Set ALL locks
        (window as unknown as Record<string, boolean>).__broadcastSending = true;
        sendingLockRef.current = true;
        setSendDropdownOpen(false);
        setIsSending(true);
        setSendResults(null);
        setSendingLog([]);

        const controller = new AbortController();
        abortControllerRef.current = controller;
        const signal = controller.signal;

        // ═══ FIX: Chỉ gửi cho filteredCustomers (đã loại khách mua hàng) ═══
        const allRecipients = filteredCustomers
            .filter((c) => selectedIds.has(c.id))
            .map((c) => ({ psid: c.psid, pageFbId: c.pageFbId, name: c.customerName, conversationId: c.id }));

        try {
            // Ảnh gửi trực tiếp base64 — server sẽ convert → FormData → Pancake
            const imageData: string[] = boxMedia.length > 0 ? boxMedia : [];

            // ── GỬI TỪNG NGƯỜI 1 — CLIENT LOOP (AUTO-BATCH) ──
            const allResults: SendResult[] = [];

            // Chia recipients thành batches
            const batches: typeof allRecipients[] = [];
            for (let i = 0; i < allRecipients.length; i += BATCH_SIZE) {
                batches.push(allRecipients.slice(i, i + BATCH_SIZE));
            }

            // Khởi tạo log cho tất cả recipients
            setSendingLog(allRecipients.map(r => ({ name: r.name, status: 'pending' as const })));
            let globalIdx = 0; // index toàn cục across batches

            for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
                if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

                const batch = batches[batchIdx];
                setAutoBatchInfo({
                    currentBatch: batchIdx + 1,
                    totalBatches: batches.length,
                    totalSent: globalIdx,
                    totalRecipients: allRecipients.length,
                });

                // ── Gửi từng người trong batch ──
                for (let j = 0; j < batch.length; j++) {
                    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

                    const recipient = batch[j];
                    setBatchProgress({ sent: globalIdx, total: allRecipients.length });

                    // Mark current as 'sending'
                    setSendingLog(prev => prev.map((item, idx) => idx === globalIdx ? { ...item, status: 'sending' as const } : item));
                    setTimeout(() => logScrollRef.current?.scrollTo({ top: logScrollRef.current.scrollHeight, behavior: 'smooth' }), 50);

                    try {
                        let res: Response;
                        if (imageData.length > 0) {
                            const fd = new FormData();
                            fd.append('recipients', JSON.stringify([recipient]));
                            fd.append('message', msg || '');
                            for (let imgIdx = 0; imgIdx < imageData.length; imgIdx++) {
                                const imgStr = imageData[imgIdx];
                                if (imgStr.startsWith('data:')) {
                                    const resp = await fetch(imgStr);
                                    const blob = await resp.blob();
                                    const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
                                    fd.append('images', new File([blob], `img_${imgIdx}.${ext}`, { type: blob.type }));
                                }
                            }
                            if (forceGraphAPI) fd.append('forceGraphAPI', 'true');
                            res = await fetch("/api/broadcast", { method: "POST", body: fd, signal });
                        } else {
                            res = await fetch("/api/broadcast", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ recipients: [recipient], message: msg || '', forceGraphAPI }),
                                signal,
                            });
                        }
                        const data = await res.json();
                        if (data.results && data.results.length > 0) {
                            allResults.push(...data.results);
                            const ok = data.results[0]?.success;
                            const capturedIdx = globalIdx;
                            setSendingLog(prev => prev.map((item, idx) => idx === capturedIdx ? { ...item, status: ok ? 'success' as const : 'error' as const, error: data.results[0]?.error } : item));
                        } else if (data.error) {
                            allResults.push({ psid: recipient.psid, name: recipient.name, success: false, error: data.error });
                            const capturedIdx = globalIdx;
                            setSendingLog(prev => prev.map((item, idx) => idx === capturedIdx ? { ...item, status: 'error' as const, error: data.error } : item));
                        }
                    } catch (err) {
                        if (err instanceof Error && err.name === 'AbortError') throw err;
                        allResults.push({ psid: recipient.psid, name: recipient.name, success: false, error: "Network error" });
                        const capturedIdx = globalIdx;
                        setSendingLog(prev => prev.map((item, idx) => idx === capturedIdx ? { ...item, status: 'error' as const, error: 'Network error' } : item));
                    }

                    globalIdx++;
                    if (j < batch.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                }

                // ── Delay giữa các batch (trừ batch cuối) ──
                if (batchIdx < batches.length - 1) {
                    setAutoBatchInfo(prev => prev ? { ...prev, totalSent: globalIdx } : null);
                    // Countdown delay
                    for (let sec = BATCH_DELAY_SEC; sec > 0; sec--) {
                        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
                        setBatchCountdown(sec);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    setBatchCountdown(0);
                }
            }

            setBatchProgress({ sent: allRecipients.length, total: allRecipients.length });
            setAutoBatchInfo(prev => prev ? { ...prev, totalSent: allRecipients.length } : null);
            setSendResults(allResults);

        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                setSendResults([{ psid: 'cancelled', name: 'System', success: false, error: '🚫 Đã huỷ gửi' }]);
            } else {
                console.error("Broadcast error:", err);
                setSendResults([{ psid: "error", name: "System", success: false, error: "Network error" }]);
            }
        } finally {
            // Release ALL locks
            (window as unknown as Record<string, boolean>).__broadcastSending = false;
            setIsSending(false);
            sendingLockRef.current = false;
            lastSentTimeRef.current = Date.now(); // Start 10s cooldown
            // GIỮ batchProgress ở sent=total để thanh bar hiển thị 100% xanh lá
            abortControllerRef.current = null;
            setAutoBatchInfo(null);
            setBatchCountdown(0);
        }
    };

    // Filter pages by search
    const filteredPages = pages.filter((p) => {
        if (!pageSearch.trim()) return true;
        const q = pageSearch.toLowerCase();
        return p.name.toLowerCase().includes(q) || p.pageId.includes(q);
    });

    // Get selected page name
    const selectedPageName = pages.find((p) => p.pageId === selectedPageId)?.name || "";

    // Time formatter
    const formatTime = (iso: string) => {
        if (!iso) return "";
        try {
            const d = new Date(iso);
            return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
        } catch { return iso; }
    };

    const successCount = sendResults?.filter((r) => r.success).length || 0;
    const failCount = sendResults ? sendResults.length - successCount : 0;

    // Batch progress UI helper
    const progressPercent = batchProgress ? Math.round((batchProgress.sent / batchProgress.total) * 100) : 0;

    return (
        <div className="space-y-4">


            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                        <span className="text-xl">📩</span> Gửi Tin Nhắn Hàng Loạt
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                        Lấy khách từ Pancake POS · Gửi tin qua Facebook Messenger
                    </p>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    HUMAN_AGENT tag · 7 ngày
                </div>
            </div>

            {/* Controls Row */}
            {/* ─── Single control row: Shop + Page + Filters + Button ─── */}
            <div className="flex items-end gap-2 flex-wrap">


                {/* Page Selector */}
                <div className="relative flex-1 min-w-[180px]">
                    <label className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1 block">
                        📄 Chọn Page {pages.length > 0 && <span className="text-violet-500">({pages.length} pages)</span>}
                    </label>
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 z-10" />
                        <input
                            type="text"
                            value={isPageDropdownOpen ? pageSearch : (selectedPageId ? `${selectedPageName} (${selectedPageId})` : "")}
                            onChange={(e) => { setPageSearch(e.target.value); if (!isPageDropdownOpen) setIsPageDropdownOpen(true); }}
                            onFocus={() => { setIsPageDropdownOpen(true); setPageSearch(""); }}
                            placeholder={isLoadingPages ? "Đang tải pages..." : "Tìm page theo tên hoặc ID..."}
                            disabled={isLoadingPages}
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 pl-9 pr-8 text-sm text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-violet-400/30 shadow-sm"
                        />
                        <ChevronDown className={`absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none transition-transform ${isPageDropdownOpen ? "rotate-180" : ""}`} />
                        {isLoadingPages && <Loader2 className="absolute right-8 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-violet-400 animate-spin" />}
                    </div>
                    {isPageDropdownOpen && pages.length > 0 && (
                        <>
                            <div className="fixed inset-0 z-20" onClick={() => setIsPageDropdownOpen(false)} />
                            <div className="absolute z-30 top-full left-0 right-0 mt-1 rounded-xl border border-slate-200 bg-white shadow-xl max-h-[280px] overflow-y-auto">
                                <button
                                    onClick={() => { setSelectedPageId(""); setIsPageDropdownOpen(false); setPageSearch(""); setCustomers([]); setSelectedIds(new Set()); setSendResults(null); setFilterActive(false); }}
                                    className={`w-full text-left px-3 py-2 text-sm hover:bg-violet-50 transition-colors border-b border-slate-100 ${!selectedPageId ? "bg-violet-50 text-violet-700 font-semibold" : "text-slate-600"}`}
                                >
                                    Tất cả pages ({pages.length})
                                </button>
                                {filteredPages.map((p) => (
                                    <button
                                        key={p.pageId}
                                        onClick={() => { setSelectedPageId(p.pageId); setIsPageDropdownOpen(false); setPageSearch(""); setCustomers([]); setSelectedIds(new Set()); setSendResults(null); setFilterActive(false); }}
                                        className={`w-full text-left px-3 py-2 text-sm hover:bg-violet-50 transition-colors ${selectedPageId === p.pageId ? "bg-violet-50 text-violet-700 font-semibold" : "text-slate-700"}`}
                                    >
                                        <span className="block truncate">
                                            {p.name}
                                            {p.source && <span className={`ml-1.5 inline-block px-1.5 py-0 rounded text-[9px] font-medium ${p.source === 'fb_graph' ? 'bg-blue-100 text-blue-600' : p.source === 'crm' ? 'bg-green-100 text-green-600' : 'bg-slate-100 text-slate-500'}`}>{p.source === 'fb_graph' ? 'FB' : p.source === 'crm' ? 'CRM' : 'POS'}</span>}
                                        </span>
                                        <span className="block text-[10px] text-slate-400 font-mono">{p.pageId}{p.shopName ? ` · ${p.shopName}` : ''}</span>
                                    </button>
                                ))}
                                {filteredPages.length === 0 && <div className="px-3 py-4 text-sm text-slate-400 text-center">Không tìm thấy page</div>}
                            </div>
                        </>
                    )}
                </div>

                {/* Filter: Purchase */}
                <div className="flex-shrink-0">
                    <label className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1 block">🛒 Trạng thái</label>
                    <select
                        value={filterPurchase}
                        onChange={(e) => { setFilterPurchase(e.target.value as typeof filterPurchase); setFilterActive(false); }}
                        className="rounded-xl border border-slate-200 bg-white px-2.5 py-2.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-300/40 shadow-sm"
                    >
                        <option value="all">Tất cả KH</option>
                        <option value="no_purchase">Nhắn tin chưa mua</option>
                        <option value="has_purchase">Đã mua hàng</option>
                    </select>
                </div>

                {/* Filter: Time */}
                <div className="flex-shrink-0">
                    <label className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1 block">📅 Thời gian</label>
                    <select
                        value={filterTimeRange}
                        onChange={(e) => { setFilterTimeRange(e.target.value as typeof filterTimeRange); setFilterActive(false); }}
                        className="rounded-xl border border-slate-200 bg-white px-2.5 py-2.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-300/40 shadow-sm"
                    >
                        <option value="all">Mọi thời gian</option>
                        <option value="24h">24 giờ qua</option>
                        <option value="7d">7 ngày qua</option>
                        <option value="30d">30 ngày qua</option>
                        <option value="90d">90 ngày qua</option>
                    </select>
                </div>

                {/* Lọc + Refresh + Count */}
                <div className="flex items-end gap-2 flex-shrink-0">
                    <button onClick={() => loadCustomers(selectedShopId, currentPage, selectedPageId)} disabled={(!selectedShopId && !selectedPageId) || isLoadingCustomers} className="rounded-xl border border-slate-200 bg-white p-2.5 text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50 shadow-sm">
                        <RefreshCw className={`h-4 w-4 ${isLoadingCustomers ? "animate-spin" : ""}`} />
                    </button>
                    <button onClick={async () => { await loadCustomers(selectedShopId, 1, selectedPageId); setFilterActive(true); }} disabled={(!selectedShopId && !selectedPageId) || isLoadingCustomers} className="rounded-xl bg-gradient-to-r from-violet-600 to-purple-600 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap">
                        🔍 Lọc data
                    </button>
                    {filterActive && (
                        <button onClick={() => { setFilterActive(false); setFilterPurchase('all'); setFilterTimeRange('all'); setFilterGender('all'); }} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-500 hover:bg-slate-50 transition-colors shadow-sm">
                            ✕
                        </button>
                    )}
                    <div className="rounded-xl bg-violet-50 border border-violet-200 px-3 py-2.5 text-sm whitespace-nowrap">
                        <span className="font-semibold text-violet-700">{selectedIds.size}</span>
                        <span className="text-violet-500">/{filteredCustomers.length} chọn</span>
                    </div>
                </div>
            </div>



            {/* CRM Warning Banner */}
            {crmWarning && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                        <p className="text-sm font-semibold text-amber-800">CRM không khả dụng cho page này</p>
                        <p className="text-xs text-amber-700 mt-1">{crmWarning}</p>
                        <p className="text-xs text-amber-600 mt-1">
                            👉 Vào <a href="https://pages.fm" target="_blank" rel="noopener noreferrer" className="underline font-medium hover:text-amber-800">pages.fm</a> → Đăng nhập lại Facebook → Quay lại đây và bấm 🔍 Lọc data
                        </p>
                    </div>
                    <button onClick={() => setCrmWarning(null)} className="text-amber-500 hover:text-amber-700">
                        <X className="h-4 w-4" />
                    </button>
                </div>
            )}

            {/* Customer List */}
            <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                {/* Header */}
                <div className="grid grid-cols-[80px_1fr_120px_80px_100px] gap-2 px-4 py-2.5 bg-slate-50 border-b border-slate-100 text-[10px] font-semibold text-slate-500 uppercase tracking-wider items-center">
                    <button onClick={toggleSelectAll} className="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-violet-50 transition-colors" title={`Chọn tất cả ${customers.length} khách`}>
                        {selectedIds.size === customers.length && customers.length > 0
                            ? <CheckSquare className="h-4 w-4 text-violet-600 flex-shrink-0" />
                            : <Square className="h-4 w-4 text-slate-400 flex-shrink-0" />
                        }
                        <span className="text-[10px] font-semibold text-violet-600 whitespace-nowrap">Tất cả</span>
                    </button>
                    <span>Khách hàng</span>
                    <span>SĐT</span>
                    <span className="text-center">Tin nhắn</span>
                    <span className="text-right">Ngày</span>
                </div>

                {/* Loading */}
                {isLoadingCustomers && (
                    <div className="flex items-center justify-center py-12 text-sm text-slate-400">
                        <Loader2 className="h-5 w-5 animate-spin mr-2" />
                        Đang tải danh sách khách...
                    </div>
                )}

                {/* Empty */}
                {!isLoadingCustomers && filteredCustomers.length === 0 && selectedShopId && customers.length > 0 && (
                    <div className="flex flex-col items-center justify-center py-12 text-sm text-slate-400">
                        <Filter className="h-8 w-8 mb-2 text-slate-300" />
                        Không có khách phù hợp bộ lọc
                    </div>
                )}

                {!isLoadingCustomers && customers.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-12 text-sm text-slate-400">
                        <Users className="h-8 w-8 mb-2 text-slate-300" />
                        {selectedPageId ? "Không có khách nào từ page này" : "Chọn page và bấm 🔍 Lọc data để xem khách hàng"}
                    </div>
                )}

                <div className="max-h-[400px] overflow-y-auto divide-y divide-slate-50">
                    {filteredCustomers.slice(0, visibleCount).map((c) => {
                        const isSelected = selectedIds.has(c.id);
                        const result = sendResults?.find((r) => r.psid === c.psid);
                        const name = c.customerName || "Không rõ tên";
                        const phone = c.customerPhone || "";
                        const msgs = c.messageCount || c.orderCount || 0;
                        const sub = (c.snippet || c.address || "").replace(/[\r\n]+/g, " ").slice(0, 80);

                        return (
                            <div
                                key={c.id}
                                className={`grid grid-cols-[80px_1fr_120px_80px_100px] gap-2 px-4 py-2.5 items-center cursor-pointer hover:bg-slate-50/80 transition-colors ${
                                    isSelected ? "bg-violet-50/50" : ""
                                } ${
                                    result?.success ? "!bg-green-50/50" : result && !result.success ? "!bg-red-50/50" : ""
                                }`}
                                onClick={() => toggleSelect(c.id)}
                            >
                                {/* Checkbox */}
                                <div className="flex items-center justify-center">
                                    {result ? (
                                        result.success
                                            ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                                            : <XCircle className="h-4 w-4 text-red-500" />
                                    ) : isSelected
                                        ? <CheckSquare className="h-4 w-4 text-violet-600" />
                                        : <Square className="h-4 w-4 text-slate-300" />
                                    }
                                </div>

                                {/* Name */}
                                <div className="min-w-0">
                                    <div className="flex items-center gap-1.5">
                                        <p className="text-sm font-medium text-slate-700 truncate">{name}</p>
                                        {c.conversationLink && (
                                            <a
                                                href={c.conversationLink}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                onClick={(e) => e.stopPropagation()}
                                                className="text-violet-400 hover:text-violet-600"
                                                title="Mở Pancake"
                                            >
                                                <ExternalLink className="h-3 w-3" />
                                            </a>
                                        )}
                                    </div>
                                    {sub && (
                                        <p className="text-[10px] text-slate-400 truncate max-w-[300px]">{sub}</p>
                                    )}
                                </div>

                                {/* Phone */}
                                <div className="flex items-center gap-1 text-xs text-slate-500">
                                    {phone && <Phone className="h-3 w-3 text-slate-400" />}
                                    <span className="truncate">{phone || "—"}</span>
                                </div>

                                {/* Messages */}
                                <div className="flex items-center justify-center gap-1 text-xs">
                                    <MessageSquare className="h-3 w-3 text-slate-400" />
                                    <span className={msgs > 0 ? "text-blue-600 font-semibold" : "text-slate-400"}>
                                        {msgs}
                                    </span>
                                </div>

                                {/* Date */}
                                <p className="text-[11px] text-slate-400 text-right">{formatTime(c.updatedAt || "")}</p>
                            </div>
                        );
                    })}
                    {filteredCustomers.length > visibleCount && (
                        <button
                            onClick={() => setVisibleCount(prev => prev + 200)}
                            className="w-full py-2.5 text-center text-xs font-medium text-violet-600 hover:bg-violet-50 transition-colors"
                        >
                            Xem thêm ({filteredCustomers.length - visibleCount} còn lại)
                        </button>
                    )}
                </div>

                {/* Total count */}
                {filteredCustomers.length > 0 && (
                    <div className="flex items-center justify-center px-4 py-2 bg-slate-50 border-t border-slate-100">
                        <span className="text-xs text-slate-400">
                            Hiển thị: {Math.min(visibleCount, filteredCustomers.length)} · Lọc: {filteredCustomers.length} · Tổng CRM: {totalCustomers} khách · Đã chọn: {selectedIds.size}
                        </span>
                    </div>
                )}
            </div>

            {/* Message Composer - 4 Boxes */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                    <label className="text-sm font-bold text-slate-700 flex items-center gap-2">
                        ✏️ Soạn tin nhắn broadcast
                    </label>
                    <span className="text-[11px] text-slate-400 bg-slate-50 px-2 py-1 rounded-full">
                        {totalMediaCount} media · {selectedIds.size} người nhận
                    </span>
                </div>

                {/* 4 Message Boxes */}
                <div className="space-y-4">
                    {[
                        { idx: 0, label: 'ĐOẠN 1 – Nhắc lại thành phần', color: 'emerald', hour: '6:00', placeholder: 'VD: 🌿 Sản phẩm chứa Niacinamide, Vitamin C...' },
                        { idx: 1, label: 'ĐOẠN 2 – Nhắc lại feedback KH', color: 'blue', hour: '11:00', placeholder: 'VD: ⭐ Chị Hoa thấy da sáng hẳn sau 2 tuần...' },
                        { idx: 2, label: 'ĐOẠN 3 – Kêu gọi mua hàng', color: 'violet', hour: '17:00', placeholder: 'VD: 🔥 FLASH SALE giảm 50%! Inbox ngay...' },
                        { idx: 3, label: 'ĐOẠN 4 – Nội dung khác', color: 'rose', hour: '21:00', placeholder: 'VD: 🌙 Cảm ơn quý khách đã ủng hộ...' },
                    ].map(({ idx, label, color, hour, placeholder }) => {
                        const boxMedia = mediaArrays[idx];
                        const boxMsg = messages[idx];
                        const setMsg = setMessages[idx];
                        const colorMap: Record<string, Record<string, string>> = {
                            emerald: { border: 'border-emerald-100', bg: 'bg-emerald-50/20', badge: 'bg-emerald-500', text: 'text-emerald-600', mediaBorder: 'border-emerald-200', inputBorder: 'border-emerald-100', ring: 'focus:ring-emerald-300/30', uploadBorder: 'border-emerald-200 hover:border-emerald-400', uploadBg: 'hover:bg-emerald-50', uploadText: 'text-emerald-400' },
                            blue: { border: 'border-blue-100', bg: 'bg-blue-50/20', badge: 'bg-blue-500', text: 'text-blue-600', mediaBorder: 'border-blue-200', inputBorder: 'border-blue-100', ring: 'focus:ring-blue-300/30', uploadBorder: 'border-blue-200 hover:border-blue-400', uploadBg: 'hover:bg-blue-50', uploadText: 'text-blue-400' },
                            violet: { border: 'border-violet-100', bg: 'bg-violet-50/20', badge: 'bg-violet-500', text: 'text-violet-600', mediaBorder: 'border-violet-200', inputBorder: 'border-violet-100', ring: 'focus:ring-violet-300/30', uploadBorder: 'border-violet-200 hover:border-violet-400', uploadBg: 'hover:bg-violet-50', uploadText: 'text-violet-400' },
                            rose: { border: 'border-rose-100', bg: 'bg-rose-50/20', badge: 'bg-rose-500', text: 'text-rose-600', mediaBorder: 'border-rose-200', inputBorder: 'border-rose-100', ring: 'focus:ring-rose-300/30', uploadBorder: 'border-rose-200 hover:border-rose-400', uploadBg: 'hover:bg-rose-50', uploadText: 'text-rose-400' },
                        };
                        const c = colorMap[color];
                        return (
                            <div key={idx} className={`rounded-lg border ${c.border} ${c.bg} p-3 space-y-2`}>
                                <div className="flex items-center justify-between">
                                    <label className={`text-[11px] font-semibold ${c.text} flex items-center gap-1.5`}>
                                        <span className={`w-5 h-5 rounded-full ${c.badge} text-white flex items-center justify-center text-[10px] font-bold`}>{idx + 1}</span>
                                        {label}
                                    </label>
                                    <span className="text-[10px] text-slate-400 bg-white/70 px-1.5 py-0.5 rounded">⏰ {hour}</span>
                                </div>
                                {/* Side-by-side: Media Left, Text Right */}
                                <div className="flex gap-3">
                                    {/* Media Gallery - Left */}
                                    <div className="flex-shrink-0" style={{ minWidth: '20%', maxWidth: '33%' }}>
                                        <div className="flex gap-1.5 flex-wrap">
                                            {boxMedia.map((src, mi) => (
                                                <div key={mi} className="relative group flex-shrink-0">
                                                    {src.startsWith('data:video') ? (
                                                        <video src={src} className={`w-14 h-14 rounded-lg object-cover border ${c.mediaBorder}`} muted />
                                                    ) : (
                                                        <img src={src} alt="" className={`w-14 h-14 rounded-lg object-cover border ${c.mediaBorder}`} />
                                                    )}
                                                    <button onClick={() => removeMedia(idx, mi)} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity shadow"><X className="h-2.5 w-2.5" /></button>
                                                </div>
                                            ))}
                                            <label className={`w-14 h-14 flex-shrink-0 rounded-lg border-2 border-dashed ${c.uploadBorder} bg-white/50 ${c.uploadBg} flex flex-col items-center justify-center cursor-pointer transition-colors gap-0.5`}>
                                                <ImagePlus className={`h-3.5 w-3.5 ${c.uploadText}`} />
                                                <span className={`text-[7px] ${c.uploadText}`}>+Ảnh/Video</span>
                                                <input type="file" accept="image/*,video/*" multiple onChange={handleMediaUpload(idx)} className="hidden" />
                                            </label>
                                        </div>
                                    </div>
                                    {/* Text - Right */}
                                    <textarea
                                        value={boxMsg}
                                        onChange={(e) => setMsg(e.target.value)}
                                        placeholder={placeholder}
                                        rows={5}
                                        className={`flex-1 min-w-0 rounded-lg border ${c.inputBorder} bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-2 ${c.ring} resize-none`}
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* ═══ BOX LỚN: Hẹn giờ bắn bot + Tiến trình bắn ═══ */}
                <div className="rounded-xl border-2 border-amber-200 bg-gradient-to-br from-amber-50/40 to-orange-50/20 p-4 space-y-3 shadow-sm">

                    {/* ── ⏰ Hẹn giờ bắn bot ── */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <label className="text-[11px] font-semibold text-amber-700 flex items-center gap-1.5">
                                <CalendarClock className="h-4 w-4" />
                                Hẹn giờ bắn bot · {shopTz.flag} {shopName} ({shopTz.label}, UTC+{shopTz.offset})
                            </label>
                            <span className="text-[10px] text-amber-500 flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                Giờ hiện tại: {getCurrentTimeInTimezone(shopTz.offset)}
                            </span>
                        </div>
                        <div className="grid grid-cols-5 gap-2">
                            {/* ── Cột trái: 3 nút hành động ── */}
                            <div className="relative flex flex-col gap-1">
                                <div className="relative">
                                    <button
                                        disabled={isSending || selectedIds.size === 0}
                                        onClick={() => setSendDropdownOpen(prev => !prev)}
                                        className="w-full rounded-lg px-2 py-2.5 text-center transition-all border-2 border-red-300 bg-gradient-to-b from-red-500 to-orange-500 text-white shadow-md shadow-red-200 hover:shadow-red-300 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed text-sm font-bold"
                                    >
                                        ⚡ Bắn ngay ▾
                                    </button>
                                    {sendDropdownOpen && !isSending && (
                                        <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white rounded-lg shadow-xl border border-gray-200 overflow-hidden">
                                            {[0,1,2,3].map(i => (
                                                <button
                                                    key={i}
                                                    onClick={() => {
                                                        setSendDropdownOpen(false);
                                                        if (!sendingLockRef.current) handleSendBox(i);
                                                    }}
                                                    disabled={selectedIds.size === 0}
                                                    className="w-full px-3 py-2 text-left text-sm hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-40"
                                                >
                                                    Đoạn {i+1}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <button
                                    onClick={() => {
                                        abortControllerRef.current?.abort();
                                        sendingLockRef.current = false;
                                        setIsSending(false);
                                        setBatchProgress(null);
                                        setSendResults([{ psid: 'cancelled', name: 'System', success: false, error: '🚫 Đã huỷ gửi tin nhắn' }]);
                                        localStorage.setItem("broadcast_global_paused", "true");
                                        setIsGlobalPaused(true);
                                    }}
                                    className="w-full rounded-lg px-2 py-1.5 text-center transition-all border-2 border-red-400 bg-red-50 text-red-700 text-[11px] font-bold hover:bg-red-100"
                                >
                                    ⛔ Huỷ bắn
                                </button>
                            </div>
                            {/* ── Cột phải: Accordion 4 khung giờ ── */}
                            <div className="col-span-4 flex flex-col gap-2">
                                {/* Toggle header – click để mở/đóng */}
                                <button
                                    onClick={() => setShowSchedulePreview(p => !p)}
                                    className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border-2 border-amber-200 bg-white/90 hover:bg-amber-50 transition-colors"
                                >
                                    <span className="flex items-center gap-2 text-[11px] font-semibold text-amber-700">
                                        <CalendarClock className="h-3.5 w-3.5" />
                                        Lịch hẹn giờ
                                        <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold">
                                            {messages.filter(m => m?.trim()).length + mediaArrays.filter(a => a.length > 0).length} đoạn sẵn sàng
                                        </span>
                                    </span>
                                    <ChevronDown className={`h-4 w-4 text-amber-500 transition-transform duration-200 ${showSchedulePreview ? 'rotate-180' : ''}`} />
                                </button>
                                {/* Collapsible: 4 ô giờ */}
                                {showSchedulePreview && (
                                    <>
                                    <div className="grid grid-cols-4 gap-1.5">
                                        {[0,1,2,3].map(i => {
                                            const hour = SEGMENT_HOUR_MAP[i];
                                            const hasFill = !!(messages[i]?.trim() || mediaArrays[i]?.length > 0);
                                            const isScheduled = scheduledSegments.has(i);
                                            return (
                                                <div
                                                    key={i}
                                                    className={`rounded-lg border-2 px-2 py-2.5 text-center transition-all ${
                                                        isScheduled && hasFill
                                                            ? "border-green-400 bg-green-50 text-green-800 shadow-sm"
                                                            : hasFill
                                                            ? "border-amber-400 bg-amber-50 text-amber-800 shadow-sm"
                                                            : "border-dashed border-slate-200 bg-white/60 text-slate-300"
                                                    }`}
                                                >
                                                    <div className="text-base font-bold">{hour}:00</div>
                                                    <div className="text-[9px] mt-0.5">{SCHEDULE_LABELS[hour]}</div>
                                                    <div className={`text-[9px] font-semibold mt-1 ${
                                                        isScheduled && hasFill ? "text-green-600" : hasFill ? "text-amber-600" : "text-slate-300"
                                                    }`}>
                                                        {isScheduled && hasFill ? `✅ Đã hẹn · Đoạn ${i+1}` : hasFill ? `● Đoạn ${i+1}` : `○ Đoạn ${i+1}`}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    <button
                                        onClick={handleScheduleAll}
                                        disabled={(!selectedShopId && !selectedPageId) || messages.every(m => !m?.trim())}
                                        className="w-full rounded-lg px-3 py-2.5 text-center transition-all border-2 border-amber-400 bg-gradient-to-r from-amber-500 to-orange-400 text-white shadow-md shadow-amber-200 hover:shadow-amber-300 font-bold text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        ⏰ Hẹn lịch ({messages.filter(m => m?.trim()).length} đoạn)
                                    </button>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* ── 📊 Tiến trình gửi tin ── */}
                    <div className="border-t border-amber-200/60 pt-3 space-y-2">
                        <div className="flex items-center justify-between text-sm font-semibold">
                            <span className="text-blue-700 flex items-center gap-1.5">
                                {batchCountdown > 0 ? (
                                    <><span className="animate-pulse">⏸️</span> Nghỉ giữa đợt... ({batchCountdown}s)</>
                                ) : batchProgress && batchProgress.sent < batchProgress.total ? (
                                    <><span className="animate-pulse">📡</span> Đang gửi...{autoBatchInfo ? ` (Đợt ${autoBatchInfo.currentBatch}/${autoBatchInfo.totalBatches})` : ''}</>
                                ) : sendingLog.length > 0 && sendingLog.every(l => l.status === 'success' || l.status === 'error') ? (
                                    <>✅ Hoàn tất</>
                                ) : (
                                    <>📊 Tiến trình gửi tin</>
                                )}
                            </span>
                            <div className="flex items-center gap-3 text-xs">
                                {sendingLog.length > 0 && (
                                    <>
                                        <span className="text-green-600">✅ {sendingLog.filter(l => l.status === 'success').length}</span>
                                        <span className="text-red-500">❌ {sendingLog.filter(l => l.status === 'error').length}</span>
                                        <span className="text-amber-500">⏳ {sendingLog.filter(l => l.status === 'pending' || l.status === 'sending').length}</span>
                                    </>
                                )}
                                <span className="text-blue-600 font-medium">
                                    {batchProgress ? `${batchProgress.sent}/${batchProgress.total} · ${progressPercent}%` : sendingLog.length > 0 ? '100%' : 'Chờ gửi'}
                                </span>
                            </div>
                        </div>
                        <div className={`w-full rounded-full h-3 overflow-hidden transition-colors duration-500 ${
                            progressPercent >= 100 && sendingLog.length > 0 ? 'bg-green-100' : 'bg-blue-100'
                        }`}>
                            <div
                                className={`h-3 rounded-full transition-all duration-500 ease-out ${
                                    !batchProgress && sendingLog.length === 0 ? 'bg-slate-200' :
                                    progressPercent >= 100 ? 'bg-gradient-to-r from-green-400 to-emerald-500' : 'bg-gradient-to-r from-blue-500 to-indigo-500'
                                }`}
                                style={{ width: `${(!batchProgress && sendingLog.length === 0) ? 0 : progressPercent}%` }}
                            />
                        </div>
                        {sendingLog.length > 0 ? (
                            <div ref={logScrollRef} className="max-h-36 overflow-y-auto space-y-0.5 rounded-lg bg-white/70 border border-blue-100 p-2">
                                {sendingLog.map((log, idx) => (
                                    <div key={idx} className={`flex items-center gap-2 px-2 py-0.5 rounded text-[11px] transition-colors ${
                                        log.status === 'sending' ? 'bg-blue-50 text-blue-700 font-medium' :
                                        log.status === 'success' ? 'text-green-700' :
                                        log.status === 'error' ? 'text-red-600' :
                                        'text-slate-400'
                                    }`}>
                                        <span className="flex-shrink-0 w-4 text-center">
                                            {log.status === 'pending' && '⏳'}
                                            {log.status === 'sending' && <span className="animate-spin inline-block">⏳</span>}
                                            {log.status === 'success' && '✅'}
                                            {log.status === 'error' && '❌'}
                                        </span>
                                        <span className="truncate flex-1">{idx + 1}. {log.name}</span>
                                        {sendResults && sendResults[idx]?.via === 'fb_graph_api' && (
                                            <span className="flex-shrink-0 px-1.5 py-0.5 rounded text-[8px] font-bold bg-blue-100 text-blue-700 border border-blue-200">FB</span>
                                        )}
                                        {log.error && <span className="text-red-400 text-[10px] truncate max-w-[250px]" title={log.error}>{log.error}</span>}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="rounded-lg bg-white/50 border border-blue-100/50 p-2.5 text-center text-[11px] text-slate-300">
                                Chờ gửi tin nhắn...
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* ─── Toast notification ──────────────────────────────────────────── */}
            <AnimatePresence>
                {scheduleToast && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm font-medium text-violet-800 shadow-sm"
                    >
                        {scheduleToast}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ─── Schedule List ──────────────────────────────────────────────── */}
            {schedules.length > 0 && (
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
                            <CalendarClock className="h-4 w-4 text-violet-500" />
                            Lịch bắn bot hàng ngày
                            <span className="text-[11px] font-normal text-slate-400">({schedules.length} lịch)</span>
                        </h3>
                        <button
                            onClick={async () => { for (const s of schedules) { await deleteScheduleFromAPI(s.id); } refreshSchedules(); }}
                            className="text-[10px] text-red-400 hover:text-red-600 transition-colors"
                        >
                            Xoá tất cả
                        </button>
                    </div>

                    {/* ─── Stats Dashboard ───────────────────────────────────── */}
                    {(() => {
                        const allSegs = schedules.flatMap(s => s.segments || []);
                        const totalSent = allSegs.reduce((a, seg) => a + (seg.successCount || 0), 0);
                        const totalRecipients = allSegs.reduce((a, seg) => a + (seg.totalRecipients || 0), 0);
                        const totalErrors = allSegs.reduce((a, seg) => a + (seg.errorCount || 0), 0);
                        const successRate = totalRecipients > 0 ? ((totalSent / totalRecipients) * 100) : 0;
                        const errorRate = totalRecipients > 0 ? ((totalErrors / totalRecipients) * 100) : 0;
                        const activeCampaigns = schedules.filter(s => s.isActive).length;
                        const totalDataQueued = schedules.reduce((a, s) => a + (s.recipientCount || 0), 0);

                        return (
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-2">
                                {/* Card 1: Tổng tin đã gửi */}
                                <div className="bg-white rounded-xl border border-slate-100 p-3 shadow-sm">
                                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Tổng tin đã gửi</p>
                                    <div className="flex items-end gap-2">
                                        <span className="text-2xl font-bold text-slate-800">{totalSent.toLocaleString()}</span>
                                        {totalRecipients > 0 && (
                                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full mb-1 ${
                                                successRate >= 70 ? 'bg-green-50 text-green-600' : 'bg-amber-50 text-amber-600'
                                            }`}>
                                                {successRate >= 70 ? '↗' : '↘'}{successRate.toFixed(0)}%
                                            </span>
                                        )}
                                    </div>
                                </div>
                                {/* Card 2: Data chờ bắn */}
                                <div className="bg-white rounded-xl border border-slate-100 p-3 shadow-sm">
                                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Data chờ bắn</p>
                                    <div className="flex items-end gap-2">
                                        <span className="text-2xl font-bold text-slate-800">{totalDataQueued.toLocaleString()}</span>
                                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full mb-1 bg-indigo-50 text-indigo-600">
                                            👥 {schedules.length} page
                                        </span>
                                    </div>
                                </div>
                                {/* Card 3: Chiến dịch đang chạy */}
                                <div className="bg-white rounded-xl border border-slate-100 p-3 shadow-sm">
                                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Chiến dịch chạy</p>
                                    <div className="flex items-end gap-2">
                                        <span className="text-2xl font-bold text-slate-800">{activeCampaigns}</span>
                                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full mb-1 bg-green-50 text-green-600">
                                            Active
                                        </span>
                                    </div>
                                </div>
                                {/* Card 4: Tỷ lệ lỗi */}
                                <div className="bg-white rounded-xl border border-slate-100 p-3 shadow-sm">
                                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Tỷ lệ lỗi</p>
                                    <div className="flex items-end gap-2">
                                        <span className="text-2xl font-bold text-slate-800">{errorRate.toFixed(2)}%</span>
                                        {totalErrors > 0 && (
                                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full mb-1 bg-red-50 text-red-500">
                                                ↗{totalErrors}
                                            </span>
                                        )}
                                        {totalErrors === 0 && totalRecipients > 0 && (
                                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full mb-1 bg-green-50 text-green-600">
                                                ✓ Clean
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    {schedules.map(s => {
                        const tz = SHOP_TIMEZONES[s.shopName];
                        const nextMs = s.nextFireAt ? new Date(s.nextFireAt).getTime() - Date.now() : null;
                        const isEditing = editingScheduleId === s.id;
                        // Lấy danh sách segments (backward compat: nếu chưa có thì tạo từ hour/messages)
                        const segs: ScheduleSegment[] = s.segments || [{ segIdx: 0, hour: s.hour, message: s.messages[0] || '' }];
                        const segHours = segs.map(seg => `${seg.hour}h`).join(', ');
                        return (
                            <div key={s.id} className={`rounded-xl border p-3 space-y-2 transition-colors ${
                                s.isActive ? "border-violet-200 bg-violet-50/40" : "border-slate-200 bg-slate-50/60"
                            }`}>
                                {/* Row 1: Actions (left) + Info (right) */}
                                <div className="flex items-start gap-3">
                                    <div className="flex flex-col gap-1 flex-shrink-0 pt-0.5">
                                        <button
                                            onClick={() => toggleScheduleActive(s.id)}
                                            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                                                s.isActive
                                                    ? "bg-yellow-100 text-yellow-700 hover:bg-yellow-200"
                                                    : "bg-green-100 text-green-700 hover:bg-green-200"
                                            }`}
                                        >
                                            {s.isActive ? <><Timer className="h-3 w-3" /> Dừng</> : <><Clock className="h-3 w-3" /> Chạy</>}
                                        </button>
                                        <button onClick={() => startEditNote(s)} className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-blue-50 text-blue-500 hover:bg-blue-100 transition-colors">
                                            <MessageSquare className="h-3 w-3" /> Ghi chú
                                        </button>
                                        <button onClick={() => handleEditScheduleContent(s)} className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-amber-50 text-amber-600 hover:bg-amber-100 transition-colors">
                                            <Pencil className="h-3 w-3" /> Sửa
                                        </button>
                                        <button onClick={() => handleDeleteSchedule(s.id)} className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-red-50 text-red-400 hover:bg-red-100 transition-colors">
                                            <X className="h-3 w-3" /> Xoá
                                        </button>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                            <span className="text-[11px] font-bold text-slate-700">{s.shopName}</span>
                                            <span className="text-slate-300">·</span>
                                            <span className="text-[11px] text-slate-600 truncate max-w-[160px]">{s.pageName}</span>
                                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                                                s.isActive ? "bg-green-100 text-green-700" : "bg-slate-200 text-slate-500"
                                            }`}>
                                                {s.isActive ? "● Đang chạy" : "⏸ Tạm dừng"}
                                            </span>
                                            {s.recipientCount != null && (
                                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-600">
                                                    👥 {s.recipientCount} data
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                            <span className="text-[11px] text-violet-600 font-semibold">
                                                📅 {segHours} {tz ? `(${tz.flag} ${tz.label})` : ""}
                                            </span>
                                            {s.nextFireAt && nextMs !== null && nextMs > 0 && (
                                                <span className="text-[10px] text-slate-400">⏳ còn {formatCountdown(nextMs)}</span>
                                            )}
                                        </div>
                                        {/* Hiển thị preview nội dung từng đoạn */}
                                        {segs.length > 0 && (
                                            <div className="mt-1 space-y-0.5">
                                                {segs.map(seg => (
                                                    <p key={seg.segIdx} className="text-[10px] text-slate-400 truncate">
                                                        <span className="text-slate-500 font-medium">Đ{seg.segIdx + 1} ({seg.hour}h):</span>{' '}
                                                        {seg.message ? seg.message.slice(0, 60) + (seg.message.length > 60 ? '…' : '') : '(trống)'}
                                                    </p>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* ─── Segment Status: hiển thị 4 ô giờ ─── */}
                                {s.isActive && (() => {
                                    const allSlots = [
                                        { idx: 0, hour: 6, icon: "🌅", time: "6h" },
                                        { idx: 1, hour: 11, icon: "☀️", time: "11h" },
                                        { idx: 2, hour: 17, icon: "🌆", time: "17h" },
                                        { idx: 3, hour: 21, icon: "🌙", time: "21h" },
                                    ];
                                    // Map segment status by hour
                                    const segStatusMap = new Map<number, ScheduleSegment>();
                                    for (const seg of segs) segStatusMap.set(seg.hour, seg);
                                    const sentCount = segs.filter(seg => seg.status === 'sent').length;
                                    const errorCount = segs.filter(seg => seg.status === 'error').length;
                                    
                                    return (
                                        <div className="space-y-1.5 pt-1">
                                            <div className="flex items-center gap-1">
                                                {allSlots.map((slot) => {
                                                    const seg = segStatusMap.get(slot.hour);
                                                    const isScheduled = !!seg;
                                                    const status = seg?.status || 'pending';
                                                    
                                                    return (
                                                        <div
                                                            key={slot.idx}
                                                            title={seg?.error || ''}
                                                            className={`flex-1 flex flex-col items-center justify-center gap-0 py-1 rounded-lg text-[10px] font-semibold transition-all ${
                                                                !isScheduled
                                                                    ? "bg-slate-50 text-slate-300 border border-slate-100"
                                                                    : status === 'sent'
                                                                    ? "bg-green-100 text-green-700 border border-green-200"
                                                                    : status === 'error'
                                                                    ? "bg-red-100 text-red-700 border border-red-200"
                                                                    : status === 'sending'
                                                                    ? "bg-amber-100 text-amber-700 border border-amber-300 animate-pulse"
                                                                    : "bg-yellow-50 text-yellow-700 border border-yellow-200"
                                                            }`}
                                                        >
                                                            <div className="flex items-center gap-0.5">
                                                                <span>{slot.icon}</span>
                                                                <span>{slot.time}</span>
                                                                {!isScheduled && <span>—</span>}
                                                                {isScheduled && status === 'sent' && <span>✓</span>}
                                                                {isScheduled && status === 'error' && <span>✗</span>}
                                                                {isScheduled && status === 'sending' && <span>⚡</span>}
                                                                {isScheduled && status === 'pending' && <span>⏳</span>}
                                                            </div>
                                                            {isScheduled && seg?.totalRecipients != null && (
                                                                <span className="text-[8px] opacity-70">
                                                                    {seg.successCount ?? 0}/{seg.totalRecipients}
                                                                </span>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-[10px] text-slate-400">
                                                    Tổng: <span className="font-semibold text-green-600">✅ {segs.reduce((a, seg) => a + (seg.successCount || 0), 0)}</span>
                                                    <span className="text-slate-300 mx-0.5">/</span>
                                                    <span className="font-semibold text-slate-500">{segs.reduce((a, seg) => a + (seg.totalRecipients || 0), 0)} data</span>
                                                    {segs.some(seg => (seg.errorCount || 0) > 0) && (
                                                        <span className="text-red-400 ml-1">❌ {segs.reduce((a, seg) => a + (seg.errorCount || 0), 0)} lỗi</span>
                                                    )}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-1.5">
                                                <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                                    <div
                                                        className={`h-full rounded-full transition-all duration-500 ${
                                                            errorCount > 0 && sentCount === 0
                                                                ? 'bg-gradient-to-r from-red-400 to-red-500'
                                                                : 'bg-gradient-to-r from-green-400 to-emerald-500'
                                                        }`}
                                                        style={{ width: `${Math.min(100, (sentCount / segs.length) * 100)}%` }}
                                                    />
                                                </div>
                                                <span className="text-[9px] text-slate-400 font-medium whitespace-nowrap">
                                                    {sentCount}/{segs.length} đoạn
                                                    {errorCount > 0 && <span className="text-red-400"> · {errorCount} lỗi</span>}
                                                </span>
                                            </div>
                                        </div>
                                    );
                                })()}
                                {isEditing && (
                                    <div className="flex gap-2">
                                        <input value={editNote} onChange={e => setEditNote(e.target.value)} placeholder="Ghi chú..." className="flex-1 text-xs rounded-lg border border-blue-200 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-300" />
                                        <button onClick={() => saveNote(s.id)} className="text-xs px-2 py-1 rounded-lg bg-blue-500 text-white hover:bg-blue-600">Lưu</button>
                                        <button onClick={() => setEditingScheduleId(null)} className="text-xs px-2 py-1 rounded-lg bg-slate-200 text-slate-600 hover:bg-slate-300">Huỷ</button>
                                    </div>
                                )}
                                {!isEditing && s.note && <p className="text-[10px] text-slate-400 italic">📝 {s.note}</p>}

                                {/* ─── Ngày bắt đầu + Lịch sử bắn thành công ─── */}
                                <div className="pt-1.5 border-t border-slate-100 space-y-1">
                                    <div className="flex items-center gap-1.5">
                                        <CalendarClock className="h-3 w-3 text-slate-400 shrink-0" />
                                        <span className="text-[10px] text-slate-400">
                                            Bắt đầu: <span className="font-semibold text-slate-500">{new Date(s.createdAt).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                                        </span>
                                    </div>
                                    {s.firedDates && s.firedDates.length > 0 && (
                                        <div className="flex items-start gap-1.5">
                                            <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0 mt-0.5" />
                                            <div className="flex flex-wrap gap-1">
                                                {s.firedDates.slice(-10).map(date => (
                                                    <span key={date} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-green-50 border border-green-200 text-[9px] font-semibold text-green-700">
                                                        ✓ {new Date(date + 'T00:00:00').toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {(!s.firedDates || s.firedDates.length === 0) && (
                                        <div className="flex items-center gap-1.5">
                                            <CheckCircle2 className="h-3 w-3 text-slate-300 shrink-0" />
                                            <span className="text-[10px] text-slate-300 italic">Chưa bắn thành công ngày nào</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
