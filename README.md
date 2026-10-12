# ⚱ Lich Papers

Search and read any paper on [arXiv](https://arxiv.org), and chat with an AI tutor about it. The tutor runs on the
[`@moikapy/lich`](https://www.npmjs.com/package/@moikapy/lich) agent harness, with tools for reading the paper's
full text and for remembering what you've learned across sessions.

- **Search all of arXiv**: free text, field queries (`au:hinton`, `ti:"diffusion"`), category filters, or paste an arXiv id/URL.
- **Read**: the PDF embedded in the page, or extracted full text (from arXiv's HTML rendering, falling back to the PDF). Select text and click "Ask about selection".
- **Chat with the paper**: the tutor grounds its answers in the paper. It searches and reads sections as needed and shows each step it took.
- **Accounts and history**: sign up with email and password. Every conversation is saved, and you can reopen any of them from History.
- **Cross-session knowledge**: the tutor saves notes to your knowledge base, and you can summarize a session into it. New sessions can **build on** earlier ones, and every chat can search your notes.
- **Models**:
  - **Default**: OpenRouter's free router (`openrouter/free`). Users connect their OpenRouter account in one click with [OpenRouter SSO (OAuth PKCE)](https://openrouter.ai/docs/guides/overview/auth/oauth).
  - **Paid OpenRouter models**: users who have credits on OpenRouter can pick any of its models.
  - **BYOK**: users can add keys for **OpenAI**, **Anthropic**, and **Ollama** (Ollama Cloud, or their own server over HTTPS).
  - **Fallback**: if the chosen model fails, lich fails over to the free router automatically.

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

## Notes and limits

- **arXiv**: search results are cached for an hour, and extracted paper text is cached in D1 (capped at 500k characters). Please respect arXiv's [API terms](https://info.arxiv.org/help/api/tou.html).
- **CPU time**: extracting text from a PDF (used when arXiv has no HTML version) is CPU-heavy. The Workers Free plan's 10 ms CPU limit can make it fail, so use Workers Paid for reliable PDF extraction. The HTML path and the chat itself are mostly I/O and fit the free plan.
- **Ollama**: the app runs on Cloudflare, so it can't reach `localhost`. Use [Ollama Cloud](https://ollama.com) (`https://ollama.com` plus an API key) or expose your server over HTTPS, for example with a Cloudflare Tunnel.
- **lich on Workers**: lich `0.9.0` reads its own `package.json` at import time, which Workers can't do. `vite.config.ts` inlines the version as a workaround. A fallback for this upstream in lich would let the workaround go.
