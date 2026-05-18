import { Injectable, Logger } from "@nestjs/common";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

/**
 * Four LLM tiers, each backed by an OpenAI-compatible endpoint.
 *  - supervisor: high intelligence (router)
 *  - writer:     medium/high (lesson generation, search synthesis)
 *  - critic:     medium (pedagogical evaluation of writer drafts)
 *  - utility:    fast/cheap (picker, classifications)
 *
 * Supervisor / writer / utility are required at boot. The critic tier is
 * optional: if `CRITIC_LLM_*` is not provided the critic falls back to the
 * utility tier (audit §2.4 — critic is structurally a classification task).
 * Configuring CRITIC_LLM_* explicitly (audit §6.1) lets ops route the critic
 * to a medium-tier model without dragging the picker / language detector
 * with it.
 */
export type LlmTier = "supervisor" | "writer" | "critic" | "utility";

interface TierConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const Schema = z.object({
  SUPERVISOR_LLM_API_KEY: z.string().min(1),
  SUPERVISOR_LLM_BASE_URL: z.string().url(),
  SUPERVISOR_LLM_MODEL: z.string().min(1),

  WRITER_LLM_API_KEY: z.string().min(1),
  WRITER_LLM_BASE_URL: z.string().url(),
  WRITER_LLM_MODEL: z.string().min(1),

  UTILITY_LLM_API_KEY: z.string().min(1),
  UTILITY_LLM_BASE_URL: z.string().url(),
  UTILITY_LLM_MODEL: z.string().min(1),

  CRITIC_LLM_API_KEY: z.string().min(1).optional(),
  CRITIC_LLM_BASE_URL: z.string().url().optional(),
  CRITIC_LLM_MODEL: z.string().min(1).optional(),
});

/**
 * Some OpenAI-compatible endpoints (xAI Grok, parts of Together,
 * a few NVIDIA models) reject unknown OpenAI parameters with 400.
 * The official `openai` SDK normalizes undefined into defaults
 * (presence_penalty=0, frequency_penalty=0, top_p=1, n=1) which then
 * get sent on the wire. We strip them here unconditionally — they
 * are no-ops for our use case but trip strict validators.
 */
const UNSUPPORTED_KEYS = [
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "user",
];

function stripContentLength(headers: HeadersInit | undefined): HeadersInit {
  if (!headers) return {};
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((v, k) => {
      if (k.toLowerCase() !== "content-length") out[k] = v;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) {
      if (k.toLowerCase() !== "content-length") out[k] = v;
    }
    return out;
  }
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() !== "content-length") out[k] = v;
  }
  return out;
}

function makeStrippingFetch(): typeof fetch {
  return async (input, init) => {
    if (init?.body && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        let mutated = false;
        for (const k of UNSUPPORTED_KEYS) {
          if (k in parsed) {
            delete parsed[k];
            mutated = true;
          }
        }
        if (mutated) {
          // Body length changed: drop Content-Length so undici recomputes,
          // otherwise the request hangs waiting for the original byte count.
          init = {
            ...init,
            body: JSON.stringify(parsed),
            headers: stripContentLength(init.headers),
          };
        }
      } catch {
        // Non-JSON body — leave alone.
      }
    }
    // The openai SDK injects a node-fetch `agent` field; Node's built-in
    // fetch (undici) does not understand it.
    if (init && "agent" in init) {
      const stripped = init as Record<string, unknown>;
      delete stripped.agent;
    }
    return fetch(input as RequestInfo, init);
  };
}

@Injectable()
export class LlmConfigService {
  private readonly logger = new Logger(LlmConfigService.name);
  private readonly tiers: Record<LlmTier, TierConfig>;

  constructor() {
    const parsed = Schema.safeParse(process.env);
    if (!parsed.success) {
      this.logger.error(
        "Invalid LLM tier configuration:\n" +
          parsed.error.issues
            .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
            .join("\n"),
      );
      throw new Error("Invalid LLM tier configuration");
    }
    const env = parsed.data;
    const utility = {
      apiKey: env.UTILITY_LLM_API_KEY,
      baseUrl: env.UTILITY_LLM_BASE_URL,
      model: env.UTILITY_LLM_MODEL,
    };
    const criticConfigured =
      env.CRITIC_LLM_API_KEY &&
      env.CRITIC_LLM_BASE_URL &&
      env.CRITIC_LLM_MODEL;
    this.tiers = {
      supervisor: {
        apiKey: env.SUPERVISOR_LLM_API_KEY,
        baseUrl: env.SUPERVISOR_LLM_BASE_URL,
        model: env.SUPERVISOR_LLM_MODEL,
      },
      writer: {
        apiKey: env.WRITER_LLM_API_KEY,
        baseUrl: env.WRITER_LLM_BASE_URL,
        model: env.WRITER_LLM_MODEL,
      },
      critic: criticConfigured
        ? {
            apiKey: env.CRITIC_LLM_API_KEY!,
            baseUrl: env.CRITIC_LLM_BASE_URL!,
            model: env.CRITIC_LLM_MODEL!,
          }
        : utility,
      utility,
    };
    for (const tier of Object.keys(this.tiers) as LlmTier[]) {
      const t = this.tiers[tier];
      const suffix =
        tier === "critic" && !criticConfigured
          ? " (fallback → utility — set CRITIC_LLM_* to override)"
          : "";
      this.logger.log(`Tier ${tier}: ${t.model} @ ${t.baseUrl}${suffix}`);
    }
  }

  /**
   * Returns the raw tier configuration (apiKey/baseUrl/model triple)
   * without binding it to a `@langchain/core@0.3` ChatOpenAI instance.
   * Used by `@mpfe/deep-agent`, which lives on `@langchain/core@1.x`
   * and constructs its own `ChatOpenAI` internally so the v0.x and v1.x
   * langchain families never share an object.
   */
  rawConfig(tier: LlmTier): { apiKey: string; baseUrl: string; model: string } {
    const t = this.tiers[tier];
    return { apiKey: t.apiKey, baseUrl: t.baseUrl, model: t.model };
  }

  /** Returns a fresh ChatOpenAI configured for the given tier. */
  get(tier: LlmTier, overrides: { temperature?: number } = {}): ChatOpenAI {
    const t = this.tiers[tier];
    return new ChatOpenAI({
      apiKey: t.apiKey,
      model: t.model,
      temperature: overrides.temperature ?? 0.3,
      modelKwargs: { reasoning_effort: "high" },
      configuration: {
        baseURL: t.baseUrl,
        fetch: makeStrippingFetch(),
      },
    });
  }
}
