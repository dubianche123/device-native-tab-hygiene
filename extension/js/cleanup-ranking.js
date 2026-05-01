const DEFAULT_CATEGORY_PRIORITY = 50;
export const PROACTIVE_CLEANUP_POLICY = Object.freeze({
  scoreThreshold: 14,
  normalizedImportanceThreshold: 0.5,
  minBackgroundAgeMs: 30 * 60 * 1000,
  maxCount: 3,
});

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

export function shouldProactivelyCleanTab({
  score = Number.POSITIVE_INFINITY,
  normalizedImportance = 1,
  backgroundAgeMs = 0,
  stale = false,
} = {}, policy = {}) {
  const thresholds = {
    ...PROACTIVE_CLEANUP_POLICY,
    ...(policy || {}),
  };
  const safeScore = Number(score);
  const safeImportance = clamp(Number(normalizedImportance) || 0, 0, 1);
  const safeBackgroundAgeMs = Math.max(0, Number(backgroundAgeMs) || 0);

  let reason = 'score_too_high';
  let eligible = false;

  if (stale) {
    reason = 'already_stale';
  } else if (!Number.isFinite(safeScore)) {
    reason = 'invalid_score';
  } else if (safeScore > thresholds.scoreThreshold) {
    reason = 'score_too_high';
  } else if (safeImportance > thresholds.normalizedImportanceThreshold) {
    reason = 'importance_too_high';
  } else if (safeBackgroundAgeMs < thresholds.minBackgroundAgeMs) {
    reason = 'background_too_recent';
  } else {
    reason = 'proactive_low_value';
    eligible = true;
  }

  return {
    eligible,
    reason,
    scoreThreshold: thresholds.scoreThreshold,
    normalizedImportanceThreshold: thresholds.normalizedImportanceThreshold,
    minBackgroundAgeMs: thresholds.minBackgroundAgeMs,
    maxCount: thresholds.maxCount,
  };
}
