// Configurable product defaults, not experimentally established optimal values.
export const AUTOMATICITY_CONFIG = {
  automaticityTargetMs: 1500,
  verySlowThresholdMs: 3000,
  attemptWindowMs: 4000, // Preserve the existing speech attempt window.
  activeTrainingPromptLimit: 10,
  maxGradedAttemptsPerFactPerSession: 5,
  wrongRetry: { minimumUnrelatedQuestions: 3, minimumElapsedMs: 15000 },
  verySlowCorrectRetry: { minimumUnrelatedQuestions: 4, minimumElapsedMs: 20000 },
  slowCorrectRetry: { minimumUnrelatedQuestions: 8, minimumElapsedMs: 30000 },
  firstFastTrainingSuccessRetry: { minimumUnrelatedQuestions: 12, minimumElapsedMs: 60000 },
  fastTrainingSuccessesToFinishToday: 2,
  crossDayIntervalsDays: [1, 2, 4, 7, 14, 30],
  minimumColdGapMs: 24 * 60 * 60 * 1000,
  coldSuccessesRequiredForVerification: 4,
  minimumVerificationSpanMs: 7 * 24 * 60 * 60 * 1000,
  recentAnswerPrimingWindow: 3,
  allocation: ["TRAINING", "TRAINING", "CHECK", "TRAINING", "TRAINING", "CHECK", "TRAINING", "TRAINING", "TRAINING", "CHECK"],
} as const;
export type AutomaticityConfig = typeof AUTOMATICITY_CONFIG;
