import { GoogleGenerativeAI } from "@google/generative-ai";
import { getSessionVendorId } from "@/lib/session";
import { NextRequest } from "next/server";

import { QUERY_CLASSIFICATION_PROMPT } from "@/lib/prompts";
import { buildDailySummary } from "@/lib/firestore-transaction";

const genAI = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY!
);


export async function POST(req: NextRequest) {
  try {
    // 1. Get the logged-in vendor ID from the authentication cookie.
    const vendorId =
      getSessionVendorId(req);

    if (!vendorId) {
      return Response.json(
        {
          error: "Not authenticated",
        },
        { status: 401 }
      );
    }

    // 2. Get audio
    const formData = await req.formData();
    const audioEntry = formData.get("audio");

    if (!(audioEntry instanceof File)) {
      return Response.json(
        { error: "Audio file is required" },
        { status: 400 }
      );
    }

    if (audioEntry.size === 0) {
      return Response.json(
        { error: "Audio file is empty" },
        { status: 400 }
      );
    }

    // 3. Normalize the browser's WebM MIME type
    //
    // Browsers may send:
    // audio/webm;codecs=opus
    //
    // Sunbird accepts .webm, but rejects the codecs parameter
    // in the MIME type. Create a clean WebM File instead.
    const audioBuffer =
      await audioEntry.arrayBuffer();

    const normalizedAudioFile =
      new File(
        [audioBuffer],
        "recording.webm",
        {
          type: "audio/webm",
        }
      );

    // 4. Speech-to-text
    //
    // Use the same Sunbird STT endpoint and upload format
    // that is already working in ai-provider.ts.
    const sunbirdForm =
      new FormData();

    sunbirdForm.append(
      "audio",
      normalizedAudioFile,
      "recording.webm"
    );

    sunbirdForm.append(
      "language",
      process.env.SUNBIRD_LANGUAGE?.trim() ||
        "eng"
    );

    const sttRes = await fetch(
      "https://api.sunbird.ai/tasks/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${process.env.SUNBIRD_API_KEY}`,
          Accept: "application/json",
        },
        body: sunbirdForm,
      }
    );

    if (!sttRes.ok) {
      const errText =
        await sttRes.text();

      console.error(
        "Sunbird STT error:",
        sttRes.status,
        errText
      );

      return Response.json(
        {
          error:
            "Sunbird STT request failed",
          detail: errText,
        },
        { status: 502 }
      );
    }

    const {
      audio_transcription: question,
    } = await sttRes.json();

    if (
      !question ||
      typeof question !== "string" ||
      !question.trim()
    ) {
      return Response.json(
        {
          error:
            "No transcript returned from Sunbird",
        },
        { status: 502 }
      );
    }

    // 5. Classify intent
    const model =
      genAI.getGenerativeModel({
        model: "gemini-3.6-flash",
        generationConfig: {
          responseMimeType:
            "application/json",
        },
      });

    const intentResult =
      await model.generateContent([
        QUERY_CLASSIFICATION_PROMPT,
        question,
      ]);

    let intent;

    try {
      intent = JSON.parse(
        intentResult.response.text()
      );
    } catch {
      return Response.json(
        {
          error:
            "Gemini returned invalid intent JSON",
          question,
        },
        { status: 502 }
      );
    }

    // 6. Build answer
    let answerText =
      "Sorry, I didn't understand that question.";

    if (
      intent.query_type ===
        "customer_balance" &&
      intent.customer_name
    ) {
      answerText =
        "Customer balance queries are coming soon.";
    } else if (
      intent.query_type ===
      "daily_summary"
    ) {
      // Use the logged-in vendor ID.
      //
      // This is important because buildDailySummary()
      // filters Firestore transactions by vendor_id.
      answerText =
        await buildDailySummary(
          vendorId
        );
    } else if (
      intent.query_type ===
      "stock_level"
    ) {
      answerText =
        "Stock queries are coming soon.";
    }

    // 7. Text-to-speech
    //
    // Use Sunbird's current audio speech endpoint.
    const ttsRes = await fetch(
      "https://api.sunbird.ai/tasks/audio/speech",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${process.env.SUNBIRD_API_KEY}`,
          Accept: "application/json",
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          text: answerText,
          voice: "salt_lug_0001",
          language: "lug",
          response_mode: "url",
        }),
      }
    );

    if (!ttsRes.ok) {
      const errText =
        await ttsRes.text();

      console.error(
        "Sunbird TTS error:",
        ttsRes.status,
        errText
      );

      return Response.json(
        {
          error:
            "Sunbird TTS request failed",
          detail: errText,
        },
        { status: 502 }
      );
    }

    const ttsData =
      await ttsRes.json();

    console.log(
      "Sunbird TTS response:",
      ttsData
    );

    if (!ttsData?.audio_url) {
      return Response.json(
        {
          error:
            "Sunbird TTS did not return an audio URL",
        },
        { status: 502 }
      );
    }

    // 8. Return everything to frontend
    return Response.json({
      question,
      answer_text: answerText,
      audio_url: ttsData.audio_url,
    });
  } catch (error) {
    console.error(
      "Voice assistant error:",
      error
    );

    return Response.json(
      {
        error:
          "Voice assistant request failed",
      },
      { status: 500 }
    );
  }
}
