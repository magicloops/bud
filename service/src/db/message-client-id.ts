import { v7 as uuidv7 } from "uuid";

export function generateMessageClientId(): string {
  return uuidv7();
}
