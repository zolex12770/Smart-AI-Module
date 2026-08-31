CREATE TABLE `task_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`root_task_id` text NOT NULL,
	`type` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`depends_on` text NOT NULL,
	`input` text NOT NULL,
	`output` text,
	`tool_id` text,
	`model_provider` text,
	`retry_policy` text NOT NULL,
	`timeout_ms` integer NOT NULL,
	`verification_method` text NOT NULL,
	`verification_spec` text,
	`approval_required` integer NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`root_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`node_id` text,
	`from_state` text,
	`to_state` text NOT NULL,
	`actor` text NOT NULL,
	`payload` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`task_type` text NOT NULL,
	`state` text NOT NULL,
	`input` text NOT NULL,
	`output` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
