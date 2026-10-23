export const CREDIT_LIMIT = 15000;
export const LARGE_QUANTITY_THRESHOLD = 20;
export const SAVINGS_PERCENT = 10;
export const HIGH_STRESS_SAVINGS_PERCENT = 20;
export const CAUTIOUS_SAVINGS_PERCENT = 15;
export const LOW_SALES_SAVINGS_PERCENT = 5;
export const MAX_CREDIT_TO_SALES_RATIO = 0.5;

import { formatMoney } from "./money";

export type GuidanceLanguage = "EN" | "LUG" | "MIX";

export function normalizeCustomerName(name: string | null | undefined): string {
  return (name ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function parseGuidanceLanguage(value: string | null | undefined): GuidanceLanguage {
  if (value === "EN" || value === "LUG" || value === "MIX") return value;
  return "EN";
}

export function localizeGuidance(language: GuidanceLanguage, english: string, luganda: string): string {
  if (language === "EN") return english;
  if (language === "LUG") return luganda;
  return `${english} · ${luganda}`;
}

export function isOutstandingCredit(txn: {
  payment_type?: string;
  settled?: boolean;
}): boolean {
  return (txn.payment_type || "").toLowerCase() === "credit" && txn.settled !== true;
}

export function calculateSavingsRecommendation(totalSales: number, totalCreditOutstanding = 0): number {
  const creditToSalesRatio = calculateCreditToSalesRatio(totalSales, totalCreditOutstanding);
  let savingsPercent = SAVINGS_PERCENT;

  if (totalSales <= 0) {
    savingsPercent = LOW_SALES_SAVINGS_PERCENT;
  } else if (creditToSalesRatio > MAX_CREDIT_TO_SALES_RATIO) {
    savingsPercent = HIGH_STRESS_SAVINGS_PERCENT;
  } else if (creditToSalesRatio >= 0.3) {
    savingsPercent = CAUTIOUS_SAVINGS_PERCENT;
  }

  return Math.round(totalSales * (savingsPercent / 100));
}

export function calculateCreditToSalesRatio(totalSales: number, totalCreditOutstanding: number): number {
  if (!Number.isFinite(totalSales) || totalSales <= 0) return 0;
  return Math.min(1, Math.max(0, totalCreditOutstanding / Math.max(totalSales, 1)));
}

export function loanReadinessScore(totalSales: number, totalCreditOutstanding: number): number {
  if (!Number.isFinite(totalSales) || totalSales <= 0) return 0;

  const creditToSalesRatio = calculateCreditToSalesRatio(totalSales, totalCreditOutstanding);
  const savingsRatio = Math.min(50, Math.max(0, SAVINGS_PERCENT));
  const debtRatio = Math.min(50, Math.max(0, 50 - (creditToSalesRatio * 100)));
  const salesMomentum = Math.min(20, Math.max(0, Math.round(Math.min(1, totalSales / Math.max(totalSales, 1)) * 20)));

  const baseScore = savingsRatio + debtRatio + salesMomentum;
  if (creditToSalesRatio > MAX_CREDIT_TO_SALES_RATIO) {
    return Math.round(Math.min(35, Math.max(5, baseScore * 0.45)));
  }

  return Math.round(Math.min(100, Math.max(5, baseScore)));
}

/** Which coach message applies; the app translates it on screen. */
export type AdviceCode = "stop_lending" | "cautious" | "healthy";

export type LoanGuidance = {
  adviceCode: AdviceCode;
  recommendedSavings: number;
  savingsPercent: number;
  creditToSalesRatio: number;
  creditSharePercent: number;
  loanReadinessScore: number;
  loanAdvice: string;
  shouldStopLending: boolean;
};

export function buildLoanGuidance(
  totalSales: number,
  totalCreditOutstanding: number,
  language: GuidanceLanguage = "EN",
  currency?: string,
): LoanGuidance {
  const creditToSalesRatio = calculateCreditToSalesRatio(totalSales, totalCreditOutstanding);
  const creditSharePercent = Math.round(creditToSalesRatio * 100);
  const score = loanReadinessScore(totalSales, totalCreditOutstanding);
  const shouldStopLending = creditToSalesRatio > MAX_CREDIT_TO_SALES_RATIO;

  let savingsPercent = SAVINGS_PERCENT;
  if (totalSales <= 0) {
    savingsPercent = LOW_SALES_SAVINGS_PERCENT;
  } else if (creditToSalesRatio > MAX_CREDIT_TO_SALES_RATIO) {
    savingsPercent = HIGH_STRESS_SAVINGS_PERCENT;
  } else if (creditToSalesRatio >= 0.3) {
    savingsPercent = CAUTIOUS_SAVINGS_PERCENT;
  }

  const recommendedSavings = Math.round(totalSales * (savingsPercent / 100));
  const savingsTarget = Math.round(totalSales * (savingsPercent / 100));
  const savingsTargetMessageEn = `Save ${savingsPercent}% of sales, about ${formatMoney(savingsTarget, currency)}. Keep saving every week. This helps your money record look strong and makes it easier for banks like ABSA to trust you for a loan.`;
  const savingsTargetMessageLug = `Tereka ${savingsPercent}% ku bigobawo, nga buli ${formatMoney(savingsTarget, currency)}. Terekeranga buli wiiki. Kino kiyamba ebiwandiiko byo okusobola okuba ebirungi era banki nga ABSA bayinza okukukkiriza olwanji.`;
  const savingsTargetMessage = localizeGuidance(language, savingsTargetMessageEn, savingsTargetMessageLug);

  let advice = savingsTargetMessage;
  const adviceCode: AdviceCode = shouldStopLending
    ? "stop_lending"
    : creditToSalesRatio >= 0.3
      ? "cautious"
      : "healthy";
  if (shouldStopLending) {
    const english = `Stop giving new credit now. Credit is ${creditSharePercent}% of sales, which is too high. First collect debts and save ${savingsPercent}% of sales, about ${formatMoney(savingsTarget, currency)}. A clear savings record can help banks like ABSA trust you.`;
    const luganda = `Lekeka okukuza obulava obupya kati. Amabanja gali ${creditSharePercent}% ku bigobawo, go maanyi. Funya amabanja era teeka ${savingsPercent}% ku bigobawo, nga buli ${formatMoney(savingsTarget, currency)}. Ebiwandiiko by'okutereka ebirungi biyinza okukuza obwesigibwa bwa banki nga ABSA.`;
    advice = localizeGuidance(language, english, luganda);
  } else if (creditToSalesRatio >= 0.3) {
    const english = `Cash is okay, but credit is ${creditSharePercent}% of sales. Be careful with new loans. Collect repayments, save ${savingsPercent}% of sales, about ${formatMoney(savingsTarget, currency)}, and keep a simple savings record. This helps banks like ABSA see you as ready for a loan.`;
    const luganda = `Ssente ziri bulungi, naye amabanja gali ${creditSharePercent}% ku bigobawo. Kukuza obulava obupya okuteekateeka. Funya ebigoberera, teeka ${savingsPercent}% ku bigobawo, nga buli ${formatMoney(savingsTarget, currency)}, era otereke ebiwandiiko ebirungi. Kino kiyamba banki nga ABSA okukulaba ng'oyagala olwanji.`;
    advice = localizeGuidance(language, english, luganda);
  } else {
    const english = `Sales are stronger than credit. Keep adding small credit carefully, save ${savingsPercent}% of sales, about ${formatMoney(savingsTarget, currency)}, and keep saving every week. This helps banks like ABSA trust your sales record and may help you get a loan.`;
    const luganda = `Ebigobawo byazaala nnyo okusinga amabanja. Kukuza obulava obupya obutono, teeka ${savingsPercent}% ku bigobawo, nga buli ${formatMoney(savingsTarget, currency)}, era terekeranga buli wiiki. Kino kiyamba banki nga ABSA okukulaba ng'olina ekitabo ekirungi era kiyinza okukuyamba okufuna olwanji.`;
    advice = localizeGuidance(language, english, luganda);
  }

  return {
    adviceCode,
    recommendedSavings,
    savingsPercent,
    creditToSalesRatio,
    creditSharePercent,
    loanReadinessScore: score,
    loanAdvice: advice,
    shouldStopLending,
  };
}
