import { cert, getApp, getApps, initializeApp } from "firebase-admin/app";
import { Firestore, getFirestore } from "firebase-admin/firestore";

/*
 * Server-side Firestore via the Firebase Admin SDK.
 *
 * The Admin SDK ignores Firestore security rules, so the rules can deny all
 * direct client access while our API routes keep working. Credentials come
 * from a service account key stored in environment variables (never commit
 * the key itself).
 */

let cachedDb: Firestore | null = null;

function readServiceAccount() {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  // Vercel and .env files store the key with literal "\n" sequences.
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firebase Admin is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY."
    );
  }

  return { projectId, clientEmail, privateKey };
}

/** Lazily initialised so builds succeed without credentials present. */
export function getDb(): Firestore {
  if (cachedDb) return cachedDb;

  const app = getApps().length
    ? getApp()
    : initializeApp({ credential: cert(readServiceAccount()) });

  cachedDb = getFirestore(app);
  return cachedDb;
}
