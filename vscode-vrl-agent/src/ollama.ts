/**
 * Client for the custom LLM server using the OpenAI SDK.
 *
 * The server is OpenAI-compatible, so we use the official `openai` npm package
 * pointed at the custom baseURL with Bearer token auth.
 *
 * Endpoints used:
 *   GET  /v1/models           — list available models
 *   POST /v1/chat/completions — chat completion
 */

import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./prompts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmModel {
  id: string;
  created: number;
  owned_by: string;
}

// ── Client ───────────────────────────────────────────────────────────────────

export class LlmClient {
  private client: OpenAI;
  private _model: string;
  private _temperature: number;
  private _maxTokens: number | null;

  constructor(
    baseUrl: string,
    apiToken: string,
    model: string,
    temperature: number = 0.1,
    maxTokens: number | null = null,
  ) {
    this._model = model;
    this._temperature = temperature;
    this._maxTokens = maxTokens;
    this.client = new OpenAI({
      baseURL: baseUrl.replace(/\/$/, "").replace(/\/v1$/, "") + "/v1",
      apiKey: apiToken || "no-key",
    });
  }

  get currentModel(): string {
    return this._model;
  }

  updateConfig(opts: {
    baseUrl?: string;
    apiToken?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number | null;
  }): void {
    if (opts.model !== undefined) { this._model = opts.model; }
    if (opts.temperature !== undefined) { this._temperature = opts.temperature; }
    if (opts.maxTokens !== undefined) { this._maxTokens = opts.maxTokens; }

    // Recreate client if connection params changed
    if (opts.baseUrl !== undefined || opts.apiToken !== undefined) {
      const baseUrl = opts.baseUrl ?? this.client.baseURL;
      const apiKey = opts.apiToken ?? this.client.apiKey;
      this.client = new OpenAI({
        baseURL: typeof baseUrl === "string" ? baseUrl.replace(/\/$/, "").replace(/\/v1$/, "") + "/v1" : baseUrl,
        apiKey: apiKey || "no-key",
      });
    }
  }

  // ── Chat Completion ────────────────────────────────────────

  /**
   * Send a chat completion request.
   * Automatically prepends the VRL system prompt.
   */
  async chat(
    userMessage: string,
    history: ChatMessage[] = [],
    signal?: AbortSignal,
  ): Promise<string> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: userMessage },
    ];

    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: this._model,
      messages,
      stream: false,
      temperature: this._temperature,
    };
    if (this._maxTokens !== null) {
      params.max_tokens = this._maxTokens;
    }

    const completion = await this.client.chat.completions.create(params, {
      signal: signal ?? undefined,
    });

    if (!completion.choices || completion.choices.length === 0) {
      throw new Error("LLM returned no choices.");
    }

    return completion.choices[0].message.content ?? "";
  }

  // ── Model listing ──────────────────────────────────────────

  /**
   * Fetch available models from GET /v1/models.
   */
  async listModels(signal?: AbortSignal): Promise<LlmModel[]> {
    const response = await this.client.models.list({ signal: signal ?? undefined } as never);

    const models: LlmModel[] = [];
    for await (const model of response) {
      models.push({
        id: model.id,
        created: model.created,
        owned_by: model.owned_by,
      });
    }
    return models;
  }

  // ── Health check ───────────────────────────────────────────

  /**
   * Check server reachability and model availability.
   */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const models = await this.listModels(AbortSignal.timeout(10000));
      const hasModel = models.some(m => m.id === this._model);
      if (!hasModel) {
        const available = models.map(m => m.id).join(", ") || "(none)";
        return {
          ok: false,
          error: `Model "${this._model}" not found. Available: ${available}`,
        };
      }
      return { ok: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }
}
