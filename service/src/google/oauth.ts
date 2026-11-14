import { OAuth2Client, CodeChallengeMethod, type Credentials } from "google-auth-library";
import { serviceScopes, GoogleError, type GoogleConfig, type GoogleSelection } from "./config.js";
import { googleFetch, googleJson } from "./http.js";

export class GoogleOAuth {
  constructor(readonly config: GoogleConfig, private readonly baseFetch: typeof fetch = fetch) {}

  private client(signal?: AbortSignal) {
    const client = new OAuth2Client({ clientId: this.config.clientId, clientSecret: this.config.clientSecret,
      redirectUri: this.config.redirectUri, transporterOptions: {
        fetchImplementation: googleFetch(this.baseFetch, signal), timeout: 20_000, maxRedirects: 0,
      } });
    client.transporter.interceptors.request.add({ resolved: async options => {
      // The SDK supplies retryConfig, which gaxios honors even when retry is false.
      options.retry = false; options.retryConfig = { retry: 0, noResponseRetries: 0 }; options.redirect = "error";
      return options;
    } });
    return client;
  }

  async authorize(state: string, selections: GoogleSelection[] = [{ service: "calendar", access: "read_write" }], loginHint?: string) {
    const client = this.client(), pkce = await client.generateCodeVerifierAsync();
    return { verifier: pkce.codeVerifier, url: client.generateAuthUrl({
      scope: [...new Set(selections.flatMap(selection => serviceScopes(selection.service, selection.access)))],
      state, access_type: "offline", prompt: "consent", include_granted_scopes: true, login_hint: loginHint,
      code_challenge: pkce.codeChallenge, code_challenge_method: CodeChallengeMethod.S256,
    }) };
  }

  async exchange(code: string, verifier: string, signal: AbortSignal) {
    try {
      const { tokens } = await this.client(signal).getToken({ code, codeVerifier: verifier });
      if (!tokens.access_token || !tokens.scope) throw new GoogleError("google_offline_access_required");
      const identity = await googleJson(googleFetch(this.baseFetch, signal),
        "https://openidconnect.googleapis.com/v1/userinfo", tokens.access_token);
      if (typeof identity.sub !== "string" || typeof identity.email !== "string" || identity.email_verified !== true) {
        throw new GoogleError("google_identity_unavailable");
      }
      // ID tokens are not needed after the authenticated Google userinfo lookup.
      delete tokens.id_token;
      return { tokens, subject: identity.sub, email: identity.email, scopes: tokens.scope.split(/\s+/).filter(Boolean) };
    } catch (error) {
      if (error instanceof GoogleError) throw error;
      throw new GoogleError("google_authorization_failed");
    }
  }

  async refresh(tokens: Credentials, signal: AbortSignal): Promise<Credentials> {
    if (!tokens.refresh_token) throw new GoogleError("google_reconnect_required");
    try {
      const client = this.client(signal); client.setCredentials(tokens);
      // The SDK emits the provider's token set, then puts the old refresh token
      // back into its returned credentials. Keep a replacement if Google issued one.
      let refreshToken = tokens.refresh_token;
      client.once("tokens", issued => { refreshToken = issued.refresh_token ?? refreshToken; });
      const { credentials } = await client.refreshAccessToken();
      if (!credentials.access_token) throw new GoogleError("google_refresh_unavailable", true);
      return { access_token: credentials.access_token, refresh_token: refreshToken,
        expiry_date: credentials.expiry_date, scope: credentials.scope ?? tokens.scope, token_type: credentials.token_type };
    } catch (error) {
      const response = error && typeof error === "object" && "response" in error ? error.response : undefined;
      const data = response && typeof response === "object" && "data" in response ? response.data : undefined;
      const status = response && typeof response === "object" && "status" in response ? response.status : undefined;
      if (typeof status === "number" && status >= 400 && status < 500 &&
        data && typeof data === "object" && "error" in data && data.error === "invalid_grant") {
        throw new GoogleError("google_reconnect_required");
      }
      throw new GoogleError("google_refresh_unavailable", true);
    }
  }
}
