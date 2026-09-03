CREATE TABLE "usage_records" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"units" integer,
	"estimated_cost_usd" double precision,
	"request_id" text,
	"created_at" timestamp NOT NULL
);
