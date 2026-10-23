import { dispatchVendorAlertSms, resolveCustomerPhone } from "./dispatch-vendor-alerts";
import { getDb } from "./firebase";
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

    const dueEn = input.dueDate && input.dueDate !== "N/A" ? ` Pay by ${input.dueDate}.` : "";
    const dueLug = input.dueDate && input.dueDate !== "N/A" ? ` Sasula nga ${input.dueDate}.` : "";
    const dueSw = input.dueDate && input.dueDate !== "N/A" ? ` Lipa kwa ${input.dueDate}.` : "";
    const dueAr = input.dueDate && input.dueDate !== "N/A" ? ` ادفع بتاريخ ${input.dueDate}.` : "";
    const dueFr = input.dueDate && input.dueDate !== "N/A" ? ` Payez avant ${input.dueDate}.` : "";

    const debtorMessage = localize(
      language,
      `DuukaTalk: You owe UGX ${input.amount.toLocaleString()} for ${input.item}.${dueEn} — from your vendor.`,
      `DuukaTalk: Olina omubanja gwa UGX ${input.amount.toLocaleString()} ku ${input.item}.${dueLug} — okuva ku katale ko.`,
      `DuukaTalk: Una deni la UGX ${input.amount.toLocaleString()} kwa ${input.item}.${dueSw} — kutoka kwa muuzaji wako.`,
      `DuukaTalk: أنت مدين بـ UGX ${input.amount.toLocaleString()} مقابل ${input.item}.${dueAr} — من البائع الخاص بك.`,
      `DuukaTalk: Vous devez UGX ${input.amount.toLocaleString()} pour ${input.item}.${dueFr} — de votre vendeur.`,
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
