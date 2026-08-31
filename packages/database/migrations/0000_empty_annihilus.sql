CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(256) NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"source_path" text NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_items" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"owner_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"provider_used" text,
	"model_used" text,
	"input_tokens" double precision,
	"output_tokens" double precision,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_id" text,
	"root_task_id" text NOT NULL,
	"type" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"depends_on" jsonb NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"tool_id" text,
	"model_provider" text,
	"retry_policy" jsonb NOT NULL,
	"timeout_ms" integer NOT NULL,
	"verification_method" text NOT NULL,
	"verification_spec" jsonb,
	"approval_required" boolean NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"node_id" text,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"task_type" text NOT NULL,
	"state" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"error_message" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_nodes" ADD CONSTRAINT "task_nodes_root_task_id_tasks_id_fk" FOREIGN KEY ("root_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_transitions" ADD CONSTRAINT "task_transitions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;