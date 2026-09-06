CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"name" varchar(128) NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"prefix" varchar(12) NOT NULL,
	"rpm" integer DEFAULT 60 NOT NULL,
	"tpm" integer DEFAULT 100000 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"external_id" varchar(128),
	"channel" varchar(32) DEFAULT 'api' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"name" varchar(256) NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardrail_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"trace_id" varchar(64) NOT NULL,
	"verdict" varchar(16) NOT NULL,
	"risk_level" varchar(16) NOT NULL,
	"matched_rules" jsonb NOT NULL,
	"confidence" integer NOT NULL,
	"reason" text,
	"input_preview" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "industry_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"industry" varchar(32) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"rules" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"response_id" varchar(64),
	"trace_id" varchar(64),
	"risk_level" varchar(16),
	"guardrail_verdict" varchar(16),
	"model_used" varchar(128),
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retrieval_audits" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"channel" varchar(32) DEFAULT 'api' NOT NULL,
	"query" text NOT NULL,
	"collection" varchar(128) NOT NULL,
	"top_k" integer NOT NULL,
	"filters" text,
	"results" jsonb NOT NULL,
	"latency_ms" integer NOT NULL,
	"success" boolean NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"trace_id" varchar(64) NOT NULL,
	"conversation_id" integer,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"risk_level" varchar(16) NOT NULL,
	"original_query" text NOT NULL,
	"draft_response" text NOT NULL,
	"rag_evidence" jsonb NOT NULL,
	"guardrail" jsonb NOT NULL,
	"reviewer_id" varchar(128),
	"review_comment" text,
	"reviewed_at" timestamp with time zone,
	"final_response" text,
	"final_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"industry" varchar(32) DEFAULT 'general' NOT NULL,
	"system_prompt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "usage_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"api_key_id" integer NOT NULL,
	"trace_id" varchar(64) NOT NULL,
	"model" varchar(128) NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cache_hit" varchar(16) DEFAULT 'none' NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "documents_tenant_idx" ON "documents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "guardrail_events_tenant_idx" ON "guardrail_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "industry_rules_industry_idx" ON "industry_rules" USING btree ("industry");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "retrieval_audits_tenant_idx" ON "retrieval_audits" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "review_queue_status_idx" ON "review_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "usage_logs_tenant_idx" ON "usage_logs" USING btree ("tenant_id","created_at");