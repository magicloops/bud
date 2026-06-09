export type IosOAuthProvisionEnvironment = "local" | "staging" | "production";

export const IOS_OAUTH_CLIENT_IDS: Record<IosOAuthProvisionEnvironment, string> = {
  local: "bud-ios-dev-local",
  staging: "bud-ios-staging",
  production: "bud-ios",
};

export const IOS_OAUTH_CLIENT_ROW_IDS: Record<IosOAuthProvisionEnvironment, string> = {
  local: "oauth_client_bud_ios_dev_local",
  staging: "oauth_client_bud_ios_staging",
  production: "oauth_client_bud_ios",
};

export const IOS_OAUTH_REDIRECT_URIS: Record<IosOAuthProvisionEnvironment, string> = {
  local: "chat.bud.app.local://oauth/callback",
  staging: "chat.bud.app.staging://oauth/callback",
  production: "chat.bud.app://oauth/callback",
};

export function getIosOAuthRedirectUri(environment: IosOAuthProvisionEnvironment): string {
  return IOS_OAUTH_REDIRECT_URIS[environment];
}
