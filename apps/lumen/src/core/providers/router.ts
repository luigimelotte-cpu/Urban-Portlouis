import { CONTENT_MODES, type ContentMode } from "../types";
import { modeRank, supportsMode } from "../content/policy";
import type { ModelProvider } from "./types";

/** Anything the router can choose between: chat, utility and image providers. */
export type Routable = Pick<ModelProvider, "descriptor" | "getCapabilities" | "isAvailable">;

export type RoutingFallback = "downgrade" | "refuse";

export interface RouteRequest<T extends Routable = ModelProvider> {
  mode: ContentMode;
  role: "chat" | "utility" | "image";
  providers: T[];
  preferredProviderId?: string | null;
  fallback?: RoutingFallback;
}

export interface RouteDecision<T extends Routable = ModelProvider> {
  /** Ordered list: first is used, the rest are failover candidates (same mode). */
  candidates: T[];
  mode: ContentMode;
  downgradedFrom?: ContentMode;
}

export class NoCompatibleProviderError extends Error {
  constructor(readonly mode: ContentMode, readonly role: string) {
    super(`No enabled ${role} provider is configured for content mode ${mode}.`);
    this.name = "NoCompatibleProviderError";
  }
}

/**
 * SafetyRouter — picks only providers whose declared capabilities cover the
 * requested ConversationMode. It never sends a mode to a provider that hasn't
 * been declared to permit it; when nothing matches it either lowers the mode
 * (and reports it) or refuses. It does not alter prompts to get around a
 * provider's rules.
 */
export function routeProvider<T extends Routable = ModelProvider>(req: RouteRequest<T>): RouteDecision<T> {
  const usable = req.providers
    .filter((p) => p.descriptor.enabled && p.descriptor.roles.includes(req.role) && p.isAvailable())
    .sort((a, b) => {
      const pa = a.descriptor.id === req.preferredProviderId ? -1 : 0;
      const pb = b.descriptor.id === req.preferredProviderId ? -1 : 0;
      return pa - pb || a.descriptor.priority - b.descriptor.priority;
    });

  const forMode = (mode: ContentMode) => usable.filter((p) => supportsMode(p.getCapabilities(), mode));

  const exact = forMode(req.mode);
  if (exact.length) return { candidates: exact, mode: req.mode };

  if ((req.fallback ?? "downgrade") === "downgrade") {
    for (let r = modeRank(req.mode) - 1; r >= 0; r--) {
      const mode = CONTENT_MODES[r];
      const c = forMode(mode);
      if (c.length) return { candidates: c, mode, downgradedFrom: req.mode };
    }
  }
  throw new NoCompatibleProviderError(req.mode, req.role);
}
