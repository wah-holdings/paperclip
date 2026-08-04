CREATE TABLE "github_agent_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "github_login" text NOT NULL,
  "agent_id" uuid NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "github_agent_mappings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade,
  CONSTRAINT "github_agent_mappings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX "github_agent_mappings_company_login_uq" ON "github_agent_mappings" USING btree ("company_id", "github_login");--> statement-breakpoint
CREATE INDEX "github_agent_mappings_agent_idx" ON "github_agent_mappings" USING btree ("agent_id");--> statement-breakpoint

CREATE TABLE "github_review_verdicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "github_review_id" text NOT NULL,
  "head_sha" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "github_review_verdicts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade,
  CONSTRAINT "github_review_verdicts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX "github_review_verdicts_review_head_uq" ON "github_review_verdicts" USING btree ("github_review_id", "head_sha");--> statement-breakpoint
CREATE INDEX "github_review_verdicts_company_issue_idx" ON "github_review_verdicts" USING btree ("company_id", "issue_id");--> statement-breakpoint

CREATE TABLE "github_review_verdict_diagnostics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid,
  "issue_id" uuid,
  "github_review_id" text,
  "head_sha" text,
  "reason" text NOT NULL,
  "issue_identifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "github_review_verdict_diagnostics_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade,
  CONSTRAINT "github_review_verdict_diagnostics_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null
);--> statement-breakpoint
CREATE INDEX "github_review_verdict_diagnostics_unresolved_idx" ON "github_review_verdict_diagnostics" USING btree ("reason", "created_at");--> statement-breakpoint
CREATE INDEX "github_review_verdict_diagnostics_company_idx" ON "github_review_verdict_diagnostics" USING btree ("company_id", "created_at");
