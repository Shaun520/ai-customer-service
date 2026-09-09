CREATE TABLE "model_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"base_url" varchar(512) NOT NULL,
	"api_key" varchar(512) NOT NULL,
	"model" varchar(128) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"task" varchar(32) DEFAULT 'default' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_providers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE INDEX "model_providers_name_idx" ON "model_providers" USING btree ("name");