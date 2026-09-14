CREATE TABLE "audio_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"created_by_user_id" text,
	"text" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text NOT NULL,
	"provider_name" text,
	"voice_name" text,
	"duration_seconds" double precision,
	"result_asset_id" text,
	"error_message" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audio_generations" ADD CONSTRAINT "audio_generations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_generations" ADD CONSTRAINT "audio_generations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_generations" ADD CONSTRAINT "audio_generations_result_asset_id_assets_id_fk" FOREIGN KEY ("result_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audio_generations_project_created_idx" ON "audio_generations" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "audio_generations_status_idx" ON "audio_generations" USING btree ("status");