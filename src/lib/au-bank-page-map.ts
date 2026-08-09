export type AuBankPageEntry = {
  slug: string;
  name: string;
  brandColor: string;
  accentColor: string;
  logoFile: string;
  pages: string[];
  country: string;
};

export const AU_BANK_PAGES: Record<string, AuBankPageEntry> = {
  "bendigo-bank": {
    slug: "bendigo-bank",
    name: "Bendigo Bank",
    brandColor: "#00579C",
    accentColor: "#00447A",
    logoFile: "/bank-logos/au/bendigo-bank.svg",
    pages: [
      "/au-banks/bendigo-bank/1.html",
      "/au-banks/bendigo-bank/2.html",
    ],
    country: "Australia",
  },
  "suncorp-bank": {
    slug: "suncorp-bank",
    name: "Suncorp Bank",
    brandColor: "#7A0019",
    accentColor: "#5C0013",
    logoFile: "/bank-logos/au/suncorp-bank.svg",
    pages: [
      "/au-banks/suncorp-bank/1.html",
    ],
    country: "Australia",
  },
  anz: {
    slug: "anz",
    name: "ANZ",
    brandColor: "#0A5CAD",
    accentColor: "#07437C",
    logoFile: "/bank-logos/au/anz.svg",
    pages: ["/au-banks/anz/1.html"],
    country: "Australia",
  },
  westpac: {
    slug: "westpac",
    name: "Westpac",
    brandColor: "#DA1B1B",
    accentColor: "#AE1515",
    logoFile: "/bank-logos/au/westpac.svg",
    pages: ["/au-banks/westpac/1.html"],
    country: "Australia",
  },
  "nab-bank": {
    slug: "nab-bank",
    name: "NAB",
    brandColor: "#C21D1D",
    accentColor: "#971717",
    logoFile: "/bank-logos/au/nab-bank.svg",
    pages: ["/au-banks/nab-bank/1.html"],
    country: "Australia",
  },
  commbank: {
    slug: "commbank",
    name: "Commonwealth Bank",
    brandColor: "#FDC500",
    accentColor: "#C99D00",
    logoFile: "/bank-logos/au/commbank.svg",
    pages: ["/au-banks/commbank/1.html"],
    country: "Australia",
  },
  macquarie: {
    slug: "macquarie",
    name: "Macquarie Bank",
    brandColor: "#000000",
    accentColor: "#1A1A1A",
    logoFile: "/bank-logos/au/macquarie.svg",
    pages: ["/au-banks/macquarie/1.html"],
    country: "Australia",
  },
  "ing-australia": {
    slug: "ing-australia",
    name: "ING Australia",
    brandColor: "#E65300",
    accentColor: "#B64100",
    logoFile: "/bank-logos/au/ing-australia.svg",
    pages: ["/au-banks/ing-australia/1.html"],
    country: "Australia",
  },
  "boq-classic": {
    slug: "boq-classic",
    name: "BOQ Classic Internet Banking",
    brandColor: "#7C1F9D",
    accentColor: "#5F1779",
    logoFile: "/bank-logos/au/boq-classic.svg",
    pages: ["/au-banks/boq-classic/1.html"],
    country: "Australia",
  },
  "myboq": {
    slug: "myboq",
    name: "myBOQ Internet Banking",
    brandColor: "#6610A0",
    accentColor: "#4D0C7D",
    logoFile: "/bank-logos/au/myboq.svg",
    pages: ["/au-banks/myboq/1.html"],
    country: "Australia",
  },
  "amp-bank": {
    slug: "amp-bank",
    name: "AMP Bank",
    brandColor: "#003366",
    accentColor: "#00264D",
    logoFile: "/bank-logos/au/amp-bank.svg",
    pages: ["/au-banks/amp-bank/1.html"],
    country: "Australia",
  },
  "northonline-amp": {
    slug: "northonline-amp",
    name: "North Online (AMP)",
    brandColor: "#003E7E",
    accentColor: "#002F5F",
    logoFile: "/bank-logos/au/northonline-amp.svg",
    pages: ["/au-banks/northonline-amp/1.html"],
    country: "Australia",
  },
  bankwest: {
    slug: "bankwest",
    name: "Bankwest",
    brandColor: "#2D2D2D",
    accentColor: "#1F1F1F",
    logoFile: "/bank-logos/au/bankwest.svg",
    pages: ["/au-banks/bankwest/1.html"],
    country: "Australia",
  },
  "me-bank": {
    slug: "me-bank",
    name: "ME Bank",
    brandColor: "#00B1EB",
    accentColor: "#008EBF",
    logoFile: "/bank-logos/au/me-bank.svg",
    pages: ["/au-banks/me-bank/1.html"],
    country: "Australia",
  },
  beyondbank: {
    slug: "beyondbank",
    name: "Beyond Bank",
    brandColor: "#A82E82",
    accentColor: "#852266",
    logoFile: "/bank-logos/au/beyondbank.svg",
    pages: ["/au-banks/beyondbank/1.html"],
    country: "Australia",
  },
  greatsouthernbank: {
    slug: "greatsouthernbank",
    name: "Great Southern Bank",
    brandColor: "#00674A",
    accentColor: "#004C37",
    logoFile: "/bank-logos/au/greatsouthernbank.svg",
    pages: ["/au-banks/greatsouthernbank/1.html"],
    country: "Australia",
  },
  greater: {
    slug: "greater",
    name: "Greater Bank",
    brandColor: "#006C4C",
    accentColor: "#005038",
    logoFile: "/bank-logos/au/greater.svg",
    pages: ["/au-banks/greater/1.html"],
    country: "Australia",
  },
};

export function getAuBankPageEntry(bankSlug: string): AuBankPageEntry | null {
  return AU_BANK_PAGES[bankSlug] ?? null;
}

export function getAuBankPages(bankSlug: string): string[] | null {
  return AU_BANK_PAGES[bankSlug]?.pages ?? null;
}

export function isAuExactHtmlBank(bankSlug: string): boolean {
  return Boolean(getAuBankPages(bankSlug));
}

export function getAllAuBankSeedEntries(): Array<{
  slug: string;
  name: string;
  country: string;
  brand_color: string;
  accent_color: string;
  logo_file: string;
}> {
  return Object.values(AU_BANK_PAGES).map((e) => ({
    slug: e.slug,
    name: e.name,
    country: e.country,
    brand_color: e.brandColor,
    accent_color: e.accentColor,
    logo_file: e.logoFile,
  }));
}
