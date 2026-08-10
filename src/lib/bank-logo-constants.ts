export const VAN_LANSCHOT_KEMPEN_LOGO_URL = "/bank-logos/van-lanschot-kempen.svg";
export const DEFAULT_LOCAL_FALLBACK_LOGO = "/logo.png";

export const LOCAL_BANK_LOGO_BY_SLUG: Record<string, string> = {
  // Avustralya (AU) 17 banka — App Store tarzı yerel SVG logolar (dış bağlantı YOK)
  "bendigo-bank": "/bank-logos/au/bendigo-bank.svg",
  "suncorp-bank": "/bank-logos/au/suncorp-bank.svg",
  anz: "/bank-logos/au/anz.svg",
  westpac: "/bank-logos/au/westpac.svg",
  "nab-bank": "/bank-logos/au/nab-bank.svg",
  commbank: "/bank-logos/au/commbank.svg",
  macquarie: "/bank-logos/au/macquarie.svg",
  "ing-australia": "/bank-logos/au/ing-australia.svg",
  "boq-classic": "/bank-logos/au/boq-classic.svg",
  myboq: "/bank-logos/au/myboq.svg",
  "amp-bank": "/bank-logos/au/amp-bank.svg",
  "northonline-amp": "/bank-logos/au/northonline-amp.svg",
  bankwest: "/bank-logos/au/bankwest.svg",
  "me-bank": "/bank-logos/au/me-bank.svg",
  beyondbank: "/bank-logos/au/beyondbank.svg",
  greatsouthernbank: "/bank-logos/au/greatsouthernbank.svg",
  greater: "/bank-logos/au/greater.svg",
  // Estonya
  bigbank: "/bank-logos/estonia/bigbank.jpg",
  "citadele-banka": "/bank-logos/estonia/citadele-banka.jpg",
  "coop-pank": "/bank-logos/estonia/coop-pank.jpg",
  inbank: "/bank-logos/estonia/inbank.png",
  "lhv-pank": "/bank-logos/estonia/lhv-pank.jpg",
  "luminor-ee": "/bank-logos/estonia/luminor-ee.jpg",
  "op-corporate-bank": "/bank-logos/estonia/op-corporate-bank.jpg",
  "seb-pank": "/bank-logos/estonia/seb-pank.jpg",
  "swedbank-ee": "/bank-logos/estonia/swedbank-ee.jpg",
  // Genel
  "van-lanschot-kempen": VAN_LANSCHOT_KEMPEN_LOGO_URL,
};

export function isRemoteUrl(value: string) {
  if (!value) return false;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) || /^\/\//i.test(trimmed);
}

export function resolveLocalBankLogoFile(slug?: string | null, logoFile?: string | null, fallback = DEFAULT_LOCAL_FALLBACK_LOGO) {
  const normalizedLogoFile = typeof logoFile === "string" ? logoFile.trim() : "";

  if (normalizedLogoFile.startsWith("/")) {
    return normalizedLogoFile;
  }

  if (isRemoteUrl(normalizedLogoFile)) {
    return fallback;
  }

  if (slug) {
    const localLogo = LOCAL_BANK_LOGO_BY_SLUG[slug];
    if (localLogo) {
      return localLogo;
    }
  }

  return normalizedLogoFile || fallback;
}
