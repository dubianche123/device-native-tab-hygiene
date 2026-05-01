export const DEPLOYMENT_MODES = Object.freeze({
  TEST: 'test',
  ARMED: 'armed',
  DEPLOY: 'deploy',
});

export const DEPLOY_READINESS = Object.freeze({
  ARM_MANUAL_CLOSES: 3,
  ARM_LEARNED_BUCKETS: 1,
  READY_MANUAL_CLOSES: 5,
  READY_LEARNED_BUCKETS: 2,
  SAFE_MANUAL_CLOSES: 10,
  SAFE_LEARNED_BUCKETS: 3,
});

export function normalizeDeploymentMode(settings = {}) {
  const raw = settings.deploymentMode;
  if (Object.values(DEPLOYMENT_MODES).includes(raw)) return raw;
  return DEPLOYMENT_MODES.TEST;
}

export function modeToTestMode(mode) {
  return normalizeDeploymentMode({ deploymentMode: mode }) !== DEPLOYMENT_MODES.DEPLOY;
}

export function deploymentModePatch(mode, extra = {}) {
  const normalized = normalizeDeploymentMode({ deploymentMode: mode });
  return {
    deploymentMode: normalized,
    testMode: modeToTestMode(normalized),
    ...extra,
  };
}

export function summarizeDeployReadiness(summary = {}) {
  const manualCount = Number(summary.manualCount || 0);
  const learnedCategoryCount = Number(summary.categoriesWithRecommendations || 0);
  const learnedDomainCount = Number(summary.domainsWithRecommendations || 0);
  const trackedCategoryCount = Number(summary.categoriesTracked || 0);
  const trackedDomainCount = Number(summary.domainsTracked || 0);
  const learnedBucketCount = learnedCategoryCount + learnedDomainCount;
  const trackedBucketCount = trackedCategoryCount + trackedDomainCount;
  const armable = manualCount >= DEPLOY_READINESS.ARM_MANUAL_CLOSES
    && learnedBucketCount >= DEPLOY_READINESS.ARM_LEARNED_BUCKETS;
  const ready = manualCount >= DEPLOY_READINESS.READY_MANUAL_CLOSES
    && learnedBucketCount >= DEPLOY_READINESS.READY_LEARNED_BUCKETS;
  const safer = manualCount >= DEPLOY_READINESS.SAFE_MANUAL_CLOSES
    && learnedBucketCount >= DEPLOY_READINESS.SAFE_LEARNED_BUCKETS;

  return {
    manualCount,
    learnedCategoryCount,
    learnedDomainCount,
    learnedBucketCount,
    trackedCategoryCount,
    trackedDomainCount,
    trackedBucketCount,
    armable,
    ready,
    safer,
    stage: ready ? 'ready' : (armable ? 'armable' : 'blocked'),
    required: DEPLOY_READINESS,
  };
}

export function decideDeploymentModeRequest(requestedMode, readiness = {}) {
  const requested = requestedMode === DEPLOYMENT_MODES.TEST
    ? DEPLOYMENT_MODES.TEST
    : DEPLOYMENT_MODES.DEPLOY;

  if (requested === DEPLOYMENT_MODES.TEST) {
    return {
      ok: true,
      mode: DEPLOYMENT_MODES.TEST,
      action: 'test',
      message: 'Test mode is active.',
    };
  }

  if (readiness.ready) {
    return {
      ok: true,
      mode: DEPLOYMENT_MODES.DEPLOY,
      action: 'deploy',
      message: 'Deploy mode is active.',
    };
  }

  if (readiness.armable) {
    return {
      ok: true,
      mode: DEPLOYMENT_MODES.ARMED,
      action: 'armed',
      message: `Deploy armed. It will activate after ${DEPLOY_READINESS.READY_MANUAL_CLOSES} manual closes and ${DEPLOY_READINESS.READY_LEARNED_BUCKETS} learned buckets.`,
    };
  }

  return {
    ok: false,
    mode: DEPLOYMENT_MODES.TEST,
    action: 'blocked',
    message: `Deploy locked until at least ${DEPLOY_READINESS.ARM_MANUAL_CLOSES} manual closes and ${DEPLOY_READINESS.ARM_LEARNED_BUCKETS} learned bucket exist.`,
  };
}

export function reconcileDeploymentMode(currentMode, readiness = {}) {
  const mode = normalizeDeploymentMode({ deploymentMode: currentMode });

  if (mode === DEPLOYMENT_MODES.ARMED && readiness.ready) {
    return {
      mode: DEPLOYMENT_MODES.DEPLOY,
      changed: true,
      reason: 'armed_ready',
    };
  }

  if (mode === DEPLOYMENT_MODES.DEPLOY && !readiness.ready) {
    return {
      mode: readiness.armable ? DEPLOYMENT_MODES.ARMED : DEPLOYMENT_MODES.TEST,
      changed: true,
      reason: readiness.armable ? 'deploy_no_longer_ready' : 'deploy_locked',
    };
  }

  return {
    mode,
    changed: false,
    reason: 'unchanged',
  };
}
