import { register } from "../registry.js";
import { FORMATS } from "../formats.js";

import { adjustMaxTokens } from "../helpers/maxTokensHelper.js";

function flattenTextOnlyParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  if (!parts.every((part) => part?.type === "text")) return null;
  return parts.map((part) => part.text || "").join("\n");
}

// Convert Claude request to OpenAI format
export function claudeToOpenAIRequest(model, body, stream) {
  const result = {
    model: model,
    messages: [],
    stream: stream
  };

  // Max tokens
  if (body.max_tokens) {
    result.max_tokens = adjustMaxTokens(body);
  }

  // Temperature
  if (body.temperature !== undefined) {
    result.temperature = body.temperature;
  }

  // System message
  if (body.system) {
    if (Array.isArray(body.system)) {
      const textParts = [];
      for (const block of body.system) {
        if (block?.text) {
          textParts.push(block.text);
        } else if (block?.type && block.type !== "text") {
          console.warn(
            `[claude-to-openai] non-text system block type "${block.type}" cannot be represented in OpenAI format`
          );
        }
      }
      const systemContent = textParts.join("\n");
      if (systemContent) {
        result.messages.push({ role: "system", content: systemContent });
      }
    } else if (typeof body.system === "string" && body.system) {
      result.messages.push({ role: "system", content: body.system });
    }
  }

  // Convert messages
  if (body.messages && Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      const converted = convertClaudeMessage(msg);
      if (converted) {
        // Handle array of messages (multiple tool results)
        if (Array.isArray(converted)) {
          result.messages.push(...converted);
        } else {
          result.messages.push(converted);
        }
      }
    }
  }

  // Fix missing tool responses - OpenAI requires every tool_call to have a response
  fixMissingToolResponses(result.messages);

  // Tools — convert client function tools to OpenAI shape.
  // Anthropic built-ins (web_search_20250305, bash_*, etc.) are not valid
  // Chat Completions tools for OpenAI-compatible providers such as OpenRouter.
  if (body.tools && Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((tool) => {
      if (tool.type && tool.type !== "function") {
        return [];
      }
      if (!tool.name) return [];
      return [{
        type: "function",
        function: {
          name: tool.name,
          description: String(tool.description || ""),
          parameters: tool.input_schema || { type: "object", properties: {} },
        },
      }];
    });
    if (tools.length > 0) result.tools = tools;
  }

  // Tool choice
  if (body.tool_choice && (result.tools?.length || isToolChoiceNone(body.tool_choice))) {
    const toolNames = result.tools
      ? new Set(result.tools.map((tool) => tool.function?.name).filter(Boolean))
      : null;
    const toolChoice = convertToolChoice(body.tool_choice, toolNames);
    if (toolChoice !== undefined) result.tool_choice = toolChoice;
  }

  return result;
}

// Fix missing tool responses - add empty responses for tool_calls without responses
function fixMissingToolResponses(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCallIds = msg.tool_calls.map(tc => tc.id);
      
      // Collect all tool response IDs that IMMEDIATELY follow this assistant message
      const respondedIds = new Set();
      let insertPosition = i + 1;
      for (let j = i + 1; j < messages.length; j++) {
        const nextMsg = messages[j];
        if (nextMsg.role === "tool" && nextMsg.tool_call_id) {
          respondedIds.add(nextMsg.tool_call_id);
          insertPosition = j + 1;
        } else {
          break;
        }
      }
      
      // Find missing responses and insert them
      const missingIds = toolCallIds.filter(id => !respondedIds.has(id));
      
      if (missingIds.length > 0) {
        const missingResponses = missingIds.map(id => ({
          role: "tool",
          tool_call_id: id,
          content: "[No response received]"
        }));
        messages.splice(insertPosition, 0, ...missingResponses);
        i = insertPosition + missingResponses.length - 1;
      }
    }
  }
}

// Convert single Claude message - returns single message or array of messages
function convertClaudeMessage(msg) {
  const role = msg.role === "user" || msg.role === "tool" ? "user" : "assistant";
  
  // Simple string content
  if (typeof msg.content === "string") {
    return { role, content: msg.content };
  }

  // Array content
  if (Array.isArray(msg.content)) {
    const parts = [];
    const toolCalls = [];
    const toolResults = [];
    let reasoningContent = "";

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          parts.push({ type: "text", text: block.text });
          break;

        case "thinking":
          if (block.thinking) {
            reasoningContent += block.thinking;
          }
          break;

        case "redacted_thinking":
          break;

        case "image":
          if (block.source?.type === "base64") {
            parts.push({
              type: "image_url",
              image_url: {
                url: `data:${block.source.media_type};base64,${block.source.data}`
              }
            });
          } else if (block.source?.type === "url" && block.source.url) {
            parts.push({
              type: "image_url",
              image_url: { url: block.source.url }
            });
          }
          break;

        case "tool_use":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {})
            }
          });
          break;

        case "tool_result":
          let resultContent = "";
          if (typeof block.content === "string") {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            resultContent = block.content
              .filter(c => c.type === "text")
              .map(c => c.text)
              .join("\n") || JSON.stringify(block.content);
          } else if (block.content) {
            resultContent = JSON.stringify(block.content);
          }
          
          toolResults.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: resultContent
          });
          break;
      }
    }

    // If has tool results, return array of tool messages
    if (toolResults.length > 0) {
      if (parts.length > 0) {
        const textContent = flattenTextOnlyParts(parts) ?? parts;
        return [...toolResults, { role: "user", content: textContent }];
      }
      return toolResults;
    }

    // If has tool calls, return assistant message with tool_calls
    if (toolCalls.length > 0) {
      const result = { role: "assistant" };
      if (parts.length > 0) {
        result.content = flattenTextOnlyParts(parts) ?? parts;
      }
      if (reasoningContent) result.reasoning_content = reasoningContent;
      result.tool_calls = toolCalls;
      return result;
    }

    // Return content
    if (parts.length > 0 || reasoningContent) {
      const result = {
        role,
        content: parts.length > 0 ? (flattenTextOnlyParts(parts) ?? parts) : (reasoningContent ? "" : null)
      };
      if (reasoningContent) result.reasoning_content = reasoningContent;
      return result;
    }
    
    // Empty content array
    if (msg.content.length === 0) {
      return { role, content: "" };
    }
  }

  return null;
}

// Convert tool choice
function isToolChoiceNone(choice) {
  return choice === "none" || choice?.type === "none";
}

function convertToolChoice(choice, availableToolNames = null) {
  if (!choice) return "auto";
  if (typeof choice === "string") {
    if (choice === "none") return "none";
    return choice;
  }

  switch (choice.type) {
    case "none": return "none";
    case "auto": return "auto";
    case "any": return "required";
    case "tool": {
      if (!choice.name || (availableToolNames && !availableToolNames.has(choice.name))) return undefined;
      return { type: "function", function: { name: choice.name } };
    }
    default: return "auto";
  }
}

// Register
register(FORMATS.CLAUDE, FORMATS.OPENAI, claudeToOpenAIRequest, null);
