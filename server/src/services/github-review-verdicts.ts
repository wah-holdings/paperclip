import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  githubAgentMappings,
  githubReviewVerdictDiagnostics,
  githubReviewVerdicts,
  issues,
} from "@paperclipai/db";
import { extractIssueReferenceIdentifiers } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";

const ELIGIBLE_SOURCE_STATUSES = ["done", "blocked", "in_review"] as const;

type GitHubReviewPayload = {
  action?: string;
  review?: { id?: number; state?: string; commit_id?: string };
  pull_request?: {
    title?: string;
    body?: string | null;
    head?: { sha?: string };
    user?: { login?: string };
  };
};

export type GitHubReviewVerdictResult =
  | { outcome: "ignored" }
  | { outcome: "invalid_signature" }
  | { outcome: "diagnostic"; reason: string }
  | { outcome: "transitioned"; issueId: string }
  | { outcome: "duplicate"; issueId: string };

function safeEqualHex(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function verifyGitHubWebhookSignature(rawBody: Buffer, signature: string | undefined, secret: string | undefined) {
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return safeEqualHex(expected, signature);
}

function parsePayload(body: unknown): GitHubReviewPayload | null {
  return body && typeof body === "object" ? body as GitHubReviewPayload : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function githubReviewVerdictService(db: Db) {
  async function diagnostic(input: {
    reason: string;
    companyId?: string | null;
    issueId?: string | null;
    githubReviewId?: string | null;
    headSha?: string | null;
    issueIdentifiers?: string[];
  }) {
    await db.insert(githubReviewVerdictDiagnostics).values({
      reason: input.reason,
      companyId: input.companyId ?? null,
      issueId: input.issueId ?? null,
      githubReviewId: input.githubReviewId ?? null,
      headSha: input.headSha ?? null,
      issueIdentifiers: input.issueIdentifiers ?? [],
    });
  }

  return {
    async ingest(rawBody: Buffer, signature: string | undefined, configuredSecret: string | undefined): Promise<GitHubReviewVerdictResult> {
      if (!verifyGitHubWebhookSignature(rawBody, signature, configuredSecret)) {
        await diagnostic({ reason: "invalid_signature" });
        return { outcome: "invalid_signature" };
      }
      const payload = parsePayload(JSON.parse(rawBody.toString("utf8")));
      const reviewId = payload ? stringValue(payload.review?.id) : null;
      const headSha = payload ? stringValue(payload.pull_request?.head?.sha) : null;
      if (payload?.action !== "submitted" && payload?.action !== "edited") return { outcome: "ignored" };
      if (payload.review?.state?.toLowerCase() !== "changes_requested") return { outcome: "ignored" };
      const commitId = stringValue(payload.review.commit_id);
      if (!reviewId || !headSha || !commitId) {
        await diagnostic({ reason: "malformed_verdict", githubReviewId: reviewId, headSha });
        return { outcome: "diagnostic", reason: "malformed_verdict" };
      }

      const identifiers = extractIssueReferenceIdentifiers(`${payload.pull_request?.title ?? ""}\n${payload.pull_request?.body ?? ""}`);
      if (identifiers.length === 0) {
        await diagnostic({ reason: "no_issue_identifier", githubReviewId: reviewId, headSha });
        return { outcome: "diagnostic", reason: "no_issue_identifier" };
      }
      if (identifiers.length !== 1) {
        await diagnostic({ reason: "ambiguous_issue_identifier", githubReviewId: reviewId, headSha, issueIdentifiers: identifiers });
        return { outcome: "diagnostic", reason: "ambiguous_issue_identifier" };
      }

      const issue = await db.select().from(issues).where(eq(issues.identifier, identifiers[0]!)).then((rows) => rows[0] ?? null);
      if (!issue) {
        await diagnostic({ reason: "unresolved_ticket", githubReviewId: reviewId, headSha, issueIdentifiers: identifiers });
        return { outcome: "diagnostic", reason: "unresolved_ticket" };
      }
      if (commitId !== headSha) {
        await diagnostic({ reason: "stale_head", companyId: issue.companyId, issueId: issue.id, githubReviewId: reviewId, headSha, issueIdentifiers: identifiers });
        return { outcome: "diagnostic", reason: "stale_head" };
      }

      const authorLogin = stringValue(payload.pull_request?.user?.login)?.toLowerCase() ?? null;
      const mappedAgent = authorLogin
        ? await db.select({ agentId: githubAgentMappings.agentId })
          .from(githubAgentMappings)
          .innerJoin(agents, eq(agents.id, githubAgentMappings.agentId))
          .where(and(eq(githubAgentMappings.companyId, issue.companyId), eq(githubAgentMappings.githubLogin, authorLogin), eq(agents.companyId, issue.companyId)))
          .then((rows) => rows[0] ?? null)
        : null;

      const inserted = await db.insert(githubReviewVerdicts).values({
        companyId: issue.companyId,
        issueId: issue.id,
        githubReviewId: reviewId,
        headSha,
      }).onConflictDoNothing().returning({ id: githubReviewVerdicts.id });
      if (inserted.length === 0) {
        await diagnostic({ reason: "duplicate", companyId: issue.companyId, issueId: issue.id, githubReviewId: reviewId, headSha, issueIdentifiers: identifiers });
        return { outcome: "duplicate", issueId: issue.id };
      }

      const patch = mappedAgent ? { status: "in_progress" as const, assigneeAgentId: mappedAgent.agentId, assigneeUserId: null, startedAt: new Date(), updatedAt: new Date() } : { status: "in_progress" as const, startedAt: new Date(), updatedAt: new Date() };
      const transitioned = await db.update(issues).set(patch).where(and(eq(issues.id, issue.id), inArray(issues.status, [...ELIGIBLE_SOURCE_STATUSES]))).returning({ id: issues.id });
      if (transitioned.length === 0) {
        await diagnostic({ reason: "ineligible_state", companyId: issue.companyId, issueId: issue.id, githubReviewId: reviewId, headSha, issueIdentifiers: identifiers });
        return { outcome: "diagnostic", reason: "ineligible_state" };
      }
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: "github-review-webhook",
        action: "issue.github_changes_requested_reopened",
        entityType: "issue",
        entityId: issue.id,
        agentId: mappedAgent?.agentId ?? null,
        details: { githubReviewId: reviewId, headSha, assigneeMapped: Boolean(mappedAgent) },
      });
      return { outcome: "transitioned", issueId: issue.id };
    },

    async listUnmatched(limit = 100) {
      return db.select({
        id: githubReviewVerdictDiagnostics.id,
        companyId: githubReviewVerdictDiagnostics.companyId,
        issueId: githubReviewVerdictDiagnostics.issueId,
        githubReviewId: githubReviewVerdictDiagnostics.githubReviewId,
        headSha: githubReviewVerdictDiagnostics.headSha,
        reason: githubReviewVerdictDiagnostics.reason,
        issueIdentifiers: githubReviewVerdictDiagnostics.issueIdentifiers,
        createdAt: githubReviewVerdictDiagnostics.createdAt,
      }).from(githubReviewVerdictDiagnostics)
        .where(inArray(githubReviewVerdictDiagnostics.reason, ["no_issue_identifier", "ambiguous_issue_identifier", "unresolved_ticket", "invalid_signature", "stale_head"]))
        .orderBy(desc(githubReviewVerdictDiagnostics.createdAt))
        .limit(Math.min(Math.max(limit, 1), 500));
    },
  };
}
