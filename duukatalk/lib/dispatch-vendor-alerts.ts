import { CREDIT_LIMIT, normalizeCustomerName } from "./credit";
import { getDb } from "./firebase";
import { getVendorCurrency } from "./auth";
import { formatDay, formatMoney } from "./money";
import {
  Language,
  RiskFlag,
  RiskTransaction,
  alertFingerprint,
  evaluateRiskFlags,
  localize,
} from "./risk-flags";
import { sendSms } from "./sms";

const SMS_ALERTS_COLLECTION = "sms_alerts";

/** The vendor's own phone from signup, falling back to AT_VENDOR_PHONE. */
async function vendorPhone(vendorId: string): Promise<string | null> {
  try {
    const snap = await getDb().collection("vendors").doc(vendorId).get();
    const phone = snap.exists ? snap.data()?.phone : undefined;
    if (typeof phone === "string" && phone.trim()) return phone.trim();
  } catch (error) {
    console.error("Failed to look up vendor phone:", error);
  }
  return process.env.AT_VENDOR_PHONE?.trim() || null;
}

// Scoped per vendor: flag IDs such as "credit_john" or "shop_cash_vs_credit"
// are not unique across shops, and sharing one record made shops overwrite
// each other's "already sent" marker, so texts were sent again.
function firestoreAlertId(vendorId: string, flagId: string, channel: "vendor" | "customer"): string {
  return `${vendorId}_${channel}_${flagId}`.replace(/[/#[\]]/g, "_").slice(0, 700);
}

export async function resolveCustomerPhone(
  customerName: string,
  explicitPhone?: string | null,
  vendorId?: string,
): Promise<string | null> {
  if (explicitPhone?.trim()) return explicitPhone.trim();

  try {
    const scopedCustomerKey = vendorId
      ? `${vendorId}_${normalizeCustomerName(customerName)}`
      : normalizeCustomerName(customerName);

    const customerSnap = await getDb().collection("customers").doc(scopedCustomerKey).get();
    const stored = customerSnap.exists ? customerSnap.data()?.phone : undefined;
    if (typeof stored === "string" && stored.trim()) return stored.trim();
  } catch (error) {
    console.error("Failed to look up customer phone by scoped customer record:", error);
  }

  try {
    if (!vendorId) {
      return process.env.AT_DEMO_CUSTOMER_PHONE?.trim() || null;
    }

    const customerRows = await getDb()
      .collection("customers")
      .where("vendor_id", "==", vendorId)
      .where("customer_name", "==", customerName.trim())
      .get();
    for (const row of customerRows.docs) {
      const rowPhone = row.data().phone;
      if (typeof rowPhone === "string" && rowPhone.trim()) {
        return rowPhone.trim();
      }
    }
  } catch (error) {
    console.error("Failed to fall back to vendor scoped customer phone lookup:", error);
  }

  return process.env.AT_DEMO_CUSTOMER_PHONE?.trim() || null;
}

/**
 * Atomically claims an alert before sending it. Saving a sale and reloading
 * the dashboard both start an alert sweep at the same moment; with a plain
 * "check, send, then mark" both sweeps passed the check and each sent the
 * text. Inside a transaction only one of them can claim it.
 */
async function claimAlert(
  docId: string,
  fingerprint: string,
): Promise<{ claimed: boolean; previousFingerprint: string | null }> {
  const db = getDb();
  const ref = db.collection(SMS_ALERTS_COLLECTION).doc(docId);

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const previous = snap.exists ? snap.data()?.fingerprint : undefined;
    const previousFingerprint = typeof previous === "string" ? previous : null;

    if (previousFingerprint === fingerprint) {
      return { claimed: false, previousFingerprint };
    }

    transaction.set(
      ref,
      { fingerprint, status: "sending", claimed_at: new Date().toISOString() },
      { merge: true },
    );
    return { claimed: true, previousFingerprint };
  });
}

function customerAlertMessage(flag: RiskFlag, language: Language, currency: string): string | null {
  if (flag.type === "credit_risk") {
    const owed = Number(flag.details.amountOwed) || 0;
    return localize(
      language,
      `DuukaTalk: You are over your vendor's ${formatMoney(CREDIT_LIMIT, currency)} credit limit. You now owe ${formatMoney(owed, currency)}. Please pay.`,
      `DuukaTalk: Osukkiridde ekkomo ly'omubanja lya ${formatMoney(CREDIT_LIMIT, currency)} okuva ku katale ko. Kati olina ${formatMoney(owed, currency)}. Nsaba osasule.`,
      `DuukaTalk: Umepita kikomo cha mkopo cha ${formatMoney(CREDIT_LIMIT, currency)} kwa muuzaji wako. Sasa una deni la ${formatMoney(owed, currency)}. Tafadhali lipa.`,
      `DuukaTalk: تجاوزت الحد الائتماني الخاص بالبائع وهو ${formatMoney(CREDIT_LIMIT, currency)}. أنت الآن مدين بـ ${formatMoney(owed, currency)}. يرجى السداد.`,
      `DuukaTalk: Vous avez dépassé la limite de crédit de votre vendeur de ${formatMoney(CREDIT_LIMIT, currency)}. Vous devez maintenant ${formatMoney(owed, currency)}. Veuillez payer.`,
    );
  }

  if (flag.type === "due_date") {
    const item = String(flag.details.item ?? "your purchase");
    const dueDate = formatDay(String(flag.details.dueDate ?? ""));
    return localize(
      language,
      `DuukaTalk: Your payment for ${item} was due ${dueDate}. Please settle with your vendor.`,
      `DuukaTalk: Okusasula kwo ku ${item} kwali kutuuse ${dueDate}. Nsaba osasule katale ko.`,
      `DuukaTalk: Malipo yako ya ${item} yalikuwa yakusubiri ${dueDate}. Tafadhali lipa kwa muuzaji wako.`,
      `DuukaTalk: كان دفعك مقابل ${item} مستحقًا بتاريخ ${dueDate}. يرجى التسوية مع البائع.`,
      `DuukaTalk: Votre paiement pour ${item} était dû le ${dueDate}. Veuillez vous régler avec votre vendeur.`,
    );
  }

  return null;
}

async function sendOnce(options: {
  docId: string;
  fingerprint: string;
  phone: string;
  message: string;
  extra: Record<string, unknown>;
}): Promise<boolean> {
  const { claimed, previousFingerprint } = await claimAlert(options.docId, options.fingerprint);
  if (!claimed) return false;

  const ref = getDb().collection(SMS_ALERTS_COLLECTION).doc(options.docId);
  const result = await sendSms(options.phone, options.message);

  if (!result.sent) {
    // Release the claim so a later sweep can retry.
    await ref.set({ fingerprint: previousFingerprint, status: "failed" }, { merge: true });
    return false;
  }

  await ref.set(
    { status: "sent", sent_at: new Date().toISOString(), ...options.extra },
    { merge: true },
  );
  return true;
}

export async function getAlertSummary(vendorId: string): Promise<{ vendorAlerts: number; customerAlerts: number; flags: number }> {
  const snapshot = await getDb()
    .collection(SMS_ALERTS_COLLECTION)
    .where("vendor_id", "==", vendorId)
    .where("status", "==", "sent")
    .get();
  let vendorAlerts = 0;
  let customerAlerts = 0;
  const flagIds = new Set<string>();

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data() as { channel?: string; flag_id?: string };
    if (data.channel === 'vendor') vendorAlerts += 1;
    if (data.channel === 'customer') customerAlerts += 1;
    if (data.flag_id) flagIds.add(String(data.flag_id));
  }

  return { vendorAlerts, customerAlerts, flags: flagIds.size };
}

export async function dispatchVendorAlertSms(
  language: Language,
  transactions?: RiskTransaction[],
  vendorId?: string,
): Promise<{ vendorAlerts: number; customerAlerts: number; flags: number }> {
  // No vendor given (the daily cron): sweep each vendor separately so one
  // shop's flags are never mixed with another's.
  if (!vendorId) {
    const vendors = await getDb().collection("vendors").get();
    const total = { vendorAlerts: 0, customerAlerts: 0, flags: 0 };
    for (const vendor of vendors.docs) {
      try {
        const result = await dispatchVendorAlertSms(language, undefined, vendor.id);
        total.vendorAlerts += result.vendorAlerts;
        total.customerAlerts += result.customerAlerts;
        total.flags += result.flags;
      } catch (error) {
        console.error(`Alert sweep failed for ${vendor.id}:`, error);
      }
    }
    return total;
  }

  let rows = transactions;
  if (!rows) {
    const snapshot = await getDb()
      .collection("transactions")
      .where("vendor_id", "==", vendorId)
      .get();
    rows = snapshot.docs.map((docSnap) => docSnap.data() as RiskTransaction);
  }

  const currency = await getVendorCurrency(vendorId);
  const flags = evaluateRiskFlags(rows, language, currency);
  const shopPhone = await vendorPhone(vendorId);
  let vendorAlerts = 0;
  let customerAlerts = 0;

  for (const flag of flags) {
    const fingerprint = alertFingerprint(flag);

    if (shopPhone) {
      const sent = await sendOnce({
        docId: firestoreAlertId(vendorId, flag.id, "vendor"),
        fingerprint,
        phone: shopPhone,
        message: `DuukaTalk alert: ${flag.message}`,
        extra: { channel: "vendor", vendor_id: vendorId, flag_id: flag.id, type: flag.type },
      });
      if (sent) vendorAlerts += 1;
    }

    const customerMessage = customerAlertMessage(flag, language, currency);
    const customerName = flag.details.customerName;
    if (customerMessage && typeof customerName === "string" && customerName.trim()) {
      const phone = await resolveCustomerPhone(customerName, null, vendorId);
      if (phone) {
        const sent = await sendOnce({
          docId: firestoreAlertId(vendorId, flag.id, "customer"),
          fingerprint,
          phone,
          message: customerMessage,
          extra: { channel: "customer", vendor_id: vendorId, flag_id: flag.id, type: flag.type, customer: customerName },
        });
        if (sent) customerAlerts += 1;
      }
    }
  }

  return { vendorAlerts, customerAlerts, flags: flags.length };
}
