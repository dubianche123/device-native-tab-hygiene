const DEFAULT_CATEGORY_PRIORITY = 50;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function positiveLog2(value) {
  return Math.log2(Math.max(0, Number(value) || 0) + 1);
}

export function computeCleanupScore({
  categoryPriority = DEFAULT_CATEGORY_PRIORITY,
  interactions = 0,
  normalizedImportance = 0,
  backgroundAgeMs = 0,
  effectiveClosureTimeMs = 1,
  defaultThresholdMs = 1,
  learnedThresholdMs = null,
  blacklist = false,
  earlyCloseEligible = false,
  nsfw = false,
} = {}) {
  if (nsfw) {
    return {
      score: -1000,
      urgency: Infinity,
      learnedShortness: 1,
      categoryBias: 0,
      interactionBias: 0,
      engagementBias: 0,
      urgencyBoost: 0,
      blacklistBoost: 0,
      earlyCloseBoost: 0,
    };
  }

  const safePriority = clamp(Number(categoryPriority) || DEFAULT_CATEGORY_PRIORITY, 0, 100);
  const safeInteractions = Math.max(0, Number(interactions) || 0);
  const safeImportance = clamp(Number(normalizedImportance) || 0, 0, 1);
  const safeBackgroundAgeMs = Math.max(0, Number(backgroundAgeMs) || 0);
  const safeEffectiveClosureTimeMs = Math.max(1, Number(effectiveClosureTimeMs) || 1);
  const safeDefaultThresholdMs = Math.max(1, Number(defaultThresholdMs) || 1);
  const safeLearnedThresholdMs = Number(learnedThresholdMs) > 0 ? Number(learnedThresholdMs) : null;

  const urgency = safeBackgroundAgeMs / safeEffectiveClosureTimeMs;
  const learnedShortness = safeLearnedThresholdMs != null
    ? clamp(1 - (safeLearnedThresholdMs / safeDefaultThresholdMs), 0, 1)
    : 0;
  const categoryBias = safePriority * 0.15;
  const interactionBias = positiveLog2(safeInteractions) * 8;
  const engagementBias = safeImportance * 14;
  const urgencyBoost = Math.min(90, urgency * 80);
  const blacklistBoost = blacklist ? -20 : 0;
  const earlyCloseBoost = earlyCloseEligible ? 16 : 0;

  return {
    score: categoryBias + interactionBias + engagementBias - urgencyBoost - (learnedShortness * 24) + blacklistBoost - earlyCloseBoost,
    urgency,
    learnedShortness,
    categoryBias,
    interactionBias,
    engagementBias,
    urgencyBoost,
    blacklistBoost,
    earlyCloseBoost,
  };
}
