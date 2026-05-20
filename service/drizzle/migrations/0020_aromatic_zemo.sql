DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bud_operation'::regclass
      AND conname = 'bud_operation_terminal_session_id_terminal_session_session_id_f'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bud_operation'::regclass
      AND conname = 'bud_operation_terminal_session_fk'
  ) THEN
    ALTER TABLE "bud_operation"
      RENAME CONSTRAINT "bud_operation_terminal_session_id_terminal_session_session_id_f"
      TO "bud_operation_terminal_session_fk";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bud_operation'::regclass
      AND conname = 'bud_operation_device_session_id_device_session_device_session_i'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bud_operation'::regclass
      AND conname = 'bud_operation_device_session_fk'
  ) THEN
    ALTER TABLE "bud_operation"
      RENAME CONSTRAINT "bud_operation_device_session_id_device_session_device_session_i"
      TO "bud_operation_device_session_fk";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bud_operation'::regclass
      AND conname = 'bud_operation_transport_session_id_transport_session_transport_'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bud_operation'::regclass
      AND conname = 'bud_operation_transport_session_fk'
  ) THEN
    ALTER TABLE "bud_operation"
      RENAME CONSTRAINT "bud_operation_transport_session_id_transport_session_transport_"
      TO "bud_operation_transport_session_fk";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bud_stream'::regclass
      AND conname = 'bud_stream_device_session_id_device_session_device_session_id_f'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bud_stream'::regclass
      AND conname = 'bud_stream_device_session_fk'
  ) THEN
    ALTER TABLE "bud_stream"
      RENAME CONSTRAINT "bud_stream_device_session_id_device_session_device_session_id_f"
      TO "bud_stream_device_session_fk";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bud_stream'::regclass
      AND conname = 'bud_stream_transport_session_id_transport_session_transport_ses'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bud_stream'::regclass
      AND conname = 'bud_stream_transport_session_fk'
  ) THEN
    ALTER TABLE "bud_stream"
      RENAME CONSTRAINT "bud_stream_transport_session_id_transport_session_transport_ses"
      TO "bud_stream_transport_session_fk";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.proxied_site_viewer_grant'::regclass
      AND conname = 'proxied_site_viewer_grant_proxied_site_id_proxied_site_proxied_'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.proxied_site_viewer_grant'::regclass
      AND conname = 'proxied_site_viewer_grant_site_fk'
  ) THEN
    ALTER TABLE "proxied_site_viewer_grant"
      RENAME CONSTRAINT "proxied_site_viewer_grant_proxied_site_id_proxied_site_proxied_"
      TO "proxied_site_viewer_grant_site_fk";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.proxied_site_viewer_session'::regclass
      AND conname = 'proxied_site_viewer_session_proxied_site_id_proxied_site_proxie'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.proxied_site_viewer_session'::regclass
      AND conname = 'proxied_site_viewer_session_site_fk'
  ) THEN
    ALTER TABLE "proxied_site_viewer_session"
      RENAME CONSTRAINT "proxied_site_viewer_session_proxied_site_id_proxied_site_proxie"
      TO "proxied_site_viewer_session_site_fk";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.terminal_session_input_log'::regclass
      AND conname = 'terminal_session_input_log_session_id_terminal_session_session_'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.terminal_session_input_log'::regclass
      AND conname = 'terminal_session_input_log_session_fk'
  ) THEN
    ALTER TABLE "terminal_session_input_log"
      RENAME CONSTRAINT "terminal_session_input_log_session_id_terminal_session_session_"
      TO "terminal_session_input_log_session_fk";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.terminal_session_output'::regclass
      AND conname = 'terminal_session_output_session_id_terminal_session_session_id_'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.terminal_session_output'::regclass
      AND conname = 'terminal_session_output_session_fk'
  ) THEN
    ALTER TABLE "terminal_session_output"
      RENAME CONSTRAINT "terminal_session_output_session_id_terminal_session_session_id_"
      TO "terminal_session_output_session_fk";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.transport_session'::regclass
      AND conname = 'transport_session_device_session_id_device_session_device_sessi'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.transport_session'::regclass
      AND conname = 'transport_session_device_session_fk'
  ) THEN
    ALTER TABLE "transport_session"
      RENAME CONSTRAINT "transport_session_device_session_id_device_session_device_sessi"
      TO "transport_session_device_session_fk";
  END IF;
END $$;
