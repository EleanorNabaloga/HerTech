import { NextRequest, NextResponse } from "next/server";
import { loginVendor } from "@/lib/auth";
import { setSessionCookie } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const businessName = body?.businessName;
    const pin = body?.pin;

    // Validate business name
    if (typeof businessName !== "string" || !businessName.trim()) {
      return NextResponse.json(
        {
          success: false,
          error: "Business name is required",
        },
        { status: 400 }
      );
    }

    // Validate PIN
    if (typeof pin !== "string") {
      return NextResponse.json(
        {
          success: false,
          error: "PIN is required",
        },
        { status: 400 }
      );
    }

    // Authenticate the vendor
    const result = await loginVendor(
      businessName.trim(),
      pin
    );

    // Login failed
    if (!result.success) {
      const status = result.lockedUntil ? 429 : 401;

      return NextResponse.json(result, { status });
    }

    // A successful login must have a vendor ID.
    if (!result.vendorId) {
      console.error(
        "Login succeeded but no vendorId was returned."
      );

      return NextResponse.json(
        {
          success: false,
          error: "Login failed. Please try again.",
        },
        { status: 500 }
      );
    }

    // Create the signed authentication cookie.
    const response = NextResponse.json(
      result,
      { status: 200 }
    );

    setSessionCookie(response, result.vendorId);

    return response;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error";

    console.error("login error:", message);

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      { status: 500 }
    );
  }
}

