// api/chat.js  (Claude-backed variant)
//
// Drop-in replacement for the Groq version. Frontend (voice_chat.html) sends
// the SAME OpenAI-style request it always has ({ messages: [...] }) and
// expects the SAME OpenAI-style response back ({ choices: [{ message: {...} }] }).
// This file quietly translates both directions to/from Anthropic's native
// Messages API format, so no frontend changes are needed.
//
// Requires a new env var in THIS Vercel project only: ANTHROPIC_API_KEY

const MODEL_CHAIN = [
  'claude-sonnet-5',              // 1. Primary — strong reasoning, good speed/cost balance
  'claude-haiku-4-5-20251001',    // 2. Fallback — fastest/cheapest if primary is rate-limited
];

// Anthropic's Messages API takes `system` as a separate top-level string,
// not as a message with role "system" inside the messages array.
function splitSystemFromMessages(messages) {
  let system;
  const converted = [];
  for (const m of messages || []) {
    if (m.role === 'system') {
      system = system ? `${system}\n${m.content}` : m.content;
    } else {
      converted.push({ role: m.role, content: m.content });
    }
  }
  return { system, messages: converted };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { preferredModel, messages, max_tokens, ...rest } = req.body || {};

  let chain = MODEL_CHAIN;
  if (preferredModel && MODEL_CHAIN.includes(preferredModel)) {
    chain = [preferredModel, ...MODEL_CHAIN.filter(m => m !== preferredModel)];
  }

  const { system, messages: anthropicMessages } = splitSystemFromMessages(messages);

  let lastError = null;

  for (const model of chain) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: max_tokens || 1024,
          system,
          messages: anthropicMessages,
        }),
      });

      const data = await response.json();

      if (!data.error) {
        // Translate Anthropic's response shape back into the OpenAI-style
        // shape the frontend already knows how to read.
        const text = (data.content || []).map(block => block.text || '').join('');
        return res.status(200).json({
          choices: [{ message: { role: 'assistant', content: text } }],
          _modelUsed: model,
        });
      }

      lastError = data.error;
      console.log(`Model ${model} failed (${data.error.type}), trying next...`);
    } catch (err) {
      lastError = { message: err.message };
      console.log(`Model ${model} threw an exception, trying next...`, err.message);
    }
  }

  return res.status(500).json({
    error: 'All models exhausted for today. Please try again later.',
    details: lastError,
  });
}
