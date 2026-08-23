/**
 * Azure OpenAI transport.
 *
 * Azure differs from OpenAI in routing rather than in payload shape:
 *   - the model is a *deployment name* embedded in the path, not a body field
 *   - the API version is a mandatory query parameter
 *   - authentication uses the `api-key` header, or a bearer token when using
 *     Entra ID / managed identity
 *   - newer deployments expose the Responses API at a different path
 *
 * The base URL may be given either as a bare resource host
 * (`https://my-resource.openai.azure.com`) or as a full deployment URL; both are
 * handled so users can paste whatever the portal shows them.
 */

import type { LlmRequest, Transport, TransportContext } from "../../llm/types.js"
import { framed, joinUrl } from "../transport.js"
import { streamOpenAiChat } from "./openai-chat.js"
import { OpenAIResponsesTransport } from "./openai-responses.js"

const DEFAULT_API_VERSION = "2025-04-01-preview"

function apiVersion(context: TransportContext): string {
  const configured = context.options["apiVersion"]
  if (typeof configured === "string" && configured !== "") return configured
  const env = process.env["AZURE_OPENAI_API_VERSION"]
  if (env && env !== "") return env
  return DEFAULT_API_VERSION
}

/** Resolves the deployment name, which defaults to the model id. */
function deployment(context: TransportContext, modelId: string): string {
  const configured = context.options["deployment"]
  if (typeof configured === "string" && configured !== "") return configured
  const map = context.options["deployments"]
  if (map && typeof map === "object") {
    const value = (map as Record<string, unknown>)[modelId]
    if (typeof value === "string" && value !== "") return value
  }
  // Azure deployment names cannot contain dots.
  return modelId.replace(/\./g, "")
}

function resourceBase(context: TransportContext): string {
  const base = context.baseUrl
  if (base !== "") {
    // Trim anything from /openai onwards so we can rebuild the path cleanly.
    const index = base.indexOf("/openai")
    return index > 0 ? base.slice(0, index) : base
  }
  const resource = context.options["resource"] ?? process.env["AZURE_OPENAI_RESOURCE"]
  if (typeof resource === "string" && resource !== "") {
    return `https://${resource}.openai.azure.com`
  }
  const endpoint = process.env["AZURE_OPENAI_ENDPOINT"]
  if (endpoint && endpoint !== "") return endpoint.replace(/\/+$/, "")
  return ""
}

function chatUrl(context: TransportContext, modelId: string): string {
  const base = resourceBase(context)
  return joinUrl(base, `/openai/deployments/${deployment(context, modelId)}/chat/completions`)
}

function responsesUrl(context: TransportContext): string {
  const base = resourceBase(context)
  return joinUrl(base, "/openai/responses")
}

/** Azure uses `api-key` unless a bearer token was supplied by Entra ID. */
function azureContext(context: TransportContext): TransportContext {
  const bearer = context.options["useBearer"] === true
  const headers: Record<string, string> = { ...context.headers }
  if (context.apiKey && !bearer) headers["api-key"] = context.apiKey
  return {
    ...context,
    headers,
    query: { ...context.query, "api-version": apiVersion(context) },
    // Suppress the default bearer header injection when using api-key.
    apiKey: bearer ? context.apiKey : undefined,
  }
}

export const AzureOpenAITransport: Transport = {
  id: "azure-openai",
  stream(request: LlmRequest, context: TransportContext) {
    const prepared = azureContext(context)
    // Reasoning deployments need the Responses API for encrypted reasoning.
    if (context.capabilities.reasoning && context.options["useResponses"] !== false) {
      const responsesContext: TransportContext = {
        ...prepared,
        baseUrl: responsesUrl(context).replace(/\/responses$/, ""),
      }
      return OpenAIResponsesTransport.stream(request, responsesContext)
    }
    return framed(request, () =>
      streamOpenAiChat(request, prepared, chatUrl(context, request.modelId)),
    )
  },
  async listModels(context) {
    const { getJson } = await import("../../util/http.js")
    const base = resourceBase(context)
    if (base === "") return []
    const response = await getJson<{ data?: Array<{ id?: string }> }>(
      joinUrl(base, "/openai/models"),
      {
        headers: context.apiKey ? { "api-key": context.apiKey } : {},
        query: { "api-version": apiVersion(context) },
        timeoutMs: 10_000,
      },
    )
    return (response.data?.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string")
      .sort()
  },
}
