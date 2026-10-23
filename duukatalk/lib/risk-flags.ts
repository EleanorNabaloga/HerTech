import { CREDIT_LIMIT, LARGE_QUANTITY_THRESHOLD, isOutstandingCredit } from "./credit";
import { formatDay, formatMoney } from "./money";

export type Language = "EN" | "LUG" | "SW" | "AR" | "FR" | "MIX";

export type RiskFlagType = "credit_risk" | "stock_movement" | "due_date" | "cash_vs_credit";

export type RiskFlag = {
  id: string;
  type: RiskFlagType;
  severity: "warning" | "critical";
  message: string;
  details: Record<string, unknown>;
};

export type RiskTransaction = {
  transaction_id?: string;
  payment_type?: string;
  customer_name?: string | null;
  total_amount?: number | string;
  quantity?: number | string;
  item?: string;
  due_date?: string | null;
  timestamp?: string;
  settled?: boolean;
};

export function localize(
  language: Language,
  english: string,
  luganda: string,
  swahili?: string,
  arabic?: string,
  french?: string,
): string {
  switch (language) {
    case "LUG":
      return luganda;
    case "SW":
      return swahili || english;
    case "AR":
      return arabic || english;
    case "FR":
      return french || english;
    case "MIX":
      return `${english} · ${luganda}`;
    case "EN":
    default:
      return english;
  }
}

/** Shown when a customer is already over the credit limit (all languages). */
export function creditLimitWarning(
  language: Language,
  customer: string,
  outstandingCredit: number,
  currency?: string,
): string {
  return localize(
    language,
    `Warning: ${customer} already has ${formatMoney(outstandingCredit, currency)} in outstanding credit, above the ${formatMoney(CREDIT_LIMIT, currency)} limit. Pause new lending and recover cash first. Use the tick to accept the warning and record, or use the cross to refuse.`,
    `Okulabula: ${customer} alina amabanja agasigadde ${formatMoney(outstandingCredit, currency)}, okusukka ku kkomo lya ${formatMoney(CREDIT_LIMIT, currency)}. Lekeka okukuza obulava obupya era funya ssente. Kozesa akatikkulu okukkiriza okulabula n'okuwandiika, oba akamukiye okugaana.`,
    `Tahadhari: ${customer} tayari ana deni la ${formatMoney(outstandingCredit, currency)}, lililo juu ya kikomo cha ${formatMoney(CREDIT_LIMIT, currency)}. Simama kutoa mkopo mpya na kukusanya pesa kwanza. Tumia alama ya tiki kukubali tahadhari na kurekodi, au alama ya x kukataa.`,
    `تحذير: ${customer} لديه بالفعل ديون مستحقة قدرها ${formatMoney(outstandingCredit, currency)}، وهي أعلى من الحد ${formatMoney(CREDIT_LIMIT, currency)}. أوقف منح القروض الجديدة وابدأ في تحصيل النقد أولاً. استخدم علامة صح للتأكيد أو علامة × للرفض.`,
    `Avertissement : ${customer} a déjà un crédit impayé de ${formatMoney(outstandingCredit, currency)}, au-dessus de la limite de ${formatMoney(CREDIT_LIMIT, currency)}. Suspendre tout nouveau prêt et récupérer l’argent d’abord. Utilisez la coche pour accepter l’avertissement et enregistrer, ou la croix pour refuser.`,
  );
}

export function parseLanguage(value: string | null | undefined): Language {
  if (value === "EN" || value === "LUG" || value === "SW" || value === "AR" || value === "FR" || value === "MIX") return value as Language;
  return "EN";
}

export function evaluateRiskFlags(
  transactions: RiskTransaction[],
  language: Language = "EN",
  currency?: string,
): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const today = new Date().toISOString().split("T")[0];

  const creditTotals: Record<string, number> = {};
  for (const txn of transactions) {
    if (isOutstandingCredit(txn)) {
      const name = txn.customer_name || "Unknown";
      const amount = Number(txn.total_amount) || 0;
      creditTotals[name] = (creditTotals[name] || 0) + amount;
    }
  }
  for (const [name, total] of Object.entries(creditTotals)) {
    if (total > CREDIT_LIMIT) {
      flags.push({
        id: `credit_${name}`,
        type: "credit_risk",
        severity: total > CREDIT_LIMIT * 1.5 ? "critical" : "warning",
        message: localize(
          language,
          `${name} now owes ${formatMoney(total, currency)}, over the ${formatMoney(CREDIT_LIMIT, currency)} limit`,
          `${name} kati alina omubanja gwa ${formatMoney(total, currency)}, gusukkiridde ekkomo lya ${formatMoney(CREDIT_LIMIT, currency)}`,
          `${name} anadaiwa ${formatMoney(total, currency)}, zaidi ya kikomo cha ${formatMoney(CREDIT_LIMIT, currency)}`,
          `${name} مدين الآن بـ ${formatMoney(total, currency)}، وهو أعلى من الحد ${formatMoney(CREDIT_LIMIT, currency)}`,
          `${name} doit maintenant ${formatMoney(total, currency)}, au-delà de la limite de ${formatMoney(CREDIT_LIMIT, currency)}`,
        ),
        details: { customerName: name, amountOwed: total, limit: CREDIT_LIMIT },
      });
    }
  }

  for (const txn of transactions) {
    const quantity = Number(txn.quantity) || 0;
    if (quantity > LARGE_QUANTITY_THRESHOLD) {
      flags.push({
        id: `stock_${txn.transaction_id}`,
        type: "stock_movement",
        severity: "warning",
        message: localize(
          language,
          `Stock movement alert: unusually large quantity recorded for ${txn.item} (${quantity})`,
          `Okulabula kwa stock: omuwendo omunene ogutali bulijjo gulabiddwa ku ${txn.item} (${quantity})`,
          `Tahadhari ya hisa: kiasi kikubwa sana kwa ${txn.item} (${quantity})`,
          `تنبيه مخزون: كمية كبيرة غير معتادة سجلت لـ ${txn.item} (${quantity})`,
          `Alerte stock : quantité inhabituellement élevée pour ${txn.item} (${quantity})`,
        ),
        details: {
          item: txn.item,
          quantity,
          threshold: LARGE_QUANTITY_THRESHOLD,
          transactionId: txn.transaction_id,
        },
      });
    }
  }

  for (const txn of transactions) {
    if (!isOutstandingCredit(txn)) continue;
    if (!txn.due_date || txn.due_date === "N/A") continue;

    const dueDay = txn.due_date.slice(0, 10);
    if (dueDay <= today) {
      flags.push({
        id: `due_${txn.transaction_id}`,
        type: "due_date",
        severity: dueDay < today ? "critical" : "warning",
        message: localize(
          language,
          `${txn.customer_name}'s payment for ${txn.item} was due ${formatDay(txn.due_date)}`,
          `Okusasula kwa ${txn.customer_name} ku ${txn.item} kwali kutuuse ${formatDay(txn.due_date)}`,
          `${txn.customer_name}'s malipo ya ${txn.item} yalikuwa yakusubiri ${formatDay(txn.due_date)}`,
          `استحق الدفع لـ ${txn.customer_name} مقابل ${txn.item} بتاريخ ${formatDay(txn.due_date)}`,
          `Le paiement de ${txn.customer_name} pour ${txn.item} était dû le ${formatDay(txn.due_date)}`,
        ),
        details: {
          customerName: txn.customer_name,
          item: txn.item,
          dueDate: txn.due_date,
          amount: Number(txn.total_amount) || 0,
        },
      });
    }
  }

  let totalCash = 0;
  let totalCredit = 0;
  for (const txn of transactions) {
    const amount = Number(txn.total_amount) || 0;
    if ((txn.payment_type || "").toLowerCase() === "cash" || txn.settled === true) {
      totalCash += amount;
    }
    if (isOutstandingCredit(txn)) totalCredit += amount;
  }
  if (totalCredit > totalCash) {
    flags.push({
      id: "shop_cash_vs_credit",
      type: "cash_vs_credit",
      severity: "critical",
      message: localize(
        language,
        `Cash at hand is lower than outstanding credit: cash ${formatMoney(totalCash, currency)} vs credit ${formatMoney(totalCredit, currency)}`,
        `Ssente eziriwo zisinga obutono okusinga amabanja agasigadde: cash ${formatMoney(totalCash, currency)} vs credit ${formatMoney(totalCredit, currency)}`,
        `Pesa zilizopo ni chache kuliko deni iliyobaki: cash ${formatMoney(totalCash, currency)} dhidi ya credit ${formatMoney(totalCredit, currency)}`,
        `النقد المتوفر أقل من الديون المستحقة: نقد ${formatMoney(totalCash, currency)} مقابل دين ${formatMoney(totalCredit, currency)}`,
        `La trésorerie disponible est inférieure au crédit restant : cash ${formatMoney(totalCash, currency)} versus crédit ${formatMoney(totalCredit, currency)}`,
      ),
      details: { totalCash, totalCredit },
    });
  }

  return flags;
}

export function alertFingerprint(flag: RiskFlag): string {
  switch (flag.type) {
    case "credit_risk":
      return String(flag.details.amountOwed ?? flag.message);
    case "due_date":
      return `${flag.details.dueDate ?? ""}:${new Date().toISOString().split("T")[0]}`;
    case "stock_movement":
      return String(flag.details.transactionId ?? flag.id);
    case "cash_vs_credit":
      return `${flag.details.totalCash}:${flag.details.totalCredit}`;
    default:
      return flag.message;
  }
}
