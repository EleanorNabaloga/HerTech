/*
 * Formatting for server-side messages (SMS, alerts, warnings). Each vendor
 * picks a currency at signup; messages must use it rather than assume UGX.
 */

export const DEFAULT_CURRENCY = "UGX";

/** e.g. formatMoney(15000, "KES") -> "KES 15,000" */
export function formatMoney(amount: number, currency?: string | null): string {
  const code = currency?.trim() || DEFAULT_CURRENCY;
  const value = Number.isFinite(amount) ? amount : 0;
  return `${code} ${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/**
 * A stored date (ISO timestamp or YYYY-MM-DD) as a plain day, e.g.
 * "30/10/2026", so texts never show raw timestamps. Unreadable values are
 * returned unchanged.
 */
export function formatDay(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { timeZone: "UTC" });
}

/** Countries offered at signup, with dialling code and local currency. */
export const COUNTRIES: Array<{ name: string; code: string; currency: string }> = [
  { name: "Uganda", code: "+256", currency: "UGX" },
  { name: "Kenya", code: "+254", currency: "KES" },
  { name: "Tanzania", code: "+255", currency: "TZS" },
  { name: "Rwanda", code: "+250", currency: "RWF" },
  { name: "Burundi", code: "+257", currency: "BIF" },
  { name: "South Sudan", code: "+211", currency: "SSP" },
  { name: "Democratic Republic of the Congo", code: "+243", currency: "CDF" },
  { name: "Nigeria", code: "+234", currency: "NGN" },
  { name: "Ghana", code: "+233", currency: "GHS" },
  { name: "South Africa", code: "+27", currency: "ZAR" },
  { name: "United Kingdom", code: "+44", currency: "GBP" },
  { name: "United States", code: "+1", currency: "USD" },
];

/**
 * The vendor's currency: the one saved at signup, else their country's
 * currency (older accounts were saved without one), else UGX.
 */
export function resolveCurrency(
  currency?: string | null,
  country?: string | null,
): string {
  if (currency?.trim()) return currency.trim();
  const match = COUNTRIES.find(
    (option) => option.name.toLowerCase() === country?.trim().toLowerCase(),
  );
  return match?.currency ?? DEFAULT_CURRENCY;
}
