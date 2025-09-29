const { Ollama } = require('ollama');

class LLMClient {
  constructor(model = 'llama3.2') {
    this.ollama = new Ollama();
    this.model = model;
  }

  async generate(prompt) {
    // Nudge the model harder toward strict JSON without changing global behavior.
    const system = [
      'You MUST reply with a single JSON object.',
      'Do not include prose before or after the JSON.',
      'Do not use trailing commas or comments.',
      'Use only double quotes for strings and keys.',
    ].join(' ');
    const res = await this.ollama.chat({
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      options: { temperature: 0.6 }
    });
    return res.message?.content || '';
  }
}

module.exports = { LLMClient };
