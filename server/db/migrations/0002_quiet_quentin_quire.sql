CREATE INDEX "idx_agent_tokens_revoked" ON "agent_tokens" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "idx_device_auth_status" ON "device_auth_requests" USING btree ("status");