import { createPrivateKey, createSign } from "node:crypto";
import { connect } from "node:http2";
import { config } from "../config.js";

export type ApnsEnvironment = "sandbox" | "production" | "development";

export type PushProviderSendResult =
  | { status: "sent" }
  | { status: "retryable"; code: string; message: string }
  | { status: "invalid_endpoint"; code: string; message: string }
  | { status: "failed"; code: string; message: string };

export type ApnsPushEndpoint = {
  token: string;
  appId: string;
  providerEnvironment: string | null;
  includeMessagePreview: boolean;
};

export type ApnsNotification = {
  title: string;
  body: string;
  genericBody: string;
  collapseKey: string;
  payload: Record<string, unknown>;
};

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

export function classifyApnsFailure(status: number, reason: string | null): PushProviderSendResult {
  if (status >= 200 && status < 300) {
    return { status: "sent" };
  }

  if (
    reason &&
    ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(reason)
  ) {
    return { status: "invalid_endpoint", code: reason, message: reason };
  }

  if (status === 429 || status >= 500) {
    return { status: "retryable", code: reason ?? String(status), message: reason ?? "apns_retryable" };
  }

  return { status: "failed", code: reason ?? String(status), message: reason ?? "apns_failed" };
}

export class ApnsPushProvider {
  private readonly keyId: string;
  private readonly teamId: string;
  private readonly privateKey: string;
  private readonly defaultTopic: string | null;

  constructor() {
    if (!config.apnsKeyId || !config.apnsTeamId || !config.apnsPrivateKey) {
      throw new Error("apns_not_configured");
    }
    this.keyId = config.apnsKeyId;
    this.teamId = config.apnsTeamId;
    this.privateKey = config.apnsPrivateKey;
    this.defaultTopic = config.apnsDefaultTopic;
  }

  static isConfigured(): boolean {
    return Boolean(config.apnsKeyId && config.apnsTeamId && config.apnsPrivateKey);
  }

  async send(
    notification: ApnsNotification,
    endpoint: ApnsPushEndpoint,
  ): Promise<PushProviderSendResult> {
    const jwt = this.buildJwt();
    const authority = this.resolveAuthority(endpoint.providerEnvironment);
    const topic = endpoint.appId || this.defaultTopic;
    if (!topic) {
      return { status: "failed", code: "MissingTopic", message: "apns_topic_missing" };
    }

    return new Promise((resolve) => {
      const client = connect(authority);
      const body = JSON.stringify({
        aps: {
          alert: {
            title: notification.title,
            body: endpoint.includeMessagePreview ? notification.body : notification.genericBody,
          },
          sound: "default",
          badge: 1,
        },
        ...notification.payload,
      });

      const request = client.request({
        ":method": "POST",
        ":path": `/3/device/${endpoint.token}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-collapse-id": notification.collapseKey,
      });

      let responseBody = "";
      let responseStatus = 500;

      request.setEncoding("utf8");
      request.on("response", (headers) => {
        const status = headers[":status"];
        responseStatus = typeof status === "number" ? status : Number(status ?? 500);
      });
      request.on("data", (chunk) => {
        responseBody += chunk;
      });
      request.on("error", (err) => {
        client.close();
        resolve({ status: "retryable", code: "transport_error", message: err.message });
      });
      request.on("end", () => {
        client.close();
        let reason: string | null = null;
        if (responseBody) {
          try {
            const parsed = JSON.parse(responseBody) as { reason?: string };
            reason = parsed.reason ?? null;
          } catch {
            reason = null;
          }
        }
        resolve(classifyApnsFailure(responseStatus, reason));
      });

      request.end(body);
    });
  }

  private buildJwt(): string {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = {
      alg: "ES256",
      kid: this.keyId,
    };
    const payload = {
      iss: this.teamId,
      iat: issuedAt,
    };
    const unsignedToken = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
    const key = createPrivateKey(this.privateKey);
    const signer = createSign("sha256");
    signer.update(unsignedToken);
    signer.end();
    const signature = signer.sign(key).toString("base64url");
    return `${unsignedToken}.${signature}`;
  }

  private resolveAuthority(environment: string | null): string {
    return environment === "sandbox" || environment === "development"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
  }
}
