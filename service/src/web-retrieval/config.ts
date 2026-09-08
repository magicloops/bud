import "dotenv/config";

export function retrievalConfig(): { enabled: boolean; apiKey: string } {
  return { enabled: ["1", "true"].includes(process.env.WEB_RETRIEVAL_ENABLED ?? "1"),
    apiKey: process.env.FIRECRAWL_API_KEY?.trim() ?? "" };
}
export function retrievalAvailable(): boolean {
  const value = retrievalConfig();
  return value.enabled && Boolean(value.apiKey);
}
