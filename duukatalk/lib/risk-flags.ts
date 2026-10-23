import { CREDIT_LIMIT, LARGE_QUANTITY_THRESHOLD, isOutstandingCredit } from "./credit";

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
): string {
  return localize(
    language,
    `Warning: ${customer} already has UGX ${outstandingCredit.toLocaleString()} in outstanding credit, above the UGX ${CREDIT_LIMIT.toLocaleString()} limit. Pause new lending and recover cash first. Use the tick to accept the warning and record, or use the cross to refuse.`,
    `Okulabula: ${customer} alina amabanja agasigadde UGX ${outstandingCredit.toLocaleString()}, okusukka ku kkomo lya UGX ${CREDIT_LIMIT.toLocaleString()}. Lekeka okukuza obulava obupya era funya ssente. Kozesa akatikkulu okukkiriza okulabula n'okuwandiika, oba akamukiye okugaana.`,
    `Tahadhari: ${customer} tayari ana deni la UGX ${outstandingCredit.toLocaleString()}, lililo juu ya kikomo cha UGX ${CREDIT_LIMIT.toLocaleString()}. Simama kutoa mkopo mpya na kukusanya pesa kwanza. Tumia alama ya tiki kukubali tahadhari na kurekodi, au alama ya x kukataa.`,
    `تحذير: ${customer} لديه بالفعل ديون مستحقة قدرها UGX ${outstandingCredit.toLocaleString()}، وهي أعلى من الحد UGX ${CREDIT_LIMIT.toLocaleString()}. أوقف منح القروض الجديدة وابدأ في تحصيل النقد أولاً. استخدم علامة صح للتأكيد أو علامة × للرفض.`,
    `Avertissement : ${customer} a déjà un crédit impayé de UGX ${outstandingCredit.toLocaleString()}, au-dessus de la limite de UGX ${CREDIT_LIMIT.toLocaleString()}. Suspendre tout nouveau prêt et récupérer l’argent d’abord. Utilisez la coche pour accepter l’avertissement et enregistrer, ou la croix pour refuser.`,
  );
}

export function parseLanguage(value: string | null | undefined): Language {
  if (value === "EN" || value === "LUG" || value === "SW" || value === "AR" || value === "FR" || value === "MIX") return value as Language;
  return "EN";
}

export function evaluateRiskFlags(
  transactions: RiskTransaction[],
  language: Language = "EN",
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
          `${name} now owes UGX ${total.toLocaleString()}, over the ${CREDIT_LIMIT.toLocaleString()} limit`,
          `${name} kati alina omubanja gwa UGX ${total.toLocaleString()}, gusukkiridde ekkomo lya UGX ${CREDIT_LIMIT.toLocaleString()}`,
          `${name} anadaiwa UGX ${total.toLocaleString()}, zaidi ya kikomo cha UGX ${CREDIT_LIMIT.toLocaleString()}`,
          `${name} مدين الآن بـ UGX ${total.toLocaleString()}، وهو أعلى من الحد ${CREDIT_LIMIT.toLocaleString()}`,
          `${name} doit maintenant UGX ${total.toLocaleString()}, au-delà de la limite de ${CREDIT_LIMIT.toLocaleString()}`,
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
          `${txn.customer_name}'s payment for ${txn.item} was due ${txn.due_date}`,
          `Okusasula kwa ${txn.customer_name} ku ${txn.item} kwali kutuuse ${txn.due_date}`,
          `${txn.customer_name}'s malipo ya ${txn.item} yalikuwa yakusubiri ${txn.due_date}`,
          `استحق الدفع لـ ${txn.customer_name} مقابل ${txn.item} بتاريخ ${txn.due_date}`,
          `Le paiement de ${txn.customer_name} pour ${txn.item} était dû le ${txn.due_date}`,
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
        `Cash at hand is lower than outstanding credit: cash UGX ${totalCash.toLocaleString()} vs credit UGX ${totalCredit.toLocaleString()}`,
        `Ssente eziriwo zisinga obutono okusinga amabanja agasigadde: cash UGX ${totalCash.toLocaleString()} vs credit UGX ${totalCredit.toLocaleString()}`,
        `Pesa zilizopo ni chache kuliko deni iliyobaki: cash UGX ${totalCash.toLocaleString()} dhidi ya credit UGX ${totalCredit.toLocaleString()}`,
        `النقد المتوفر أقل من الديون المستحقة: نقد UGX ${totalCash.toLocaleString()} مقابل دين UGX ${totalCredit.toLocaleString()}`,
        `La trésorerie disponible est inférieure au crédit restant : cash UGX ${totalCash.toLocaleString()} versus crédit UGX ${totalCredit.toLocaleString()}`,
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
