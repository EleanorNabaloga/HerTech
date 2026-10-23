import { createHash } from "crypto";
import { getDb } from "./firebase";
import { DEFAULT_CURRENCY, resolveCurrency } from "./money";

const VENDORS_COLLECTION = "vendors";
const COUNTERS_COLLECTION = "counters";
const VENDOR_COUNTER_DOC = "vendor_id_counter";

const MAX_PIN_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 60 * 60 * 1000;

export interface VendorRecord {
  vendorId: string;
  hashedPin: string;
  businessName: string;
  businessNameLower: string;
  ownerName: string;
  phone: string;
  country: string;
  currency: string;
  failedAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoginResult {
  success: boolean;
  error?: string;
  attemptsRemaining?: number;
  lockedUntil?: string;

  // Vendor information returned after successful login
  vendorId?: string;
  businessName?: string;
  ownerName?: string;
  phone?: string;
  country?: string;
  currency?: string;
}

export interface SignupResult {
  success: boolean;
  vendorId: string;
}

function hashPin(pin: string): string {
  const salt = process.env.PIN_HASH_SALT;

  if (!salt) {
    throw new Error("PIN_HASH_SALT is not configured");
  }

  return createHash("sha256")
    .update(`${salt}:${pin}`)
    .digest("hex");
}

function isValidPinFormat(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

async function getNextVendorId(): Promise<string> {
  const db = getDb();
  const counterRef = db
    .collection(COUNTERS_COLLECTION)
    .doc(VENDOR_COUNTER_DOC);

  const nextNumber = await db.runTransaction(
    async (transaction) => {
      const counterSnap = await transaction.get(counterRef);

      const current = counterSnap.exists
        ? (counterSnap.data()?.value as number)
        : 0;

      const next = current + 1;

      transaction.set(
        counterRef,
        { value: next },
        { merge: true }
      );

      return next;
    }
  );

  return `vendor_${String(nextNumber).padStart(3, "0")}`;
}

async function findVendorByBusinessName(
  businessName: string
): Promise<VendorRecord | null> {
  const businessNameLower = businessName.trim().toLowerCase();

  const snapshot = await getDb()
    .collection(VENDORS_COLLECTION)
    .where("businessNameLower", "==", businessNameLower)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  return snapshot.docs[0].data() as VendorRecord;
}

export async function signupVendor(params: {
  pin: string;
  businessName: string;
  ownerName?: string;
  phone?: string;
  country?: string;
  currency?: string;
}): Promise<SignupResult> {
  const {
    pin,
    businessName,
    ownerName,
    phone,
    country,
    currency,
  } = params;

  if (!isValidPinFormat(pin)) {
    throw new Error("PIN must be exactly 4 digits");
  }

  if (!businessName?.trim()) {
    throw new Error("Business name is required");
  }

  const existing =
    await findVendorByBusinessName(businessName);

  if (existing) {
    throw new Error(
      "A vendor account with this business name already exists. Please log in instead, or choose a different business name."
    );
  }

  // Hash before taking a vendor ID so a config error doesn't burn an ID.
  const hashedPin = hashPin(pin);
  const vendorId = await getNextVendorId();
  const now = new Date().toISOString();

  const record: VendorRecord = {
    vendorId,
    hashedPin,
    businessName: businessName.trim(),
    businessNameLower: businessName
      .trim()
      .toLowerCase(),
    ownerName: ownerName?.trim() || "",
    phone: phone?.trim() || "",
    country: country?.trim() || "",
    // Always store a currency so messages never fall back to UGX.
    currency: resolveCurrency(currency, country),
    failedAttempts: 0,
    lockedUntil: null,
    createdAt: now,
    updatedAt: now,
  };

  // create() fails instead of overwriting if the ID somehow already exists.
  await getDb()
    .collection(VENDORS_COLLECTION)
    .doc(vendorId)
    .create(record);

  return {
    success: true,
    vendorId,
  };
}

export async function vendorExistsByBusinessName(
  businessName: string
): Promise<boolean> {
  const record =
    await findVendorByBusinessName(businessName);

  return record !== null;
}

export async function loginVendor(
  businessName: string,
  pin: string
): Promise<LoginResult> {
  const record =
    await findVendorByBusinessName(businessName);

  if (!record) {
    return {
      success: false,
      error:
        "No vendor account found with that business name. Please sign up first.",
    };
  }

  const vendorRef = getDb()
    .collection(VENDORS_COLLECTION)
    .doc(record.vendorId);

  // Check whether the account is currently locked.
  if (record.lockedUntil) {
    const lockedUntilDate =
      new Date(record.lockedUntil);

    const now = new Date();

    if (now < lockedUntilDate) {
      return {
        success: false,
        error:
          "Too many incorrect attempts. Please try again later.",
        lockedUntil: record.lockedUntil,
      };
    }

    // Lockout has expired, so reset the failed attempts.
    await vendorRef.update({
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: now.toISOString(),
    });

    record.failedAttempts = 0;
    record.lockedUntil = null;
  }

  // Validate PIN.
  if (
    !isValidPinFormat(pin) ||
    hashPin(pin) !== record.hashedPin
  ) {
    const newFailedAttempts =
      record.failedAttempts + 1;

    const now = new Date();

    // Lock account after too many failed attempts.
    if (
      newFailedAttempts >= MAX_PIN_ATTEMPTS
    ) {
      const lockedUntil = new Date(
        now.getTime() + LOCKOUT_DURATION_MS
      ).toISOString();

      await vendorRef.update({
        failedAttempts: newFailedAttempts,
        lockedUntil,
        updatedAt: now.toISOString(),
      });

      return {
        success: false,
        error:
          "Too many incorrect attempts. Please try again in 1 hour.",
        lockedUntil,
      };
    }

    await vendorRef.update({
      failedAttempts: newFailedAttempts,
      updatedAt: now.toISOString(),
    });

    return {
      success: false,
      error: "Incorrect PIN.",
      attemptsRemaining:
        MAX_PIN_ATTEMPTS - newFailedAttempts,
    };
  }

  // Successful login.
  await vendorRef.update({
    failedAttempts: 0,
    lockedUntil: null,
    updatedAt: new Date().toISOString(),
  });

  return {
    success: true,

    // Return only safe vendor information.
    // Never return hashedPin to the frontend.
    vendorId: record.vendorId,
    businessName: record.businessName,
    ownerName: record.ownerName,
    phone: record.phone,
    country: record.country,
    currency: resolveCurrency(record.currency, record.country),
  };
}

export async function updateVendorProfile(
  vendorId: string,
  params: { pin?: string; phone?: string }
): Promise<{ phone: string }> {
  if (
    params.pin !== undefined &&
    !isValidPinFormat(params.pin)
  ) {
    throw new Error("PIN must be exactly 4 digits");
  }

  const updates: Record<string, string> = {
    updatedAt: new Date().toISOString(),
  };

  if (params.pin !== undefined) {
    updates.hashedPin = hashPin(params.pin);
  }

  if (params.phone !== undefined) {
    updates.phone = params.phone.trim();
  }

  await getDb()
    .collection(VENDORS_COLLECTION)
    .doc(vendorId)
    .update(updates);

  return {
    phone: params.phone?.trim() || "",
  };
}
/** The currency the vendor chose at signup (falls back to UGX). */
export async function getVendorCurrency(
  vendorId: string | undefined | null
): Promise<string> {
  if (!vendorId) return DEFAULT_CURRENCY;

  try {
    const snap = await getDb()
      .collection(VENDORS_COLLECTION)
      .doc(vendorId)
      .get();
    const data = snap.exists ? snap.data() : undefined;
    return resolveCurrency(data?.currency, data?.country);
  } catch (error) {
    console.error("Failed to look up vendor currency:", error);
    return DEFAULT_CURRENCY;
  }
}
