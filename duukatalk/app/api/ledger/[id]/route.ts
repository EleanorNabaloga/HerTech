import { NextRequest, NextResponse } from "next/server";
import { getSessionVendorId } from "@/lib/session";
import { getDb } from "@/lib/firebase";
import { updateCustomerCredit } from "@/lib/updateCustomerCredit";

/** Recalculate saved balances for the customers an edit/delete touched. */
async function refreshBalances(vendorId: string, names: unknown[]) {
  const unique = new Set(
    names.filter((n): n is string => typeof n === "string" && n.trim() !== "")
  );
  for (const name of unique) {
    try {
      await updateCustomerCredit(vendorId, name);
    } catch (error) {
      console.error("Failed to refresh customer balance:", error);
    }
  }
}


interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PUT(
  request: NextRequest,
  { params }: RouteContext
) {
  try {
    // Get the logged-in vendor from the authentication cookie
    const vendorId = getSessionVendorId(request);

    if (!vendorId) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    // Get the transaction ID from the URL
    const { id } = await params;

    if (!id) {
      return NextResponse.json(
        { error: "Transaction ID is required" },
        { status: 400 }
      );
    }

    // Get the transaction from Firestore
    const transactionRef = getDb().collection("transactions").doc(id);
    const transactionSnapshot = await transactionRef.get();

    if (!transactionSnapshot.exists) {
      return NextResponse.json(
        { error: "Transaction not found" },
        { status: 404 }
      );
    }

    const existingTransaction = transactionSnapshot.data();

    // Make sure this transaction belongs to the logged-in vendor
    if (existingTransaction?.vendor_id !== vendorId) {
      return NextResponse.json(
        { error: "Transaction not found" },
        { status: 404 }
      );
    }

    // Read the update data sent by the frontend
    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }

    const data = body as Record<string, unknown>;

    const customerName = data.customer_name;
    const item = data.item;
    const totalAmount = data.total_amount;
    const paymentType = data.payment_type;
    const dueDate = data.due_date;

    // Validate customer name
    if (
      typeof customerName !== "string" ||
      customerName.trim() === ""
    ) {
      return NextResponse.json(
        { error: "Customer name is required" },
        { status: 400 }
      );
    }

    // Validate item
    if (typeof item !== "string" || item.trim() === "") {
      return NextResponse.json(
        { error: "Item is required" },
        { status: 400 }
      );
    }

    // Validate amount
    if (
      typeof totalAmount !== "number" ||
      !Number.isFinite(totalAmount) ||
      totalAmount <= 0
    ) {
      return NextResponse.json(
        { error: "Total amount must be a valid number greater than 0" },
        { status: 400 }
      );
    }

    // Validate payment type
    if (paymentType !== "cash" && paymentType !== "credit") {
      return NextResponse.json(
        { error: "Payment type must be cash or credit" },
        { status: 400 }
      );
    }

    // Validate due date
    if (
      dueDate !== null &&
      dueDate !== undefined &&
      typeof dueDate !== "string"
    ) {
      return NextResponse.json(
        { error: "Invalid due date" },
        { status: 400 }
      );
    }

    // Only update fields that the vendor is allowed to edit.
    // vendor_id is deliberately NOT taken from the request.
    const updates = {
      customer_name: customerName.trim(),
      item: item.trim(),
      total_amount: totalAmount,
      payment_type: paymentType,
      type: paymentType,
      due_date:
        paymentType === "credit" &&
        typeof dueDate === "string" &&
        dueDate.trim() !== ""
          ? dueDate.trim()
          : null,
      confidence_flag:
        customerName.trim() === "" || item.trim() === "",
    };

    await transactionRef.update(updates);
    await refreshBalances(vendorId, [
      existingTransaction?.customer_name,
      updates.customer_name,
    ]);

    return NextResponse.json({
      success: true,
      id,
      message: "Transaction updated successfully",
    });
  } catch (error) {
    console.error("Error updating transaction:", error);

    return NextResponse.json(
      { error: "Failed to update transaction" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: RouteContext
) {
  try {
    // Get the logged-in vendor from the authentication cookie
    const vendorId = getSessionVendorId(request);

    if (!vendorId) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    // Get the transaction ID from the URL
    const { id } = await params;

    if (!id) {
      return NextResponse.json(
        { error: "Transaction ID is required" },
        { status: 400 }
      );
    }

    // Get the transaction from Firestore first
    const transactionRef = getDb().collection("transactions").doc(id);
    const transactionSnapshot = await transactionRef.get();

    if (!transactionSnapshot.exists) {
      return NextResponse.json(
        { error: "Transaction not found" },
        { status: 404 }
      );
    }

    const existingTransaction = transactionSnapshot.data();

    // Make sure this transaction belongs to the logged-in vendor
    if (existingTransaction?.vendor_id !== vendorId) {
      return NextResponse.json(
        { error: "Transaction not found" },
        { status: 404 }
      );
    }

    // Delete the transaction
    await transactionRef.delete();
    await refreshBalances(vendorId, [existingTransaction?.customer_name]);

    return NextResponse.json({
      success: true,
      id,
      message: "Transaction deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting transaction:", error);

    return NextResponse.json(
      { error: "Failed to delete transaction" },
      { status: 500 }
    );
  }
}