CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_path" text NOT NULL,
	"checksum" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"prompt" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text NOT NULL,
	"provider_name" text,
	"result_asset_id" text,
	"error_message" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
