CREATE TABLE "agent_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"asset" text,
	"action" text NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb,
	"proposal_id" uuid,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"tick_count" integer DEFAULT 0 NOT NULL,
	"last_tick_at" timestamp with time zone,
	"headline" text DEFAULT '' NOT NULL,
	"reads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_keys" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"asset" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"strategy" text NOT NULL,
	"qty" numeric NOT NULL,
	"cost_usd" numeric NOT NULL,
	"stop_price" numeric NOT NULL,
	"target_price" numeric NOT NULL,
	"high_price" numeric NOT NULL,
	"atr_pct" numeric NOT NULL,
	"realized_pnl_usd" numeric DEFAULT 0 NOT NULL,
	"exit_reason" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_state" ADD CONSTRAINT "agent_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_user_idx" ON "agent_decisions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "position_user_idx" ON "positions" USING btree ("user_id","status");