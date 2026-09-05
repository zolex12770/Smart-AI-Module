CREATE TABLE "rate_limit_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_expires_idx" ON "rate_limit_counters" USING btree ("expires_at");