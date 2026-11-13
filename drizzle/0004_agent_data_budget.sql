CREATE TABLE "agent_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"url" text NOT NULL,
	"pay_to" text,
	"amount_usd" numeric NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"tx_hash" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guardrails" ADD COLUMN "data_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guardrails" ADD COLUMN "agent_budget_usd" numeric DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "guardrails" ADD COLUMN "data_daily_usd" numeric DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "guardrails" ADD COLUMN "data_max_call_usd" numeric DEFAULT 0.05 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_payments" ADD CONSTRAINT "agent_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_payment_user_idx" ON "agent_payments" USING btree ("user_id","created_at");