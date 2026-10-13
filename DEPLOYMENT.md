# Hosting the review UI for a team

This sets the UI up on a small Linux server, behind HTTPS, with the **Claude API** doing the reviews.
(For a self-hosted model instead, see "Using Ollama instead" at the end.)

```
browser ──HTTPS──► Caddy (certificate, port 443) ──► review UI (Node, password login)
                                                        ├──► GitHub API  (lists PRs, posts reviews)
                                                        └──► Claude API  (the AI review)
```

The Docker files (`Dockerfile`, `docker-compose.yml`, `Caddyfile`) have **not been run by their author**
(no Docker on the development machine). Treat the first start as a test and read the logs.

## 1. Decide these first

- **Where the code goes.** With the Claude API, the diffs (and the files they touch) are sent to Anthropic.
  Get your company's approval before pointing this at customer or confidential repositories, and check
  Anthropic's current data-retention terms. If code must stay in-house, use Ollama on your own server.
- **New secrets, not old ones.** Create a **new fine-grained GitHub token** limited to the repositories you
  want reviewed (Pull requests: read and write, Contents: read) with an expiry date. Never reuse a token that
  has appeared in a chat, a log or a screenshot. Create an Anthropic API key used only for this, and set a
  **spending limit** in the Anthropic console.
- **A model.** Set `ANTHROPIC_MODEL` explicitly (for example `claude-sonnet-5-5`; a smaller, cheaper model is
  less thorough). Run one test review and confirm it works before announcing it to the team.
- **A domain name** (or subdomain), and a small server: Ubuntu 22.04/24.04, 1-2 GB RAM, a public IP.

## 2. Set it up

1. **Push this project to a private GitHub repository** (the server clones it).
2. **DNS:** create an `A` record, e.g. `reviews.example.com` -> the server's IP.
3. **Server:** log in with an SSH key, turn off SSH password login, allow only ports 22, 80 and 443 in the
   firewall (`ufw allow 22,80,443/tcp && ufw enable`), and install Docker Engine with the compose plugin
   (follow Docker's own instructions for your Ubuntu version).
4. **Get the code:** `git clone <your private repo> && cd pr-review-agent`
5. **Create `.env`** next to `docker-compose.yml` (then `chmod 600 .env`; never commit it):

   ```
   UI_DOMAIN=reviews.example.com
   PR_REVIEW_UI_PASSWORD=<a long random password>
   GITHUB_TOKEN=<the new token>
   GITHUB_OWNER=<default owner>
   GITHUB_REPO=<default repo>
   ANTHROPIC_API_KEY=<the new key>
   ANTHROPIC_MODEL=claude-sonnet-5-5
   ```

   Do **not** set `ANTHROPIC_BASE_URL` (that points at Ollama).
6. **Start:** `docker compose up -d --build`, then `docker compose logs -f`. You should see Caddy obtain a
   certificate and the UI print `PR review UI running`. (If the certificate fails, check that the DNS record
   points at this server and that ports 80/443 are open.)
7. **Use it:** open `https://reviews.example.com`, sign in, load a repository, press **Review** on a pull
   request, check the preview, then **Post** or **Discard**. The **Auto-review** switch makes the server watch the
   repository itself.

## 2b. The easy way: Render (no server, SSH, domain or Docker)

The review UI is **one Node.js app** that serves both the page and its API, so unlike a split frontend/backend setup there
is only **one** thing to deploy and nothing to connect (no Netlify, no CORS, no n8n, no database). Render builds it from
the GitHub repository, gives it an `https://...` address, and **redeploys on every push to `main`**.

The UI recognises Render automatically: it listens on `0.0.0.0` and Render's `PORT`, trusts Render's HTTPS proxy, marks
the login cookie `Secure`, and accepts the `*.onrender.com` address. You only have to give it the secrets.
(These steps were written without having deployed to Render, and button labels may differ a little.)

**Before you start**
- A **new** fine-grained GitHub token (only the repositories to review; Pull requests: read and write, Contents: read;
  with an expiry date), an Anthropic API key **used only for this** with a **monthly spending limit** set in the Anthropic
  console, and a long random password for the UI (`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`).
  Keep them in a private notes file outside the project; never put them in code, Git, chat or screenshots.
- Check nothing secret is committed: `git grep -i "sk-ant"` must print nothing.
- Run it locally once: `npm install`, then `npm run ui`, and open `http://127.0.0.1:4500`.

**On Render**
1. Sign up at render.com with GitHub (choose "Only select repositories" and pick this repo).
2. **New + -> Web Service**, select the repository, and fill in the form:

   | Field | Value |
   |---|---|
   | Name | `pr-review-agent-ui` (must be unique) |
   | Region | the closest one |
   | Branch | `main` |
   | Root Directory | leave empty |
   | Runtime / Language | **Node** |
   | Build Command | `npm ci --include=dev` |
   | Start Command | `npm run ui` |
   | Instance Type | **Free** |

   (The dev dependencies are needed because the app runs its TypeScript with `tsx`.)
3. **Environment Variables** (check each value for stray spaces):

   | Key | Value |
   |---|---|
   | `NODE_VERSION` | `22` |
   | `PR_REVIEW_UI_PASSWORD` | the long random password |
   | `GITHUB_TOKEN` | the new token |
   | `GITHUB_OWNER` | default owner |
   | `GITHUB_REPO` | default repo |
   | `ANTHROPIC_API_KEY` | the Anthropic key |
   | `ANTHROPIC_MODEL` | `claude-sonnet-5-5` |

   Do **not** set `ANTHROPIC_BASE_URL` or a port.
4. Optional, under Advanced: **Health Check Path** `/api/session` (it answers without logging in).
5. **Create Web Service.** Watch the **Logs**: after the build you should see `PR review UI running at ...` and
   `Password protection is ON.`, and the status becomes **Live**. Open `https://<name>.onrender.com`, sign in, load
   a repository, and try a review.

**Checklist** (tick each one)
- [ ] `https://<name>.onrender.com/api/session` answers (`{"authRequired":true,"authenticated":false}`)
- [ ] The page opens and the password logs you in; a wrong password is refused
- [ ] **Load pull requests** lists the repository's pull requests
- [ ] A review runs and shows findings, and nothing is posted until you press **Post to GitHub**
- [ ] A spending limit is set in the Anthropic console
- [ ] `git grep -i "sk-ant"` prints nothing

**Things to know**
- A free instance **sleeps after about 15 minutes without use**; the first request afterwards takes 30-60 seconds.
- The hosted UI cannot reach an Ollama on your computer, so it uses the Claude API (your code goes to Anthropic).
- Leave the **Auto-review** switch off: the GitHub Actions workflow already reviews new pull requests.
- Review history lives on the instance's disk and is lost on every redeploy unless you attach a persistent disk
  (usually paid, mounted at `/data` with `PR_REVIEW_DATA_DIR=/data`). Edits in the "Review rules" page are lost the
  same way - change `docs/conventions/*.md` in git instead.
- Render may ask for a payment card even for a free instance. Railway and Fly.io work the same way (the app recognises
  them too), and a `Dockerfile` is also provided if you prefer **Runtime: Docker**.

| What you see | What it means | Fix |
|---|---|---|
| "No open ports detected" | The app is not listening on Render's port | Remove any `PR_REVIEW_UI_PORT` / `PR_REVIEW_UI_HOST` variable you added |
| "GITHUB_TOKEN is not set" / "Refusing to listen ... without a password" | A variable is missing or misspelled | Check the names exactly, and for stray spaces |
| Build fails at `tsx` / "not found" | Dev dependencies were skipped | Build Command must be `npm ci --include=dev` |
| "This host name is not allowed" | The address is not recognised | Add `PR_REVIEW_UI_ALLOWED_HOSTS` = `<name>.onrender.com` |
| Chat or review says the model/key is wrong | `ANTHROPIC_API_KEY` or `ANTHROPIC_MODEL` is wrong | Fix the value and look at the Logs |
| First page load takes a minute | The free instance was asleep | Normal; wait and retry |

## 3. Running it

| Task | Command |
|---|---|
| Update to the latest code | `git pull && docker compose up -d --build` |
| See what it is doing | `docker compose logs -f pr-review-ui` |
| Change a secret or the password | edit `.env`, then `docker compose up -d` |
| Stop | `docker compose down` (data is kept in volumes) |
| Back up | the `pr-review-data` volume (review history, auto-review state) and the `docs/conventions` folder |

## 4. Security: what this does and does not give you

- **One shared password.** Everyone who knows it can post reviews to GitHub as the token's owner, and there is no
  per-person audit trail. Change the password when someone leaves. A GitHub App with real per-user sign-in would be
  better and is **not built**.
- Login attempts are limited per person (the proxy's `X-Forwarded-For` is trusted because
  `PR_REVIEW_UI_TRUST_PROXY=1` is set in the compose file - do not set it without a proxy in front).
- The UI is only reachable through Caddy over HTTPS; the login cookie is `HttpOnly`, `SameSite=Strict`, `Secure`.
- Scope the GitHub token to the needed repositories only, and rotate it before it expires.
- There is no monitoring or alerting. An easy uptime check is `https://reviews.example.com/api/session`
  (it answers without logging in).

## 5. Other ways

- **No server at all (the simplest):** `.github/workflows/pr-review.yml` runs the review inside GitHub Actions and
  posts it on the pull request, using the Claude API. No web UI, no preview (it posts directly), no server, domain or
  HTTPS to look after. Set up:
  1. Create an Anthropic API key used only for this, and set a spending limit in the Anthropic console.
  2. Repository **Settings -> Secrets and variables -> Actions -> Secrets -> New repository secret**: name
     `ANTHROPIC_API_KEY`, value the key. (Optional, under **Variables**: `ANTHROPIC_MODEL`; the default is
     `claude-sonnet-5-5`.)
  3. **Actions** tab -> **Automated PR Review** -> **Enable workflow** (it may have been disabled).
  4. Open a pull request, or push a commit to one that targets `main`. A run appears under Actions; the review
     shows up as comments on the pull request. Draft pull requests are skipped; a new push cancels a still-running
     review of the same PR.

  Pull requests from forks never receive the secret (GitHub withholds it), so strangers cannot spend your API key;
  their run simply fails. The workflow runs the trusted code of the PR's **base** commit, never the PR's own code.
  The model's tag/naming findings and the other checks use the repository's `docs/conventions` as it is on the base
  branch.
- **Without Docker:** install Node 22, then `npm ci && npm run ui` with the same variables plus
  `PR_REVIEW_UI_HOST=127.0.0.1`, run it with systemd, and put Caddy or nginx in front of it
  (set `PR_REVIEW_UI_ALLOWED_HOSTS`, `PR_REVIEW_UI_COOKIE_SECURE=true`, `PR_REVIEW_UI_TRUST_PROXY=1`).
- **Using Ollama instead of the Claude API:** on a server that runs Ollama (a 7B model needs roughly 8 GB of RAM
  and is slow without a GPU), start with
  `docker compose -f docker-compose.yml -f docker-compose.ollama.yml up -d --build`. Never expose Ollama's port
  11434 to the internet - it has no login.

## 6. Costs

The Claude API is pay-per-use: roughly one model call per reviewed pull request or new commit (plus one retry if
the model returns a malformed answer). The cost depends on the size of the diff and the model; watch the usage
page of the Anthropic console, and keep the spending limit in place.
