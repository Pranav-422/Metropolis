// Thin Gemini wrapper. Every call has a timeout so a slow model can never hang the demo;
// callers pass a fallback for when the model is unavailable.
import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 30_000);

let client;
const ai = () => (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Gemini timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
  ]);
}

export async function askText(prompt) {
  const res = await withTimeout(ai().models.generateContent({ model: MODEL, contents: prompt }));
  return res.text.trim();
}

export async function askJSON(prompt) {
  const res = await withTimeout(
    ai().models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { responseMimeType: "application/json" },
    }),
  );
  return JSON.parse(res.text);
}

/// Run an LLM call, falling back to a canned value if the model fails.
export async function tryLLM(fn, fallback, log) {
  try {
    return { value: await fn(), live: true };
  } catch (e) {
    log?.(`LLM unavailable (${String(e.message).slice(0, 80)}), using fallback`);
    return { value: fallback, live: false };
  }
}

export const MODEL_NAME = MODEL;
