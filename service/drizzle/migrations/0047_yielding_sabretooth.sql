ALTER TABLE "browser_resource" DROP CONSTRAINT "browser_resource_operation_check";--> statement-breakpoint
-- Historical receipts cannot be replayed by the new end-only coordinator.
UPDATE browser_resource SET control_operation=null WHERE control_operation IN ('prepare_return','finish_return');
--> statement-breakpoint
ALTER TABLE "browser_resource" ADD CONSTRAINT "browser_resource_operation_check" CHECK ("browser_resource"."control_operation" is null or "browser_resource"."control_operation" in ('pause','acquire','end'));