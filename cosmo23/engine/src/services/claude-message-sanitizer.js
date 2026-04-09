/**
 * Claude Message Sanitizer
 *
 * Ensures the claudeMessages array sent to the Anthropic Messages API
 * satisfies all structural constraints:
 * - tool_result blocks must follow an assistant message with matching tool_use
 * - Messages must alternate between user and assistant roles
 * - First message must be user role
 *
 * Operates purely on structure — never modifies content within blocks
 * (tool names, IDs, text, image data all pass through unchanged).
 */

/**
 * Normalize content to an array of content blocks.
 * Wraps string content as { type: 'text', text: ... }.
 */
function normalizeContent(content) {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content;
  }
  return [{ type: 'text', text: String(content || '') }];
}

/**
 * Sanitize Claude-format messages before sending to the Anthropic API.
 *
 * @param {Array} claudeMessages - Array of {role, content} messages in Claude format
 * @returns {Array} - Sanitized messages array
 */
function sanitizeClaudeMessages(claudeMessages) {
  if (!claudeMessages || claudeMessages.length === 0) return claudeMessages;

  // Step 1: Merge consecutive same-role messages
  // This combines separate tool_result user messages from the same assistant turn
  const merged = [];
  let mergeCount = 0;

  for (const msg of claudeMessages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      const prevContent = normalizeContent(prev.content);
      const msgContent = normalizeContent(msg.content);
      prev.content = [...prevContent, ...msgContent];
      mergeCount++;
    } else {
      merged.push({ role: msg.role, content: msg.content });
    }
  }

  if (mergeCount > 0) {
    console.log(`[CLAUDE SANITIZE] Merged ${mergeCount} consecutive same-role message(s)`);
  }

  // Step 2: Validate tool_result adjacency and remove orphans
  // Each tool_result must reference a tool_use in the IMMEDIATELY preceding assistant message
  let orphanCount = 0;
  for (let i = 0; i < merged.length; i++) {
    const msg = merged[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    const hasToolResults = msg.content.some(b => b.type === 'tool_result');
    if (!hasToolResults) continue;

    // Collect tool_use IDs from the immediately preceding assistant message
    const prevMsg = i > 0 ? merged[i - 1] : null;
    const prevToolUseIds = new Set();
    if (prevMsg && prevMsg.role === 'assistant' && Array.isArray(prevMsg.content)) {
      for (const block of prevMsg.content) {
        if (block.type === 'tool_use' && block.id) {
          prevToolUseIds.add(block.id);
        }
      }
    }

    // Filter out tool_result blocks that don't match the preceding assistant
    const validContent = msg.content.filter(block => {
      if (block.type === 'tool_result') {
        if (!prevToolUseIds.has(block.tool_use_id)) {
          orphanCount++;
          console.warn(`[CLAUDE SANITIZE] Removing orphaned tool_result: ${block.tool_use_id} (no matching tool_use in preceding assistant)`);
          return false;
        }
      }
      return true;
    });

    if (validContent.length === 0) {
      // Entire message was orphaned tool_results — remove it
      merged.splice(i, 1);
      i--;
    } else {
      msg.content = validContent;
    }
  }

  if (orphanCount > 0) {
    console.log(`[CLAUDE SANITIZE] Removed ${orphanCount} orphaned tool_result(s)`);
  }

  // Step 3: Ensure first message is user role
  if (merged.length > 0 && merged[0].role !== 'user') {
    merged.unshift({
      role: 'user',
      content: '[Continuing from previous context]'
    });
    console.log('[CLAUDE SANITIZE] Prepended user message (first message was not user role)');
  }

  // Step 4: Ensure proper user/assistant alternation
  const final = [merged[0]];
  let insertCount = 0;

  for (let i = 1; i < merged.length; i++) {
    const prev = final[final.length - 1];
    const curr = merged[i];

    if (prev.role === curr.role) {
      // Insert a bridging message of the opposite role
      if (curr.role === 'assistant') {
        final.push({ role: 'user', content: '[continue]' });
      } else {
        final.push({ role: 'assistant', content: 'Understood, continuing.' });
      }
      insertCount++;
    }
    final.push({ role: curr.role, content: curr.content });
  }

  if (insertCount > 0) {
    console.log(`[CLAUDE SANITIZE] Inserted ${insertCount} bridging message(s) for alternation`);
  }

  return final;
}

module.exports = { sanitizeClaudeMessages };
