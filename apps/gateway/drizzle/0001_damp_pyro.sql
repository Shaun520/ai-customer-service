ALTER TABLE "retrieval_audits" ADD COLUMN "trace_id" varchar(64);--> statement-breakpoint
CREATE INDEX "retrieval_audits_trace_idx" ON "retrieval_audits" USING btree ("trace_id");