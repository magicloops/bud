export type IosOAuthProvisionEnvironment = "local" | "staging";
export type IosOAuthRuntimeEnvironment = IosOAuthProvisionEnvironment | "production";

export const IOS_OAUTH_REDIRECT_URIS: Record<IosOAuthRuntimeEnvironment, string> = {
  local: "chat.bud.app.staging://oauth/callback",
  staging: "chat.bud.app.staging://oauth/callback",
  production: "chat.bud.app://oauth/callback",
};

export function getIosOAuthRedirectUri(environment: IosOAuthRuntimeEnvironment): string {
  return IOS_OAUTH_REDIRECT_URIS[environment];
}
