import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

// Accuracy is the top priority (per RICE: accuracy > cost > speed), so the
// actual translation + glossary extraction run on Sonnet. Cheaper/lower-stakes
// classification tasks (domain analysis, header labels) stay on Haiku.
export const TRANSLATION_MODEL = "claude-sonnet-5";
export const UTILITY_MODEL = "claude-haiku-4-5-20251001";

/** Strips optional ```json / ``` fences some models wrap JSON replies in. */
export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : trimmed;
}
