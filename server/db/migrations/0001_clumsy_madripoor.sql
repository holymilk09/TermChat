CREATE TABLE "agent_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"token_hash" varchar(256) NOT NULL,
	"name" varchar(128) DEFAULT 'default',
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_auth_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_code" varchar(16) NOT NULL,
	"device_code" varchar(128) NOT NULL,
	"user_id" uuid,
	"agent_id" uuid,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"scopes" text[] DEFAULT '{}',
	"agent_config" jsonb DEFAULT '{}'::jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_auth_requests_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "device_auth_requests_device_code_unique" UNIQUE("device_code")
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid,
	"agent_token" varchar(256),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"exchanged_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pairing_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD CONSTRAINT "device_auth_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD CONSTRAINT "device_auth_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_tokens_agent" ON "agent_tokens" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_device_auth_user_code" ON "device_auth_requests" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "idx_device_auth_device_code" ON "device_auth_requests" USING btree ("device_code");--> statement-breakpoint
CREATE INDEX "idx_pairing_code" ON "pairing_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_pairing_user" ON "pairing_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_pairing_expires" ON "pairing_codes" USING btree ("expires_at");