# Lumen — AI character chat (18+)

Immersive conversations with characters who remember you, change mood and
build a relationship with you over time. Adults only. Provider-agnostic: no
part of the app is written around a single model vendor.

```
Next.js 16 (App Router) · TypeScript · PostgreSQL + pgvector · Prisma 6 · Tailwind 4 · SSE streaming · Vitest
```

---

## Quick start

```bash
cd apps/lumen
cp .env.example .env              # edit SESSION_SECRET and ADMIN_TOKEN
docker compose up -d              # PostgreSQL 16 + pgvector (or use your own)
npm install                       # also runs `prisma generate`
npm run db:migrate                # schema + CHECK constraints + HNSW index
npm run db:seed                   # 6 demo characters
npm run dev                       # http://localhost:3000
```

With no API key set, the built-in **Mock** provider answers with template
text, so you can run the whole flow offline: age gate, chat, streaming,
memories, relationship and admin. Add `ANTHROPIC_API_KEY`, or any
OpenAI-compatible key, then restart, and a provider row is created
automatically. You can also add providers by hand in `/admin`.

```bash
npm test           # 81 unit + pipeline tests (no DB needed)
npm run typecheck
npm run build && npm start
```

---

## Architecture

```
src/
  core/                    framework-free domain — no Next.js, no Prisma
    types.ts               ContentMode, ConversationStyle, emotions, relationship vars
    character/
      profile.ts           CharacterProfile (zod) + trait → behaviour directives
      planner.ts           per-turn plan: length, bubbles, initiative, question, tease
      structure.ts         "describe in your own words" → structured profile (LLM or heuristic)
    content/policy.ts      ModelCapabilities, ContentPolicy, ConversationMode resolution, hard limits
    providers/
      types.ts             ModelProvider interface
      base.ts              shared estimateTokens / moderateInput / moderateOutput
      router.ts            SafetyRouter — capability-gated routing, downgrade/refuse, failover order
      registry.ts          adapter registry (one line per vendor)
      adapters/            anthropic.ts · openai-compatible.ts · mock.ts
    intent/detect.ts       fast EN/FR intent + sentiment + third-party detection
    emotion/engine.ts      10-dim emotion vector, personality baseline, inertia, decay
    relationship/engine.ts 7 independent vars, derived non-linear stage, milestones, hysteresis
    memory/
      engine.ts            scoring, diversity ranking, consolidation/dedup, forgetting
      extractor.ts         heuristic + LLM memory extraction
      embeddings.ts        Embedder interface: OpenAI-compatible or offline hashing
    prompt/
      modules.ts           CORE_CHARACTER · PERSONALITY · CONTENT_MODE · CONVERSATION_STYLE ·
                           CURRENT_SCENARIO · RELATIONSHIP · CURRENT_EMOTION · RELEVANT_MEMORIES ·
                           CONVERSATION_SUMMARY · TURN_DIRECTION
      builder.ts           token-budgeted assembly: compact → drop by priority → trim history
    style/postprocess.ts   strips "As an AI…" tells, speaker prefixes; splits bubbles
    pipeline/
      ports.ts             ChatStore / MemoryStore / ProviderSource / PlatformSettings
      chat-pipeline.ts     the 14-step turn (below)
  server/                  adapters for the ports: Prisma, pgvector SQL, sessions, provider config
  app/                     Next.js pages + API routes
  components/              UI
prisma/                    schema, migration (with hand-written CHECKs + HNSW index), seed
tests/                     vitest — engines, router, policy, prompt, full pipeline on in-memory ports
```

### One conversation turn (`ChatPipeline.run`)

| # | Step | Where |
|---|------|-------|
| 1 | Receive the message: hard-limit check, then save it with a **state snapshot** so regenerate/edit can roll back | `prepareTurn` |
| 2 | Detect intent, sentiment, third parties and time away | `intent/detect.ts` |
| 3 | Retrieve memories: pgvector kNN + core facts → re-rank (similarity · importance · recency · reinforcement) → pick a diverse top 8 | `recall` |
| 4 | Load and update the relationship (deltas capped at ±8 per turn) | `relationship/engine.ts` |
| 5 | Load and update the emotion vector (inertia, relaxes toward the personality baseline) | `emotion/engine.ts` |
| 6 | Load the character | store |
| 7 | Resolve the ConversationMode: min(request, opt-in, character cap, platform cap) | `content/policy.ts` |
| 8 | SafetyRouter picks a provider whose declared capabilities cover the mode | `providers/router.ts` |
| 9 | Build the context from modules within the provider's token budget, plus the last 24 messages and a rolling summary (never the full log) | `prompt/*` |
| 10 | Stream the reply; fail over to the next compatible provider only on transient errors | |
| 11 | Extract memories (heuristics, plus a utility LLM when one is permitted for this mode), then consolidate and dedupe | `extractAndStoreMemories` |
| 12–13 | Save emotion and relationship; stage changes and milestones become episodic memories | |
| 14 | Save. Every N turns, summarise old messages and forget weak memories | `maybeSummarize`, `forget` |

Events stream to the client as SSE: `meta → delta* → message → state`.

### Content modes and routing

| Mode | Needs capabilities | Who can use it |
|------|-------------------|----------------|
| SAFE | `romance` | every verified user |
| MATURE | + `mature_language`, `suggestive_content` | verified users |
| ADULT | + `adult_content` | verified users with an **explicit opt-in** |

- **Capabilities are declared per provider in `/admin`, by the operator,** to
  match that provider's own usage policy. Defaults are conservative: nothing
  ships with `adult_content` enabled.
- The router **only** selects providers whose capabilities cover the mode.
  When none does, it lowers the mode and tells the user, or refuses
  (configurable). It never rewrites prompts to get around a provider's rules.
- When a provider declines a reply (`stop_reason: refusal`), the app shows an
  in-character deflection. It does **not** retry the same content on another
  provider.
- Utility calls (memory extraction, summaries) see the same content, so they
  must also be routed to a provider compatible with the conversation's mode.
  If none is, the app falls back to heuristics.
- **Hard limits** apply in every mode and with every provider: no minors in any
  romantic or sexual context, no non-consent, no incest, no bestiality, no
  sexual content involving real people. They are enforced three ways: input
  checks before any model call, output checks, and the prompt itself.
- **Every character is 18 or older.** This is enforced by zod, by the API, and
  by a SQL `CHECK` constraint. Youth-coded descriptions ("looks like a child",
  high-school settings…) are rejected at creation, whatever age is stated.

### Personality that actually changes replies

The six trait sliders (initiative, jealousy, affection, confidence,
playfulness, romance) affect every reply in four ways:

1. **Prompt directives.** Each trait is graded low/mid/high and compiled into
   a behaviour line (`compileTraitDirectives`).
2. **Turn plan.** A seeded planner uses the traits to decide, each turn,
   whether the character takes initiative or pursues one of its goals, asks a
   question, teases, calls back a memory, how long the reply is, and how many
   separate texts it sends.
3. **Emotion.** The traits set the emotional baseline and how strongly events
   move it. Jealousy, for example, scales with the jealousy trait and with
   attraction.
4. **Relationship.** The romance trait affects how fast attraction grows and
   when the character is ready to say yes to a date.

### Images: portraits and photos in chat

- **Portraits.** The creator generates a portrait from the character's
  *appearance* text, in one of three styles (photo, cinematic, illustration).
  The appearance text is the character's **visual identity**: it is reused for
  every later picture, together with a fixed seed per character, so the face
  and look stay consistent. Names are never sent to the image model.
- **Photos in the conversation.** Tap 📷, or just ask ("send me a pic",
  "envoie-moi une photo"). The relationship engine decides whether the
  character is willing; too early and they tease or decline in character.
  With high initiative, a character will sometimes send a photo on their own,
  at most once every 8 replies. The chat model "sends" a photo by writing
  `[photo: …]`. The pipeline removes that line from the text, then checks and
  generates the image, and streams it into the chat. The reply arrives first
  and the photo shows as "developing…" until it is ready.
- **Same safety model as text.** Image providers declare capabilities and are
  routed by content mode. Every prompt carries an explicit adult anchor and a
  negative prompt against childlike features, and gets a final check before
  generation: hard limits, youth-coded words, and no nudity below ADULT. A
  refusal from the image model is final: it is never retried on another
  provider. Each user has a daily limit (`IMAGE_DAILY_LIMIT`).
- **Privacy.** Photos sent in a chat are private to that user. They are served
  only to their owner by `/api/images/:id` (404 for anyone else) and are
  listed in the chat's memory panel under *Photos*. A portrait is visible to
  others only once a non-private character uses it. Regenerating or deleting
  a message also deletes its photos.

### Data separation

- **Public:** `Character` holds only the definition.
- **Private:** everything keyed by `userId` (conversations, messages,
  memories, relationship, emotion). No public route ever reads it.
- Relationship, emotion and memory are scoped per **(user, character)**, so a
  new conversation keeps the bond. You can delete or reset each one
  separately:
  - delete one conversation
  - delete one memory
  - erase all memories with a character
  - reset a relationship
  - export one conversation (txt/json)
  - export all your data
  - delete your account

---

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | yes | PostgreSQL with the `vector` extension available |
| `SESSION_SECRET` | yes (prod) | HMAC key for session cookies, 16+ chars |
| `ADMIN_TOKEN` | yes (prod) | Unlocks `/admin`. If unset, admin is open in dev only |
| `ANTHROPIC_API_KEY` | no | Auto-creates a Claude Opus 5.5 provider |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | no | Auto-creates an OpenAI provider (with the moderation endpoint on) |
| `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_MODEL`, `OPENAI_COMPAT_API_KEY` | no | Any OpenAI-compatible server (OpenRouter, Together, Groq, vLLM, Ollama, LM Studio…) |
| `EMBEDDING_PROVIDER` | no | `local` (offline hashing, default) or `openai` |
| `EMBEDDING_MODEL`, `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY` | no | For `openai` embeddings (default `text-embedding-3-small`) |
| `EMBEDDING_DIM` | no | Must match `vector(768)` in the migration |
| `OPENAI_IMAGE_MODEL` | no | Image model for the auto-created OpenAI image provider (default `gpt-image-1`) |
| `IMAGE_API_BASE_URL`, `IMAGE_MODEL`, `IMAGE_API_KEY` | no | Any other image server with the OpenAI Images API shape |
| `IMAGE_DAILY_LIMIT` | no | Images per user per 24h (default 40) |
| `CONTENT_MODE_CEILING` | no | Platform-wide ceiling: `SAFE` / `MATURE` / `ADULT` (default `MATURE`) |

API keys never go in the database. A provider row stores only the **name** of
the environment variable that holds its key.

## Supported providers

| Adapter | Covers | Notes |
|---------|--------|-------|
| `anthropic` | Claude (default `claude-opus-5-5`) | Official SDK, streaming, `output_config.effort`, server-side refusal fallback on supported models, `refusal` handled |
| `openai-compatible` | OpenAI, OpenRouter, Together, Groq, Mistral, DeepInfra, vLLM, Ollama, LM Studio… | Plain fetch + SSE, optional `/moderations`, `noAuth` for local servers, custom headers |
| `mock` | Offline development | Template replies; never produces explicit content |
| `openai-images` | OpenAI Images (`gpt-image-1`), Together, DeepInfra, self-hosted Flux/SDXL gateways | `size` or `width/height`, optional seed and negative prompt |
| `mock-images` | Offline development | Draws an SVG placeholder |

To add a vendor: write one file in `core/providers/adapters/` that extends
`BaseProvider`, then add one line in `registry.ts`.

---

## What's left before production

**Trust & safety**
- A real age-assurance provider instead of a self-declared date of birth
  (required by law in several jurisdictions).
- An ML moderation layer (vendor endpoint or classifier) on top of the regex
  hard limits, plus human review queues and user reporting.
- A legal review of each provider's usage policy before raising its
  capability flags; logging of routing decisions for audit.

**Accounts & infrastructure**
- Real authentication (email/OAuth/passkeys) to replace anonymous cookie
  sessions, with account linking across devices.
- Rate limiting, abuse protection, per-user quotas and billing.
- Background jobs (queue) for memory extraction, summarisation and
  forgetting, instead of running them inline at the end of the request.
- Image storage in object storage or a CDN (currently bytes in Postgres,
  served by id, so only the storage layer has to change).
- Reference-image conditioning (image-to-image / IP-Adapter / LoRA per
  character) for stronger face consistency than text plus seed.
- An image moderation classifier on generated pictures, on top of the prompt
  checks and the provider's own safety system.
- Observability: token and cost tracking per provider, latency, error rates.
- Prompt caching for providers that support it (the stable modules are
  already first in the system prompt).

**Product**
- Production embeddings: switch to `EMBEDDING_PROVIDER=openai` or a local
  embedding model. The hashing embedder captures word overlap, not meaning.
- A periodic LLM consolidation pass that merges related episodes into richer
  long-term memories.
- Multiple characters per conversation: messages already carry
  `characterId`, so this needs a participants table plus turn-taking in the
  pipeline.
- Voice (STT → pipeline → TTS, streaming per bubble), image generation for
  avatars and scenes, a native mobile client. The core has no framework
  dependency, so it can be reused for these.
- A marketplace: moderation of public characters, reporting, ratings,
  creator profiles.
- An evaluation suite for character consistency and "assistant-ness" across
  real models.
