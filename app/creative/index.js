const { safeParse, coerceCreativeSchema } = require('./llm_parse');
const path = require('path');
const fs = require('fs');

function logCreative(tag, data) {
  try {
    const logsDir = path.resolve(__dirname, '..', 'Logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const p = path.join(logsDir, `creative-${tag}.log`);
    fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  } catch (_) {}
}

async function runCreativeLLM(prompt, llmClient, contextTag) {
  // call out to LLM via llmClient; it returns a string we expect to be JSON
  const raw = await llmClient.generate(prompt);
  const parsed = safeParse(raw, contextTag || 'session');
  if (!parsed.ok) {
    // fall back to a minimal but valid object so UI/DB don't break
    logCreative('parse-failed', { error: parsed.error });
    return coerceCreativeSchema({
      genre: [],
      mood: [],
      theme: [],
      suggestedInstruments: [],
      vocals: [],
      lyricThemes: [],
      narrative: '',
      confidence: 0.4,
    });
  }
  return coerceCreativeSchema(parsed.data);
}

module.exports = {
  runCreativeLLM,
};
