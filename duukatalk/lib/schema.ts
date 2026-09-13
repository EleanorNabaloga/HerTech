export interface Transaction {
  item: string;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  customerName: string | null;
  paymentType: "cash" | "credit";
  dueDate: string | null;
  timestamp: string;
  totalAmount: number;
}

/**
 * What we ask the model for. Unlike Transaction, every field here is
 * nullable — this gives Sunflower a legal JSON shape to return even
 * when the transcript is ambiguous, incomplete, or not a transaction
 * at all, instead of forcing it to fall back to a prose explanation.
 */
export interface ExtractedFields {
  item: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  customerName: string | null;
  paymentType: "cash" | "credit" | null;
  dueDate: string | null;
}

export interface VoiceToJsonSuccess {
  success: true;
  transcript: string;
  transaction: Transaction;
  transactionId: string;
}

/**
 * Returned when the model responded with valid JSON but couldn't
 * determine one or more required fields from the transcript. This is
 * a legitimate outcome, not an error — the caller should treat it as
 * "ask the vendor to clarify," not as a failure.
 */
export interface VoiceToJsonNeedsClarification {
  success: true;
  needsClarification: true;
  transcript: string;
  extracted: ExtractedFields;
  missingFields: string[];
}

export interface VoiceToJsonError {
  success: false;
  error: string;
}

export type VoiceToJsonResponse =
  | VoiceToJsonSuccess
  | VoiceToJsonNeedsClarification
  | VoiceToJsonError;

/**
 * Fields that must be non-null for a Transaction to be considered complete.
 * "unit", "customerName", and "dueDate" are allowed to be null in a final
 * Transaction too, so they're excluded here.
 */
const REQUIRED_FIELDS = [
  "item",
  "quantity",
  "unitPrice",
  "paymentType",
] as const satisfies readonly (keyof ExtractedFields)[];

/**
 * Loosely validates the shape/types of the model's raw JSON response.
 * This only throws for structurally malformed output (wrong types,
 * invalid enum values) — never for legitimately null fields. Use
 * getMissingRequiredFields() afterwards to decide if the extraction
 * is complete enough to become a Transaction.
 */
export function validateExtractedFields(value: unknown): ExtractedFields {
  if (typeof value !== "object" || value === null) {
    throw new Error("Model response is not an object");
  }

  const obj = value as Record<string, unknown>;

  if (
    obj.item !== null &&
    obj.item !== undefined &&
    typeof obj.item !== "string"
  ) {
    throw new Error("Invalid 'item'");
  }

  if (
    obj.quantity !== null &&
    obj.quantity !== undefined &&
    (typeof obj.quantity !== "number" || Number.isNaN(obj.quantity))
  ) {
    throw new Error("Invalid 'quantity'");
  }

  if (
    obj.unit !== null &&
    obj.unit !== undefined &&
    typeof obj.unit !== "string"
  ) {
    throw new Error("Invalid 'unit'");
  }

  if (
    obj.unitPrice !== null &&
    obj.unitPrice !== undefined &&
    (typeof obj.unitPrice !== "number" || Number.isNaN(obj.unitPrice))
  ) {
    throw new Error("Invalid 'unitPrice'");
  }

  if (
    obj.customerName !== null &&
    obj.customerName !== undefined &&
    typeof obj.customerName !== "string"
  ) {
    throw new Error("Invalid 'customerName'");
  }

  if (
    obj.paymentType !== null &&
    obj.paymentType !== undefined &&
    obj.paymentType !== "cash" &&
    obj.paymentType !== "credit"
  ) {
    throw new Error(
      "Invalid 'paymentType', must be 'cash', 'credit', or null"
    );
  }

  if (
    obj.dueDate !== null &&
    obj.dueDate !== undefined &&
    typeof obj.dueDate !== "string"
  ) {
    throw new Error("Invalid 'dueDate'");
  }

  return {
    item: (obj.item as string | null | undefined) ?? null,
    quantity: (obj.quantity as number | null | undefined) ?? null,
    unit: (obj.unit as string | null | undefined) ?? null,
    unitPrice: (obj.unitPrice as number | null | undefined) ?? null,
    customerName:
      (obj.customerName as string | null | undefined) ?? null,
    paymentType:
      (obj.paymentType as "cash" | "credit" | null | undefined) ?? null,
    dueDate: (obj.dueDate as string | null | undefined) ?? null,
  };
}

/**
 * Returns the list of required field names that are still null.
 * Empty array means the extraction is complete enough to build a Transaction.
 */
export function getMissingRequiredFields(
  fields: ExtractedFields
): string[] {
  return REQUIRED_FIELDS.filter((key) => fields[key] === null);
}

/**
 * Promotes a complete ExtractedFields into a full Transaction, attaching
 * a server-generated timestamp. Call getMissingRequiredFields() first and
 * only call this when it returns an empty array.
 */
export function toTransaction(
  fields: ExtractedFields,
  timestamp: string
): Transaction {
  if (
    fields.item === null ||
    fields.quantity === null ||
    fields.unitPrice === null ||
    fields.paymentType === null
  ) {
    throw new Error(
      "Cannot build Transaction from incomplete fields: " +
        getMissingRequiredFields(fields).join(", ")
    );
  }

  return {
    item: fields.item,
    quantity: fields.quantity,
    unit: fields.unit,
    unitPrice: fields.unitPrice,
    customerName: fields.customerName,
    paymentType: fields.paymentType,
    dueDate: fields.dueDate,
    timestamp,
    totalAmount: fields.quantity * fields.unitPrice,
  };
}