ALTER TABLE "documents" ALTER COLUMN "source_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "asset_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;