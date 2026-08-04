import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/** Explicit operator-managed identity binding; GitHub data never creates one. */
export const githubAgentMappings = pgTable(
  "github_agent_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    githubLogin: text("github_login").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyLoginUq: uniqueIndex("github_agent_mappings_company_login_uq").on(table.companyId, table.githubLogin),
    agentIdx: index("github_agent_mappings_agent_idx").on(table.agentId),
  }),
);

/** One successfully authenticated GitHub review/head pair may affect state once. */
export const githubReviewVerdicts = pgTable(
  "github_review_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    githubReviewId: text("github_review_id").notNull(),
    headSha: text("head_sha").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    reviewHeadUq: uniqueIndex("github_review_verdicts_review_head_uq").on(table.githubReviewId, table.headSha),
    companyIssueIdx: index("github_review_verdicts_company_issue_idx").on(table.companyId, table.issueId),
  }),
);

/** Operator-safe audit trail: identifiers and reason only, never payloads or signatures. */
export const githubReviewVerdictDiagnostics = pgTable(
  "github_review_verdict_diagnostics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    githubReviewId: text("github_review_id"),
    headSha: text("head_sha"),
    reason: text("reason").notNull(),
    issueIdentifiers: jsonb("issue_identifiers").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    unresolvedIdx: index("github_review_verdict_diagnostics_unresolved_idx").on(table.reason, table.createdAt),
    companyIdx: index("github_review_verdict_diagnostics_company_idx").on(table.companyId, table.createdAt),
  }),
);
