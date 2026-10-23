import { createHmac, timingSafeEqual } from "crypto";
import type { NextRequest, NextResponse } from "next/server";

/*
 * Signed session cookie.
 *
 * The cookie holds "<vendorId>.<expiresAtMs>.<signature>". The signature is an
 * HMAC of the first two parts using SESSION_SECRET, so a user cannot change
 * the vendor ID in their cookie to open another shop's account.
 */

export const SESSION_COOKIE_NAME = "duukatalk_session";
// Older unsigned cookie; cleared on login/logout and never trusted.
const LEGACY_COOKIE_NAME = "duukatalk_vendor_id";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error(
      "SESSION_SECRET is not configured (it must be at least 32 characters)."
    );
  }
  return secret;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionToken(vendorId: string): string {
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const payload = `${vendorId}.${expiresAt}`;
  return `${payload}.${sign(payload, getSecret())}`;
}

export function verifySessionToken(token: string | undefined): string | null {
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [vendorId, expiresAtRaw, signature] = parts;
  const expiresAt = Number(expiresAtRaw);
  if (!vendorId || !Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    return null;
  }

  let secret: string;
  try {
    secret = getSecret();
  } catch (error) {
    console.error(error);
    return null;
  }

  const expected = Buffer.from(sign(`${vendorId}.${expiresAtRaw}`, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  return vendorId;
}

/** Returns the logged-in vendor's ID, or null if there is no valid session. */
export function getSessionVendorId(request: NextRequest): string | null {
  return verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
}

export function setSessionCookie(response: NextResponse, vendorId: string): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: createSessionToken(vendorId),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  response.cookies.set({ name: LEGACY_COOKIE_NAME, value: "", expires: new Date(0), path: "/" });
}

export function clearSessionCookie(response: NextResponse): void {
  for (const name of [SESSION_COOKIE_NAME, LEGACY_COOKIE_NAME]) {
    response.cookies.set({ name, value: "", expires: new Date(0), path: "/" });
  }
}
