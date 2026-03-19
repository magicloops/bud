CREATE SCHEMA IF NOT EXISTS "auth";

CREATE TABLE IF NOT EXISTS "auth"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "auth"."jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"publicKey" text NOT NULL,
	"privateKey" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"expiresAt" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "auth"."oauthAccessToken" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"clientId" text NOT NULL,
	"sessionId" text,
	"userId" text,
	"referenceId" text,
	"refreshId" text,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"scopes" jsonb NOT NULL,
	CONSTRAINT "oauthAccessToken_token_unique" UNIQUE("token")
);

CREATE TABLE IF NOT EXISTS "auth"."oauthClient" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"clientSecret" text,
	"disabled" boolean,
	"skipConsent" boolean,
	"enableEndSession" boolean,
	"subjectType" text,
	"scopes" jsonb,
	"userId" text,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" jsonb,
	"tos" text,
	"policy" text,
	"softwareId" text,
	"softwareVersion" text,
	"softwareStatement" text,
	"redirectUris" jsonb NOT NULL,
	"postLogoutRedirectUris" jsonb,
	"tokenEndpointAuthMethod" text,
	"grantTypes" jsonb,
	"responseTypes" jsonb,
	"public" boolean,
	"type" text,
	"requirePKCE" boolean,
	"referenceId" text,
	"metadata" jsonb,
	CONSTRAINT "oauthClient_clientId_unique" UNIQUE("clientId")
);

CREATE TABLE IF NOT EXISTS "auth"."oauthConsent" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"userId" text,
	"referenceId" text,
	"scopes" jsonb NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "auth"."oauthRefreshToken" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"clientId" text NOT NULL,
	"sessionId" text,
	"userId" text NOT NULL,
	"referenceId" text,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"revoked" timestamp with time zone,
	"authTime" timestamp with time zone,
	"scopes" jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS "auth"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "auth"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "auth"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "device_auth_flow" (
	"flow_id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"poll_secret_hash" text NOT NULL,
	"requested_name" text NOT NULL,
	"requested_os" text NOT NULL,
	"requested_arch" text NOT NULL,
	"requested_version" text,
	"requested_capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by_user_id" text,
	"bud_id" text,
	"issued_device_secret" text,
	"error_code" text,
	"last_polled_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "user_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "terminal_session" DROP CONSTRAINT IF EXISTS "terminal_session_thread_id_key";
ALTER TABLE "terminal_session" DROP CONSTRAINT IF EXISTS "terminal_session_thread_id_unique";
ALTER TABLE "terminal_session" DROP CONSTRAINT IF EXISTS "terminal_session_thread_id_fk";
ALTER TABLE "terminal_session" DROP CONSTRAINT IF EXISTS "terminal_session_thread_id_thread_thread_id_fk";
ALTER TABLE "terminal_session" DROP CONSTRAINT IF EXISTS "terminal_session_bud_id_fk";
ALTER TABLE "terminal_session" DROP CONSTRAINT IF EXISTS "terminal_session_bud_id_bud_bud_id_fk";
ALTER TABLE "terminal_session_output" DROP CONSTRAINT IF EXISTS "terminal_session_output_session_id_fk";
ALTER TABLE "terminal_session_output" DROP CONSTRAINT IF EXISTS "terminal_session_output_session_id_terminal_session_session_id_";
ALTER TABLE "terminal_session_output" DROP CONSTRAINT IF EXISTS "terminal_session_output_session_id_terminal_session_session_id_fk";
ALTER TABLE "terminal_session_input_log" DROP CONSTRAINT IF EXISTS "terminal_session_input_log_session_id_fk";
ALTER TABLE "terminal_session_input_log" DROP CONSTRAINT IF EXISTS "terminal_session_input_log_session_id_terminal_session_session_";
ALTER TABLE "terminal_session_input_log" DROP CONSTRAINT IF EXISTS "terminal_session_input_log_session_id_terminal_session_session_id_fk";

ALTER TABLE "bud" ADD COLUMN IF NOT EXISTS "installation_id" text;
ALTER TABLE "terminal_session" ADD COLUMN IF NOT EXISTS "state_snapshot" jsonb;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'account_userId_user_id_fk'
			AND conrelid = to_regclass('"auth"."account"')
	) THEN
		ALTER TABLE "auth"."account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'oauthAccessToken_clientId_oauthClient_clientId_fk'
			AND conrelid = to_regclass('"auth"."oauthAccessToken"')
	) THEN
		ALTER TABLE "auth"."oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_clientId_oauthClient_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "auth"."oauthClient"("clientId") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'oauthAccessToken_sessionId_session_id_fk'
			AND conrelid = to_regclass('"auth"."oauthAccessToken"')
	) THEN
		ALTER TABLE "auth"."oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "auth"."session"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'oauthAccessToken_userId_user_id_fk'
			AND conrelid = to_regclass('"auth"."oauthAccessToken"')
	) THEN
		ALTER TABLE "auth"."oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'oauthAccessToken_refreshId_oauthRefreshToken_id_fk'
			AND conrelid = to_regclass('"auth"."oauthAccessToken"')
	) THEN
		ALTER TABLE "auth"."oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_refreshId_oauthRefreshToken_id_fk" FOREIGN KEY ("refreshId") REFERENCES "auth"."oauthRefreshToken"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'oauthClient_userId_user_id_fk'
			AND conrelid = to_regclass('"auth"."oauthClient"')
	) THEN
		ALTER TABLE "auth"."oauthClient" ADD CONSTRAINT "oauthClient_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'oauthConsent_clientId_oauthClient_clientId_fk'
			AND conrelid = to_regclass('"auth"."oauthConsent"')
	) THEN
		ALTER TABLE "auth"."oauthConsent" ADD CONSTRAINT "oauthConsent_clientId_oauthClient_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "auth"."oauthClient"("clientId") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'oauthConsent_userId_user_id_fk'
			AND conrelid = to_regclass('"auth"."oauthConsent"')
	) THEN
		ALTER TABLE "auth"."oauthConsent" ADD CONSTRAINT "oauthConsent_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'oauthRefreshToken_clientId_oauthClient_clientId_fk'
			AND conrelid = to_regclass('"auth"."oauthRefreshToken"')
	) THEN
		ALTER TABLE "auth"."oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_clientId_oauthClient_clientId_fk" FOREIGN KEY ("clientId") REFERENCES "auth"."oauthClient"("clientId") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'oauthRefreshToken_sessionId_session_id_fk'
			AND conrelid = to_regclass('"auth"."oauthRefreshToken"')
	) THEN
		ALTER TABLE "auth"."oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_sessionId_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "auth"."session"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'oauthRefreshToken_userId_user_id_fk'
			AND conrelid = to_regclass('"auth"."oauthRefreshToken"')
	) THEN
		ALTER TABLE "auth"."oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'session_userId_user_id_fk'
			AND conrelid = to_regclass('"auth"."session"')
	) THEN
		ALTER TABLE "auth"."session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'device_auth_flow_approved_by_user_id_user_id_fk'
			AND conrelid = to_regclass('"public"."device_auth_flow"')
	) THEN
		ALTER TABLE "device_auth_flow" ADD CONSTRAINT "device_auth_flow_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'device_auth_flow_bud_id_bud_bud_id_fk'
			AND conrelid = to_regclass('"public"."device_auth_flow"')
	) THEN
		ALTER TABLE "device_auth_flow" ADD CONSTRAINT "device_auth_flow_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'user_profile_user_id_user_id_fk'
			AND conrelid = to_regclass('"public"."user_profile"')
	) THEN
		ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS "auth_account_user_idx" ON "auth"."account" USING btree ("userId");
CREATE INDEX IF NOT EXISTS "auth_account_provider_account_idx" ON "auth"."account" USING btree ("providerId","accountId");
CREATE UNIQUE INDEX IF NOT EXISTS "auth_session_token_idx" ON "auth"."session" USING btree ("token");
CREATE INDEX IF NOT EXISTS "auth_session_user_idx" ON "auth"."session" USING btree ("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "auth_user_email_idx" ON "auth"."user" USING btree ("email");
CREATE INDEX IF NOT EXISTS "auth_verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");
CREATE INDEX IF NOT EXISTS "device_auth_flow_installation_idx" ON "device_auth_flow" USING btree ("installation_id","created_at");
CREATE INDEX IF NOT EXISTS "device_auth_flow_status_idx" ON "device_auth_flow" USING btree ("status","expires_at");
CREATE INDEX IF NOT EXISTS "device_auth_flow_poll_secret_idx" ON "device_auth_flow" USING btree ("poll_secret_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "user_profile_username_idx" ON "user_profile" USING btree ("username");
CREATE UNIQUE INDEX IF NOT EXISTS "bud_installation_id_idx" ON "bud" USING btree ("installation_id");

ALTER TABLE "terminal_session" ADD CONSTRAINT "terminal_session_thread_id_thread_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "terminal_session" ADD CONSTRAINT "terminal_session_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "terminal_session_output" ADD CONSTRAINT "terminal_session_output_session_id_terminal_session_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."terminal_session"("session_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "terminal_session_input_log" ADD CONSTRAINT "terminal_session_input_log_session_id_terminal_session_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."terminal_session"("session_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "terminal_session" ADD CONSTRAINT "terminal_session_thread_id_unique" UNIQUE("thread_id");
