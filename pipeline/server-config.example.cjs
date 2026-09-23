const HARDCODED_OPENAI_API_KEY = ""; // ВСТАВИТЬ API-КЛЮЧ ЗДЕСЬ

module.exports = {
  apiKey: HARDCODED_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || "gpt-6-luna",
  modelByRole: {},
  effortByRole: {
    routing: "high", extraction: "high", comparison: "high",
    crosscheck: "xhigh", judge: "xhigh", synthesis: "high"
  },
  limits: { filesPerSide: 10, fileBytes: 20971520, totalTextChars: 2000000 },
  budgets: {
    overviewChars: 3200, chunkChars: 18000, chunkBlocks: 40,
    inputChars: 600000, outputTokens: 18000, toolRounds: 16,
    llmCalls: 500, timeoutMs: 180000, transientRetries: 2,
    searchPageSize: 20, toolTextChars: 30000, crosscheckBatch: 45, reconciliationPairs: 120
  }
};
