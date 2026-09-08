import type { Server } from 'node:http';
export function createContactApp(options: {
  appData: { query(keyId: string, resource: string, parameters?: Record<string, string | number>): Promise<unknown> };
  keyId: string;
}): Server;
