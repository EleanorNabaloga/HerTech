import { NextRequest, NextResponse } from "next/server";
import { getSessionVendorId } from "@/lib/session";
import { updateVendorProfile } from "@/lib/auth";


export async function PATCH(request: NextRequest) {
  const vendorId = getSessionVendorId(request);
  if (!vendorId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const pin = body?.pin;
    const phone = body?.phone;

    if (pin !== undefined && typeof pin !== "string") {
      return NextResponse.json({ error: "PIN must be a string" }, { status: 400 });
    }
    if (phone !== undefined && typeof phone !== "string") {
      return NextResponse.json({ error: "Phone number must be a string" }, { status: 400 });
    }

    const result = await updateVendorProfile(vendorId, { pin, phone });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update profile";
    console.error("profile update error:", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
