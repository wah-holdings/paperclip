# GitHub changes-requested webhook

This bridge is intentionally narrow: a verified GitHub `changes_requested` review can only reopen a matching Paperclip issue from `done`, `blocked`, or `in_review` to `in_progress`.

## Cortana configuration

1. Generate a random webhook secret and inject it into the Paperclip server as `PAPERCLIP_GITHUB_REVIEW_WEBHOOK_SECRET`. Do not store it in source, tickets, logs, or a GitHub URL.
2. In the target GitHub repository: **Settings → Webhooks → Add webhook**.
   - Payload URL: `https://<paperclip-host>/api/webhooks/github/pull-request-review`
   - Content type: `application/json`
   - Secret: the value injected above
   - Events: select **Let me select individual events**, then only **Pull request reviews**.
   - Active: enabled.
3. Rotate by creating a new random value in the operator secret manager, updating the server environment, restarting/redeploying the server, then replacing the GitHub webhook secret. The old and new secrets cannot overlap; perform the swap in one maintenance window.

## Safe operator surface

Board users can inspect unresolved or unsafe deliveries with:

`GET /api/github/review-verdicts/unmatched?limit=100`

This returns diagnostics for invalid signatures, missing/ambiguous issue identifiers, unknown tickets, and stale heads. It deliberately stores no raw request body, signature, authorization value, or GitHub review body. Alert when the response contains any diagnostics; triage the `reason`, `issueIdentifiers`, `githubReviewId`, and `headSha` fields.

## Mapping policy

The bridge preserves the existing assignee by default. It only changes an assignee when an operator-created, verified `github_agent_mappings` row maps the PR author's normalized GitHub login to an agent in the same company. GitHub webhook data never creates or updates mappings.
