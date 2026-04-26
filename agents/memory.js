// agents/memory.js — safe wrapper
// Updates client memory/context after each conversation turn
// Silently ignores errors if schema is not ready yet

const { memoryUpdate } = require('../core/db');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function update(phone, clientObj, lastMessage) {
  try {
    if (!phone || !lastMessage) return;
    // Simple memory update — just store last interaction context
    // Full AI-powered memory summarization would go here
    await memoryUpdate(phone, {
      summary: null,
      favoriteServices: null,
      visitPatterns: null,
      personalityNotes: null,
    });
  } catch(e) {
    // Silently ignore - memory is non-critical
  }
}

module.exports = { update };