import { NextRequest, NextResponse } from "next/server";
import { getVendorCurrency } from "@/lib/auth";
import { getSessionVendorId } from "@/lib/session";
import { getAiProvider } from "@/lib/ai-provider";
import {
  VoiceToJsonResponse,
  getMissingRequiredFields,
  toTransaction,
} from "@/lib/schema";
import { getDb } from "@/lib/firebase";
import {
  findByClientId,
  fromFirestoreTransaction,
  parseClientId,
  toFirestoreTransaction,
} from "@/lib/firestore-transaction";
import { updateCustomerCredit } from "@/lib/updateCustomerCredit";
import { notifyAfterTransaction } from "@/lib/notify-transaction";
import { getNextTransactionId } from "@/lib/transaction-id";
import { CREDIT_LIMIT, normalizeCustomerName } from "@/lib/credit";
import { creditLimitWarning, parseLanguage } from "@/lib/risk-flags";

export const runtime = "nodejs";

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const TRANSACTIONS_COLLECTION = "transactions";

export async function POST(
  request: NextRequest
): Promise<NextResponse<VoiceToJsonResponse>> {
  // --------------------------------------------------
  // 1. Get the authenticated vendor ID
  // --------------------------------------------------

  const vendorId = getSessionVendorId(request);

  if (!vendorId) {
    return NextResponse.json(
      {
        success: false,
        error: "Not authenticated",
      },
      { status: 401 }
    );
  }

  // --------------------------------------------------
  // 2. Read form data
  // --------------------------------------------------

  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "Request must be multipart/form-data",
      },
      { status: 400 }
    );
  }

  const audioEntry = formData.get("audio");

  if (!audioEntry || !(audioEntry instanceof File)) {
    return NextResponse.json(
      {
        success: false,
        error: "Missing 'audio' file in form data",
      },
      { status: 400 }
    );
  }

  // --------------------------------------------------
  // 3. Validate audio file
  // --------------------------------------------------

  if (audioEntry.size === 0) {
    return NextResponse.json(
      {
        success: false,
        error: "Audio file is empty",
      },
      { status: 400 }
    );
  }

  if (audioEntry.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      {
        success: false,
        error: "Audio file exceeds maximum allowed size (50MB)",
      },
      { status: 400 }
    );
  }

  const mimeType = audioEntry.type || "audio/webm";
  const requestedLanguage = parseLanguage(formData.get("language")?.toString() ?? "EN");
  const acknowledgedWarning = formData.get("acknowledgedWarning") === "true";

  // A queued recording that was already saved (a retry after a dropped
  // connection) is answered from the database without processing it again.
  const clientId = parseClientId(formData.get("clientId"));
  if (clientId) {
    try {
      const existing = await findByClientId(vendorId, clientId);
      if (existing) {
        return NextResponse.json(
          {
            success: true,
            transcript: existing.raw_transcript,
            transaction: fromFirestoreTransaction(existing),
            transactionId: existing.id,
          },
          { status: 200 }
        );
      }
    } catch (error) {
      console.error("Duplicate check failed:", error);
      return NextResponse.json(
        { success: false, error: "Could not check for an earlier upload" },
        { status: 503 }
      );
    }
  }

  // --------------------------------------------------
  // 4. Convert audio to a Buffer
  // --------------------------------------------------

  let audioBuffer: Buffer;

  try {
    const arrayBuffer = await audioEntry.arrayBuffer();
    audioBuffer = Buffer.from(arrayBuffer);
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "Failed to read audio file",
      },
      { status: 400 }
    );
  }

  // --------------------------------------------------
  // 5. Process the audio with the AI provider
  // --------------------------------------------------

  try {
    console.info("Processing transaction for vendor:", vendorId);

    const provider = getAiProvider();

    const result = await provider.processAudio(
      audioBuffer,
      mimeType
    );

    // --------------------------------------------------
    // 6. Check for missing transaction fields
    // --------------------------------------------------

    const missingFields = getMissingRequiredFields(
      result.extracted
    );

    if (missingFields.length > 0) {
      return NextResponse.json(
        {
          success: true,
          needsClarification: true,
          transcript: result.transcript,
          extracted: result.extracted,
          missingFields,
        },
        { status: 200 }
      );
    }

    // --------------------------------------------------
    // 7. Create server-side timestamp
    // --------------------------------------------------

    const timestamp = new Date().toISOString();

    // Convert the AI-extracted data into the application's
    // standard transaction format.
    const transaction = toTransaction(
      result.extracted,
      timestamp
    );

    if (transaction.paymentType === "credit" && transaction.customerName) {
      const customerKey = `${vendorId}_${normalizeCustomerName(transaction.customerName)}`;
      const customerSnap = await getDb().collection("customers").doc(customerKey).get();
      const outstandingCredit = customerSnap.exists
        ? Number(customerSnap.data()?.outstanding_credit || 0)
        : 0;

      if (outstandingCredit >= CREDIT_LIMIT && acknowledgedWarning !== true) {
        return NextResponse.json(
          {
            success: false,
            error: creditLimitWarning(
              requestedLanguage,
              transaction.customerName,
              outstandingCredit,
              await getVendorCurrency(vendorId),
            ),
          },
          { status: 409 }
        );
      }
    }

    // --------------------------------------------------
    // 8. Generate transaction ID and Firestore reference
    // --------------------------------------------------

    const transactionId = await getNextTransactionId();

    const docRef = getDb()
      .collection(TRANSACTIONS_COLLECTION)
      .doc(transactionId);

    // --------------------------------------------------
    // 9. Convert to Firestore format
    //    and attach the authenticated vendor ID
    // --------------------------------------------------

    const firestoreTransaction = toFirestoreTransaction(
      transaction,
      result.transcript,
      transactionId,
      vendorId
    );

    // --------------------------------------------------
    // 10. Save transaction to Firestore
    // --------------------------------------------------

    await docRef.set({ ...firestoreTransaction, client_id: clientId });

    console.info("Transaction saved successfully:", {
      transactionId: docRef.id,
      vendorId,
    });

    // --------------------------------------------------
    // 11. Update customer credit when necessary
    // --------------------------------------------------

    let outstandingCredit: number | undefined;

    if (
      transaction.paymentType === "credit" &&
      transaction.customerName
    ) {
      outstandingCredit =
        (await updateCustomerCredit(vendorId, transaction.customerName, transaction.totalAmount)) ?? undefined;
    }

    // --------------------------------------------------
    // 12. Send transaction notification asynchronously
    // --------------------------------------------------

    void notifyAfterTransaction({
      customerName: transaction.customerName,
      paymentType: transaction.paymentType,
      item: transaction.item,
      amount: firestoreTransaction.total_amount,
      quantity: transaction.quantity,
      dueDate: transaction.dueDate,
      outstandingCredit,
      language: requestedLanguage,
      vendorId,
    }).catch((error) => {
      console.error("Background notification fan-out failed:", error);
    });

    // --------------------------------------------------
    // 13. Return successful response
    // --------------------------------------------------

    return NextResponse.json(
      {
        success: true,
        transcript: result.transcript,
        transaction,
        transactionId: docRef.id,
      },
      { status: 200 }
    );
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Unknown error during processing";

    console.error("voice-to-json error:", message);

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      { status: 502 }
    );
  }
}