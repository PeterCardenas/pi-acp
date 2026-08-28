import { RequestError } from '@agentclientprotocol/sdk'
import { getAuthMethods } from './auth.js'

/**
 * Best-effort detection of authentication errors from pi/providers.
 *
 * We can't do a full provider-specific check here, so we look for bounded, explicit evidence.
 */
export function maybeAuthRequiredError(err: unknown): RequestError | null {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '')
  const s = msg.toLowerCase()
  const authEvidence =
    /\b(?:missing|no|invalid|expired|rejected|required|not\s+configured)\s+(?:api[\s_-]?key|apikey|key)\b|\b(?:api[\s_-]?key|apikey)\s+(?:is\s+)?(?:missing|invalid|expired|rejected|required|not\s+configured)\b|\bunauthorized\b|\bauthentication\s+(?:required|failed|error)\b|\b(?:http(?:\s+status)?|status|error|request\s+failed\s+with)\s*[:=]?\s*401\b/.test(
      s
    )

  if (!authEvidence) return null

  // Include terminal auth method options in error data.
  return RequestError.authRequired(
    {
      authMethods: getAuthMethods()
    },
    'Configure an API key or log in with an OAuth provider.'
  )
}
