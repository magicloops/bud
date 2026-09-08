export type AppSetupContext = { request_id: string; key_id: string; recipient_fingerprint: string; expires_at: string };
export class BudAppData {
  constructor(options: { appId: string; apiOrigin: string; stateRoot?: string; fetch?: typeof globalThis.fetch });
  initialize(): Promise<{ app_id: string; api_origin: string; public_key: string; recipient_fingerprint: string }>;
  install(context: AppSetupContext): Promise<{ status: "installed" | "revoked" | "setup_failed"; key_id: string }>;
  query(keyId: string, resource: string, parameters?: Record<string, string | number>): Promise<unknown>;
}
