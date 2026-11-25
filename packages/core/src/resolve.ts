import type { ModelId, Policy, PolicyRule, PolicyVariant } from "./contracts.js";
import { wildcardFor } from "./models.js";

export interface ResolvedRule {
  rule: PolicyRule;
  variant: PolicyVariant;
  matchedBy: "exact" | "wildcard" | "default";
}

/**
 * Client-side policy resolution used by every runtime SDK:
 * exact modelId → platform wildcard (`android:*`) → default.
 * If a rule references a variant missing from the policy (corrupt publish), fall back to the
 * default rule rather than crash — a broken config must degrade to cloud, never to an error.
 */
export function resolveRule(policy: Policy, modelId: ModelId): ResolvedRule {
  const candidates: Array<[PolicyRule | undefined, ResolvedRule["matchedBy"]]> = [
    [policy.rules[modelId], "exact"],
    [policy.rules[wildcardFor(modelId)], "wildcard"],
  ];
  for (const [rule, matchedBy] of candidates) {
    if (!rule) continue;
    const variant = policy.variants[rule.variantId];
    if (variant) return { rule, variant, matchedBy };
  }
  const variant = policy.variants[policy.default.variantId];
  if (!variant)
    throw new Error(`policy ${policy.featureId}@${policy.version} has no default variant`);
  return { rule: policy.default, variant, matchedBy: "default" };
}
