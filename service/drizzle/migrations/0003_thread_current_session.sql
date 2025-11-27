ALTER TABLE "thread" ADD COLUMN "current_session_id" text;
CREATE INDEX "thread_current_session_idx" ON "thread" USING btree ("current_session_id");
