import { dispatchVendorAlertSms, resolveCustomerPhone } from "./dispatch-vendor-alerts";
import { getDb } from "./firebase";
import { getVendorCurrency } from "./auth";
import { formatDay, formatMoney } from "./money";
import { Language, localize, parseLanguage } from "./risk-flags";
import { sendSms } from "./sms";
import { normalizeCustomerName } from "./credit";

export async function rememberCustomerPhone(customerName: string, phone: string, vendorId?: string): Promise<void> {
  const customerKey = vendorId ? `${vendorId}_${normalizeCustomerName(customerName)}` : normalizeCustomerName(customerName);
  await getDb().collection("customers").doc(customerKey).set(
    { phone, vendor_id: vendorId ?? null, customer_name: customerName.trim(), updated_at: new Date().toISOString() },
    { merge: true },
  );
}

export async function notifyAfterTransaction(input: {
  customerName: string | null;
  paymentType: "cash" | "credit";
  item: string;
  amount: number;
  quantity: number;
  dueDate?: string | null;
  outstandingCredit?: number;
  customerPhone?: string | null;
  language?: Language;
  vendorId?: string;
}): Promise<{ debtorSms: boolean; vendorAlerts: number; customerAlerts: number }> {
  let debtorSms = false;
  const language = parseLanguage(input.language ?? "EN");

  if (input.paymentType === "credit" && input.customerName) {
    const customerPhone = await resolveCustomerPhone(input.customerName, input.customerPhone, input.vendorId);
    if (input.customerPhone?.trim()) {
      try {
        await rememberCustomerPhone(input.customerName, input.customerPhone.trim(), input.vendorId);
      } catch (error) {
        console.error("Failed to store customer phone:", error);
      }
    }

    const currency = await getVendorCurrency(input.vendorId);
    const due = formatDay(input.dueDate);
    const dueEn = input.dueDate && input.dueDate !== "N/A" ? ` Pay by ${due}.` : "";
    const dueLug = input.dueDate && input.dueDate !== "N/A" ? ` Sasula nga ${due}.` : "";
    const dueSw = input.dueDate && input.dueDate !== "N/A" ? ` Lipa kwa ${due}.` : "";
    const dueAr = input.dueDate && input.dueDate !== "N/A" ? ` ادفع بتاريخ ${due}.` : "";
    const dueFr = input.dueDate && input.dueDate !== "N/A" ? ` Payez avant ${due}.` : "";

    const debtorMessage = localize(
      language,
      `DuukaTalk: You owe ${formatMoney(input.amount, currency)} for ${input.item}.${dueEn} — from your vendor.`,
      `DuukaTalk: Olina omubanja gwa ${formatMoney(input.amount, currency)} ku ${input.item}.${dueLug} — okuva ku katale ko.`,
      `DuukaTalk: Una deni la ${formatMoney(input.amount, currency)} kwa ${input.item}.${dueSw} — kutoka kwa muuzaji wako.`,
      `DuukaTalk: أنت مدين بـ ${formatMoney(input.amount, currency)} مقابل ${input.item}.${dueAr} — من البائع الخاص بك.`,
      `DuukaTalk: Vous devez ${formatMoney(input.amount, currency)} pour ${input.item}.${dueFr} — de votre vendeur.`,
    );

    if (customerPhone) {
      try {
        const result = await sendSms(customerPhone, debtorMessage);
        debtorSms = result.sent;
      } catch (error) {
        console.error("Failed to send debtor SMS:", error);
      }
    }
  }

  void dispatchVendorAlertSms(language, undefined, input.vendorId)
    .catch((error) => console.error("Failed to dispatch vendor alert SMS:", error));

  return {
    debtorSms,
    vendorAlerts: 0,
    customerAlerts: 0,
  };
}
