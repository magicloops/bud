CREATE TABLE "audit_event" (
	"audit_event_id" text PRIMARY KEY NOT NULL,
	"bud_id" text,
	"user_id" text,
	"operation_id" text,
	"stream_id" text,
	"event_type" text NOT NULL,
	"event_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bud_operation" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"bud_id" text NOT NULL,
	"thread_id" uuid,
	"terminal_session_id" text,
	"device_session_id" text,
	"transport_session_id" text,
	"idempotency_key" text,
	"operation_type" text NOT NULL,
	"traffic_class" text DEFAULT 'control' NOT NULL,
	"state" text DEFAULT 'offered' NOT NULL,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error_code" text,
	"error_message" text,
	"error_retryable" boolean,
	"error_details" jsonb,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bud_stream" (
	"stream_id" text PRIMARY KEY NOT NULL,
	"operation_id" text,
	"bud_id" text NOT NULL,
	"device_session_id" text,
	"transport_session_id" text,
	"stream_type" text NOT NULL,
	"traffic_class" text DEFAULT 'interactive' NOT NULL,
	"state" text DEFAULT 'opening' NOT NULL,
	"send_offset" bigint DEFAULT 0 NOT NULL,
	"receive_offset" bigint DEFAULT 0 NOT NULL,
	"credit_window_bytes" bigint,
	"reset_reason" text,
	"error_code" text,
	"error_message" text,
	"error_retryable" boolean,
	"error_details" jsonb,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_session" (
	"device_session_id" text PRIMARY KEY NOT NULL,
	"bud_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"gateway_instance_id" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"drain_started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transport_session" (
	"transport_session_id" text PRIMARY KEY NOT NULL,
	"device_session_id" text,
	"bud_id" text NOT NULL,
	"transport_kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"remote_addr" text,
	"user_agent" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"drain_started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_operation_id_bud_operation_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."bud_operation"("operation_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_stream_id_bud_stream_stream_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."bud_stream"("stream_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bud_operation" ADD CONSTRAINT "bud_operation_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bud_operation" ADD CONSTRAINT "bud_operation_thread_id_thread_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bud_operation" ADD CONSTRAINT "bud_operation_terminal_session_id_terminal_session_session_id_fk" FOREIGN KEY ("terminal_session_id") REFERENCES "public"."terminal_session"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bud_operation" ADD CONSTRAINT "bud_operation_device_session_id_device_session_device_session_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "public"."device_session"("device_session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bud_operation" ADD CONSTRAINT "bud_operation_transport_session_id_transport_session_transport_session_id_fk" FOREIGN KEY ("transport_session_id") REFERENCES "public"."transport_session"("transport_session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bud_stream" ADD CONSTRAINT "bud_stream_operation_id_bud_operation_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."bud_operation"("operation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bud_stream" ADD CONSTRAINT "bud_stream_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bud_stream" ADD CONSTRAINT "bud_stream_device_session_id_device_session_device_session_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "public"."device_session"("device_session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bud_stream" ADD CONSTRAINT "bud_stream_transport_session_id_transport_session_transport_session_id_fk" FOREIGN KEY ("transport_session_id") REFERENCES "public"."transport_session"("transport_session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_session" ADD CONSTRAINT "device_session_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_session" ADD CONSTRAINT "transport_session_device_session_id_device_session_device_session_id_fk" FOREIGN KEY ("device_session_id") REFERENCES "public"."device_session"("device_session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_session" ADD CONSTRAINT "transport_session_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_bud_idx" ON "audit_event" USING btree ("bud_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_event_user_idx" ON "audit_event" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_event_operation_idx" ON "audit_event" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "audit_event_stream_idx" ON "audit_event" USING btree ("stream_id");--> statement-breakpoint
CREATE INDEX "bud_operation_bud_state_idx" ON "bud_operation" USING btree ("bud_id","state");--> statement-breakpoint
CREATE INDEX "bud_operation_thread_idx" ON "bud_operation" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bud_operation_idempotency_idx" ON "bud_operation" USING btree ("bud_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bud_stream_operation_idx" ON "bud_stream" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "bud_stream_bud_state_idx" ON "bud_stream" USING btree ("bud_id","state");--> statement-breakpoint
CREATE INDEX "bud_stream_transport_idx" ON "bud_stream" USING btree ("transport_session_id","state");--> statement-breakpoint
CREATE INDEX "device_session_bud_status_idx" ON "device_session" USING btree ("bud_id","status");--> statement-breakpoint
CREATE INDEX "device_session_heartbeat_idx" ON "device_session" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "transport_session_device_idx" ON "transport_session" USING btree ("device_session_id");--> statement-breakpoint
CREATE INDEX "transport_session_bud_kind_status_idx" ON "transport_session" USING btree ("bud_id","transport_kind","status");