CREATE TABLE "upload_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(256) NOT NULL,
	"object_key" varchar(512) NOT NULL,
	"bucket" varchar(256) NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"mime_type" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "upload_files_created_idx" ON "upload_files" USING btree ("created_at");