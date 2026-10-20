# ⚱ Lich Papers

Search and read any paper on [arXiv](https://arxiv.org), and chat with an AI tutor about it. The tutor runs on the
[`@moikapy/lich`](https://www.npmjs.com/package/@moikapy/lich) agent harness, with tools for reading the paper's
full text and for remembering what you've learned across sessions.

- **Search all of arXiv**: free text, field queries (`au:hinton`, `ti:"diffusion"`), category filters, or paste an arXiv id/URL.
- **Read**: full text in the app for openly licensed papers (CC BY, CC BY-SA, CC0), with attribution; otherwise the abstract with links to arXiv. PDFs open on arXiv.
- **Chat with the paper**: the tutor grounds its answers in the paper. It searches and reads sections as needed and shows each step it took.
- **Accounts and history**: sign up with email and password. Every conversation is saved, and you can reopen any of them from History.
- **Cross-session knowledge**: the tutor saves notes to your knowledge base, and you can summarize a session into it. New sessions can **build on** earlier ones, and every chat can search your notes.
- **Models**:
  - **Default**: OpenRouter's free router (`openrouter/free`). Users connect their OpenRouter account in one click with [OpenRouter SSO (OAuth PKCE)](https://openrouter.ai/docs/guides/overview/auth/oauth).
  - **Paid OpenRouter models**: users who have credits on OpenRouter can pick any of its models.
  - **BYOK**: users can add keys for **OpenAI**, **Anthropic**, and **Ollama** (Ollama Cloud, or their own server over HTTPS).
  - **Fallback**: if the chosen model fails, lich fails over to the free router automatically. If that fails too (most often
    OpenRouter's free-model limit, a 429), it answers on Workers AI (`@cf/zai-org/glm-4.7-flash` through the `AI` binding, billed
    to your Cloudflare account), up to `FALLBACK_DAILY_MESSAGES` (default 20) messages per user per day. `FALLBACK_MODEL` picks
    another model, and `FALLBACK_DAILY_MESSAGES=0` turns it off.
- **Decision model (optional)**: Cloudflare's [Clef / Clef Flash](https://ollama.com/library/clef) on Ollama, a small judge model that answers typed questions (yes/no, choice, score) through `/v1/systemone`. It runs on the user's own Ollama key (Settings → Decision model), or on the app's shared one: Workers AI through the `AI` binding (`DECISION_BACKEND=workers-ai`; Clef Flash is $0.09 per million input tokens, no output charge) or `DECISION_OLLAMA_KEY`. When it's on:
  - **Smart ranking**: re-ranks a page of search results, scoring each paper's relevance on its own.
  - **Question routing**: points the tutor at the right tools (paper text, related work, your notes, or none) when the judge is confident.
  - **Note tags**: tags saved notes by type (definition, method, result, math, …).
  - **Figures**: `inspect_figure` lets the tutor look at a figure's image and ask it yes/no questions.
  - **Grounding badge**: after each answer, checks its claims against the passages the tutor read and shows whether they're supported.

  Everything fails open: without a decision model, or when it errors, the app works as before.

## Architecture

```
Browser (React SPA) ──► Cloudflare Worker (Hono, /api/*) ──► D1 (users, keys, sessions, messages, knowledge + FTS5, paper cache)
                                     │
                                     ├─► arXiv API / arxiv.org (search, HTML & PDF full text)
                                     └─► lich Agent ──► OpenRouter / OpenAI / Anthropic / Ollama
```

One Worker serves the static SPA and the API (`src/worker`). Each chat message builds a lich `Agent` with these tools:

| Tool | What it does |
| --- | --- |
| `paper_outline` | Lists the section headings |
| `search_paper` | BM25 keyword search over chunks of the full text |
| `read_paper` | Reads a section by name, or a range of characters |
| `recall_knowledge` | Full-text search over the user's notes and session summaries |
| `save_knowledge` | Saves a self-contained note for future sessions |
| `search_arxiv` / `get_arxiv_paper` | Looks up related work |
| `paper_figures` | Lists figures and captions (arXiv HTML papers) |
| `inspect_figure` | Asks the decision model about a figure's image (decision-model plugin) |

The decision-model features inside the agent ship as a lich plugin (`src/worker/decision-plugin.ts`): it adds
`inspect_figure` and tags notes from an `after_tool_call` hook on `save_knowledge`. Routing runs before the agent
(it changes the system prompt) and the grounding check after it (it needs the final answer), both in `src/worker/decide.ts`.

The provider chain is the user's chosen provider and model first, then `openrouter/free`. The free router uses the
user's OpenRouter key, the Pro key, or the optional shared server key, which is a one-time trial of `FREE_TRIAL_MESSAGES`
messages per user. Provider keys are encrypted with AES-GCM using `ENCRYPTION_KEY` before they go into D1.

## Plans

| | Free | Pro ($10/month) |
| --- | --- | --- |
| Models | Your own OpenRouter account (free router, or anything your credits cover) or your own OpenAI / Anthropic / Ollama key. 10-message trial on the shared key. | "Lich Pro" hosted models, no key needed, plus everything in Free |
| Knowledge base | Up to 100 notes | Unlimited, with Markdown export |
| Build on earlier sessions | 1 at a time | Up to 5 |

How Pro limits cost:

- **Per-subscriber spending cap.** When someone subscribes, the Stripe webhook creates an OpenRouter key just for them through OpenRouter's [provisioning API](https://openrouter.ai/docs/features/provisioning-api-keys), with a `$4` limit that resets monthly. Model spend per subscriber can't exceed the cap. If a subscriber runs out, chat falls back to the free router on the same key until the reset.
- **Shorter prompts.** Chats on the Pro key or the trial use a shorter paper excerpt and fewer tool steps.
- **Usage log.** Every reply records its token counts in `usage_events`, along with whether the user, Pro or the trial paid for it.
- **Margin.** At $10 with a $4 cap and Stripe's 2.9% + 30¢, the worst case is about $5.40 per subscriber per month, and more when people don't use the full cap.

## Local development

```sh
npm install
npm run setup:local   # applies D1 migrations locally and writes .dev.vars with a fresh ENCRYPTION_KEY
npm run dev           # http://localhost:5173
```

In `.dev.vars`:

- Add `OPENROUTER_API_KEY=sk-or-...` to try the free router without connecting an account.
- `ALLOW_INSECURE_PROVIDER_URLS=1` is already set, so you can point the Ollama provider at `http://localhost:11434`.

Other commands:

```sh
npm test            # unit tests (arXiv parsing, paper search, crypto, the lich tool loop, failover)
npm run typecheck
npm run build && npm run preview   # run the production build locally in workerd
```

## Deploy to Cloudflare (auto-deploy from GitHub)

The repo is set up for [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/). After a one-time
setup, every push to `main` deploys.

1. **Connect the repo.** In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository** and pick
   this repo. The Worker name must match `name` in `wrangler.jsonc` (`lich-papers`).
2. **Set the build settings.**
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy && npx wrangler d1 migrations apply lich-papers --remote`
   - (Optional) Non-production branch deploy command: `npx wrangler versions upload`. This gives PRs preview URLs. Preview builds share the production D1 database.
3. **Add secrets.** Go to **Worker → Settings → Variables and Secrets**:
   - `ENCRYPTION_KEY` (**required**). Generate it with `openssl rand -base64 32`. Don't change it later: keys already stored become unreadable.
   - `OPENROUTER_API_KEY` (optional). A server key for the one-time trial (`FREE_TRIAL_MESSAGES`, default 10).
   - Pro (all three are needed, or the upgrade button shows "coming soon"):
     - `STRIPE_SECRET_KEY`: your Stripe secret key.
     - `STRIPE_WEBHOOK_SECRET`: from step 5.
     - `OPENROUTER_PROVISIONING_KEY`: a management key from [OpenRouter → Settings → Management keys](https://openrouter.ai/settings/management-keys). Each subscriber's spend comes out of this OpenRouter account's credits, so keep it funded.
4. **Push to `main`.** On the first deploy, wrangler creates the `lich-papers` D1 database, then the migrations create the tables.
5. **Set up Stripe (for Pro).**
   - **Webhook.** In Stripe → Developers → Webhooks, add the endpoint `https://<your-domain>/api/billing/webhook` with these events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
   - **Customer portal.** In Stripe → Settings → Billing → Customer portal, save the settings once (allow cancellation and payment-method updates). "Manage billing" won't work until you do.
   - **No product setup needed.** Checkout creates the $10/month price inline. The price, cap and default model are the `PRO_*` vars in `wrangler.jsonc`.
   - **Free Pro for yourself or staff.** Sign up, copy your Account ID from Settings, and add it to the `COMP_PRO_USER_IDS` secret (comma-separated). On your next visit the account switches to Pro, with no Stripe involved and the same monthly cap. Remove the ID to undo. This uses IDs rather than emails because emails aren't verified, so anyone could register your address first.
   - **Check the default model.** Before launch, confirm that `PRO_DEFAULT_MODEL` is a current OpenRouter model ID with the price you expect.

Deploying from your machine instead: `npx wrangler login && npm run deploy`, then `npx wrangler secret put ENCRYPTION_KEY`.

OpenRouter SSO needs no app registration. The callback is `https://<your-domain>/openrouter/callback`, and it works on `*.workers.dev` and on custom domains.

## Legal pages

The Terms, Privacy, Refunds and Copyright policies live at `/terms`, `/privacy`, `/refunds` and `/copyright`. They're written for an individual running the app as a hobby project.

- **Fill them in.** Set the plain vars `OPERATOR_NAME`, `CONTACT_EMAIL` and `GOVERNING_LAW` in the dashboard. Until `CONTACT_EMAIL` is set, the pages show "[contact email not configured]".
- **Signup records consent.** Signup requires accepting the Terms and Privacy Policy, and the account stores the date and terms version.
- **Data rights.** In Settings, users can download all their data and delete their account; deletion also cancels Stripe and removes the Pro key.
- **Get them reviewed.** These are a starting point, not legal advice. Have a lawyer review them before you rely on them.

## Notes and limits

- **arXiv content and licensing**: the app follows arXiv's [API terms](https://info.arxiv.org/help/api/tou.html) and [bulk-data guidance](https://info.arxiv.org/help/bulk_data.html).
  - **Polite access**: every automated request goes to `export.arxiv.org`, through a shared throttle of one request every 3 seconds (the `arxiv_gate` table). Search results are cached for an hour.
  - **Licenses**: each paper's license is read from arXiv's OAI-PMH endpoint and cached for 30 days.
  - **What the reader shows**: full text only for CC BY, CC BY-SA and CC0/public-domain papers, with attribution. Every other paper shows its abstract (which is CC0) and links to arXiv. PDFs always open on arXiv; the app doesn't host or serve copies.
  - **Text for the tutor**: fetched on demand and kept for at most 24 hours. A daily cron (`17 4 * * *`) clears expired text.
- **CPU time**: extracting text from a PDF (used when arXiv has no HTML version) is CPU-heavy. The Workers Free plan's 10 ms CPU limit can make it fail, so use Workers Paid for reliable PDF extraction. The HTML path and the chat itself are mostly I/O and fit the free plan.
- **Ollama**: the Ollama key option uses the [Ollama Cloud API](https://docs.ollama.com/cloud) (`https://ollama.com/api/chat`, with the user's key sent as a Bearer token), billed to the user's Ollama account. Names with a `-cloud` suffix (e.g. `gpt-oss:120b-cloud`) have the suffix removed automatically. Users can switch to their own Ollama server instead; it has to be reachable over HTTPS (e.g. through a Cloudflare Tunnel), since the app runs on Cloudflare and can't reach `localhost`. Pick a model that supports tool calling so the tutor can search the paper.
- **lich on Workers**: lich `0.9.0` reads its own `package.json` at import time, which Workers can't do. `vite.config.ts` inlines the version as a workaround. A fallback for this upstream in lich would let the workaround go.
