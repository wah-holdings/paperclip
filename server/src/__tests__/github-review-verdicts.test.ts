import { createHmac, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  activityLog,
  githubReviewVerdictDiagnostics,
  githubReviewVerdicts,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { githubReviewVerdictService, verifyGitHubWebhookSignature } from "../services/github-review-verdicts.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
const secret = "test-github-webhook-secret";

function payload(input: { identifier?: string; head?: string; commit?: string; reviewId?: number; body?: string | null } = {}) {
  const identifier = Object.hasOwn(input, "identifier") ? input.identifier : "BET-2164";
  return {
    action: "submitted",
    review: { id: input.reviewId ?? 123, state: "changes_requested", commit_id: input.commit ?? input.head ?? "head-1" },
    pull_request: {
      title: identifier ? `Rework ${identifier}` : "No ticket reference",
      body: input.body ?? null,
      head: { sha: input.head ?? "head-1" },
      user: { login: "author" },
    },
  };
}

function signed(value: unknown) {
  const raw = Buffer.from(JSON.stringify(value));
  return { raw, signature: `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` };
}

describeEmbedded("github changes-requested review bridge", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof githubReviewVerdictService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-review-verdicts-");
    db = createDb(tempDb.connectionString);
    svc = githubReviewVerdictService(db);
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS github_review_verdicts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE, github_review_id text NOT NULL, head_sha text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX IF NOT EXISTS github_review_verdicts_review_head_uq ON github_review_verdicts (github_review_id, head_sha);
      CREATE TABLE IF NOT EXISTS github_review_verdict_diagnostics (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
        issue_id uuid REFERENCES issues(id) ON DELETE SET NULL, github_review_id text, head_sha text, reason text NOT NULL,
        issue_identifiers jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS github_agent_mappings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        github_login text NOT NULL, agent_id uuid NOT NULL, verified_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    `));
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(githubReviewVerdictDiagnostics);
    await db.delete(githubReviewVerdicts);
    await db.delete(issues);
    await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seedIssue(status: "done" | "blocked" | "in_review" | "todo" = "done", identifier = "BET-2164") {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Bridge test", issuePrefix: "BET", requireBoardApprovalForNewAgents: false });
    await db.insert(issues).values({ id: issueId, companyId, issueNumber: 2164, identifier, title: "Bridge", status, priority: "high", assigneeUserId: "operator" });
    return { companyId, issueId };
  }

  it.each(["done", "blocked", "in_review"] as const)("replays %s into in_progress", async (status) => {
    const { issueId } = await seedIssue(status);
    const replay = signed(payload({ reviewId: status === "done" ? 1 : status === "blocked" ? 2 : 3 }));
    const result = await svc.ingest(replay.raw, replay.signature, secret);
    expect(result).toEqual({ outcome: "transitioned", issueId });
    await expect(db.select({ status: issues.status }).from(issues)).resolves.toEqual([{ status: "in_progress" }]);
  });

  it("records duplicate, stale head, zero/ambiguous identifier, unknown ticket, and bad signature", async () => {
    await seedIssue();
    const first = signed(payload());
    expect((await svc.ingest(first.raw, first.signature, secret)).outcome).toBe("transitioned");
    expect((await svc.ingest(first.raw, first.signature, secret)).outcome).toBe("duplicate");
    for (const replay of [
      signed(payload({ reviewId: 2, head: "current", commit: "old" })),
      signed(payload({ reviewId: 3, identifier: undefined })),
      signed(payload({ reviewId: 4, identifier: "BET-1", body: "also BET-2" })),
      signed(payload({ reviewId: 5, identifier: "BET-9999" })),
    ]) await svc.ingest(replay.raw, replay.signature, secret);
    expect((await svc.ingest(first.raw, "sha256=bad", secret)).outcome).toBe("invalid_signature");
    const reasons = await db.select({ reason: githubReviewVerdictDiagnostics.reason }).from(githubReviewVerdictDiagnostics);
    expect(reasons.map((row) => row.reason).sort()).toEqual([
      "ambiguous_issue_identifier", "duplicate", "invalid_signature", "no_issue_identifier", "stale_head", "unresolved_ticket",
    ]);
  });
});

describe("GitHub signature verifier", () => {
  it("requires a SHA-256 signature over the exact raw bytes", () => {
    const replay = signed({ a: 1 });
    expect(verifyGitHubWebhookSignature(replay.raw, replay.signature, secret)).toBe(true);
    expect(verifyGitHubWebhookSignature(Buffer.from('{"a": 1}'), replay.signature, secret)).toBe(false);
  });
});
