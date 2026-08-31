CREATE TABLE "video_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"prompt" text NOT NULL,
	"target_duration_seconds" integer NOT NULL,
	"scene_clip_seconds" integer NOT NULL,
	"scene_count" integer NOT NULL,
	"status" text NOT NULL,
	"render_status" text,
	"render_asset_id" text,
	"render_error" text,
	"error_message" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_scenes" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"scene_index" integer NOT NULL,
	"shot_description" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"status" text NOT NULL,
	"job_id" text,
	"asset_id" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "video_scenes" ADD CONSTRAINT "video_scenes_project_id_video_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."video_projects"("id") ON DELETE no action ON UPDATE no action;