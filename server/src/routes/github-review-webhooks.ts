import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard } from "./authz.js";
import { githubReviewVerdictService } from "../services/github-review-verdicts.js";

const WEBHOOK_SECRET_ENV = "PAPERCLIP_GITHUB_REVIEW_WEBHOOK_SECRET";

export function githubReviewWebhookRoutes(db: Db) {
  const router = Router();
  const service = githubReviewVerdictService(db);

  router.post("/webhooks/github/pull-request-review", async (req, res) => {
    // Do not let generic HTTP failure logging serialize an untrusted GitHub body.
    (req as typeof req & { paperclipSuppressBodyLog?: boolean }).paperclipSuppressBodyLog = true;
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      res.status(400).json({ error: "Raw request body is required" });
      return;
    }
    try {
      const result = await service.ingest(
        rawBody,
        req.header("x-hub-signature-256") ?? undefined,
        process.env[WEBHOOK_SECRET_ENV],
      );
      if (result.outcome === "invalid_signature") {
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }
      res.status(202).json({ outcome: result.outcome });
    } catch {
      // Keep response and logs free of payload-derived data.
      res.status(400).json({ error: "Invalid webhook payload" });
    }
  });

  router.get("/github/review-verdicts/unmatched", async (req, res) => {
    assertBoard(req);
    const requestedLimit = Number(req.query.limit);
    res.json({ diagnostics: await service.listUnmatched(Number.isFinite(requestedLimit) ? requestedLimit : 100) });
  });

  return router;
}

export const GITHUB_REVIEW_WEBHOOK_SECRET_ENV = WEBHOOK_SECRET_ENV;
