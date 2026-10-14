# Deploying the PR review webhook backend on Northflank

This puts the **webhook backend** online. It runs 24/7 and does the following, with no one at a keyboard:

1. GitHub tells it a pull request was **opened**, **updated** or **reopened** (a "webhook"),
2. it checks the event really came from GitHub (a signature),
3. it reads the changed files and asks **Claude** to review them,
4. it posts the review as comments on the pull request.

```
Developer opens a PR on GitHub
        │  webhook (POST /webhooks/github)
        ▼
Northflank: pr-review-agent  ──► Claude API (writes the review)
        │
        └──► GitHub API (posts the review on the PR)
```

**This replaces the GitHub Actions workflow for the same repository - do not run both.** Both would review every pull
request, doubling the API cost (duplicate comments are skipped, but the model is still called twice). If the workflow
is enabled, disable it under the repository's **Actions** tab.

This is a separate thing from the review **web UI** (`npm run ui`), which is for reviewing by hand with a preview.

The Docker file and these steps have not been run on Northflank by their author: treat the first deploy as a test and read the
logs. Do the steps in order, and keep your secrets in a private notes file **outside** the project, never in code, Git, chat
or screenshots.

## Step 0: Check the code

```bash
git grep -i "sk-ant"
```

must print nothing. The repository contains what Northflank needs: `Dockerfile.webhook` (builds and starts the webhook
server on `PORT`), `/health` (answers `{"status":"ok"}`), and `.gitignore` already excludes `node_modules/` and `.env`.

## Step 1: Two secrets

**GitHub token** (lets the backend read pull requests and post reviews): GitHub -> Settings -> Developer settings ->
Personal access tokens -> **Fine-grained tokens** -> Generate new token.
- Name `pr-review-agent`, expiration for example 90 days.
- **Only select repositories**: the repository (or repositories) to review.
- Permissions: **Pull requests: Read and write**, **Contents: Read-only**.
- Copy the token to your notes as `GITHUB_TOKEN` (it is shown once).

**Webhook secret** (proves events come from GitHub):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Save it as `GITHUB_WEBHOOK_SECRET`. It goes into **both** Northflank and GitHub.

You also need an **Anthropic API key** (created only for this, with a **monthly spending limit** set in the Anthropic console)
and the model name, for example `claude-sonnet-5-5`.

## Step 2: Account, GitHub link, project

1. northflank.com -> **Sign up with GitHub**; choose the free **Developer Sandbox** plan if asked.
   If it asks for a **payment card** and you cannot continue without one, stop here (see "If a card is required").
2. In the account/team settings find **Git** (or Integrations -> Version control) and **Link GitHub**. Install the
   Northflank app on **Only select repositories** and choose this repository.
3. **Create project**: name `ai-agents-test`, a region close to you.

## Step 3: Create the service

In the project: **Create new -> Service -> Combined service**.

| Setting | Value |
|---|---|
| Name | `pr-review-agent` (cannot be changed later) |
| Repository / Branch | this repository, `main` |
| Build | **Dockerfile**, Dockerfile location `/Dockerfile.webhook`, build context `/` |
| Port | add port `4000`, protocol `HTTP`, tick **Publicly expose this port**, name `api` |

(If you prefer **Buildpack**: the repository's `Procfile` starts `node dist/webhook/server.js`, but the build must also run
`npm run build`; if the service then fails with "Cannot find module dist/webhook/server.js", switch to the Dockerfile.)

**Runtime variables** (not build arguments; no spaces before or after any value):

| Key | Value |
|---|---|
| `PORT` | `4000` |
| `GITHUB_WEBHOOK_SECRET` | from step 1 |
| `GITHUB_TOKEN` | from step 1 |
| `ANTHROPIC_API_KEY` | your Claude key |
| `ANTHROPIC_MODEL` | the model name |

Do **not** set `ANTHROPIC_BASE_URL`. Pick the smallest free/sandbox compute plan, then **Create service**.

## Step 4: Watch it start and test the address

1. **Builds** tab: the build runs `npm ci`, compiles and finishes (a few minutes the first time).
2. **Logs** tab: you should see `GitHub webhook server listening on port 4000`.
3. Copy the public address from **Ports & DNS** (like `https://api--pr-review-agent--abcd1234.code.run`).
4. Open `https://<your-address>/health` in a browser: `{"status":"ok"}`.
5. The protection must refuse an unsigned request (expected: `{"error":"Invalid signature."}`):
   ```bash
   curl -X POST https://<your-address>/webhooks/github -H "Content-Type: application/json" -d "{}"
   ```
6. Optional: Service -> **Health checks** -> HTTP check, path `/health`, port `4000`.

## Step 5: Connect the GitHub webhook

Repository to review -> **Settings -> Webhooks -> Add webhook**:

| Field | Value |
|---|---|
| Payload URL | `https://<your-address>/webhooks/github` |
| Content type | `application/json` |
| Secret | your `GITHUB_WEBHOOK_SECRET` |
| Events | **Let me select individual events** -> only **Pull requests** |
| Active | ticked |

Open it -> **Recent Deliveries**: the first **ping** has a green tick (the server answers 200 and ignores it).
The repository must be included in the token's **repository access** (step 1).

## Step 6: End-to-end test

1. In the reviewed repository, push a branch with a small obvious problem and **open a pull request**.
2. Watch **Logs**: the webhook is accepted (202) and the review is processed. `https://<your-address>/webhooks/status`
   lists each review and its state.
3. Within about a minute the pull request gets the review comments. Push another commit: it is reviewed again.

## Final checklist

- [ ] `/health` shows `{"status":"ok"}`
- [ ] An unsigned webhook is rejected with 401
- [ ] The GitHub webhook ping has a green tick
- [ ] A new pull request gets review comments, and a new commit to it gets a new review
- [ ] The GitHub Actions workflow is disabled for the same repository (no double reviews)
- [ ] A monthly spending limit is set in the Anthropic console
- [ ] You wrote down the GitHub token's **expiry date** to renew it in time
- [ ] `git grep -i "sk-ant"` prints nothing

## Everyday use

| Task | How |
|---|---|
| Deploy a change | Push to `main`; Northflank builds and deploys it (put `[skip northflank]` in a commit message to skip) |
| Change a secret | Service -> **Environment** -> edit -> save (restart if needed) |
| See errors | **Logs** (running app), **Builds** (build problems) |
| Roll back | Redeploy an earlier successful build |
| Renew the GitHub token | Create a new one before it expires, update `GITHUB_TOKEN`, save |

## Common problems

| Problem | Likely cause | Fix |
|---|---|---|
| Repository not listed in Northflank | The GitHub app has no access | GitHub -> Settings -> Applications -> Northflank -> add the repository |
| Build fails at `npm run build` | A code error | Read the **Builds** log; run `npm run build` locally |
| Build OK, address gives 502 / nothing | Wrong port | `PORT=4000` runtime variable and the published port `4000` must match |
| Logs: `Missing required environment variable: GITHUB_WEBHOOK_SECRET` | Variable missing/misspelled | Check the name and for stray spaces |
| Webhook delivery shows 401 | Secret mismatch | The same exact secret on GitHub and Northflank, no spaces |
| Delivery is green but no comment appears | The review failed | Check **Logs**; see the next rows |
| `404` reading files | The token cannot see the repository | Add the repository to the token's repository access |
| `403` posting the review | The token cannot write | Permission **Pull requests: Read and write** |
| Claude `401` | Wrong `ANTHROPIC_API_KEY` | Fix the value |
| Claude `400 ... tool_choice` | Fixed in the code | Make sure you deployed the latest `main` |
| Sign-up asks for a card | Account verification | See below |

## If a card is required

Some free plans ask for a payment card only to verify you. If your card is declined (online/international payments are often
switched off on local cards; enable them with your bank), or you do not want to add one, use the GitHub Actions workflow
(section 2 of DEPLOYMENT.md): it needs no server and no card.

## Security notes

- `/webhooks/status` answers without a login and lists repository names, PR numbers and review states. That is harmless for
  a public repository; for a private one, do not expose this service publicly, or ask for that route to be protected.
- The webhook secret is the only thing stopping others from triggering reviews (and spending your API budget): keep it
  long and random, and rotate it if it leaks (update it on **both** Northflank and GitHub).
- The server sends code from reviewed pull requests to the Claude API. Only connect repositories you are allowed to send there.
