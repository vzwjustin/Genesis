/**
 * Responses API Transformer
 * Converts OpenAI Chat Completions SSE to Codex Responses API SSE format
 * Can be used in both Next.js and Cloudflare Workers
 */

import fs from "fs";
import path from "path";
import { trailingPartialTagLen } from "../utils/thinkTag.js";

// Create log directory for responses (Node.js only)
export function createResponsesLogger(model, logsDir = null) {
  // Skip logging in worker environment (no fs)
  if (typeof fs.mkdirSync !== "function") {
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const uniqueId = Math.random().toString(36).slice(2, 8);
  const baseDir = logsDir || (typeof process !== "undefined" ? process.cwd() : ".");
  const logDir = path.join(baseDir, "logs", `responses_${model}_${timestamp}_${uniqueId}`);
  
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    return null;
  }

  let inputEvents = [];
  let outputEvents = [];

  return {
    logInput: (event) => {
      inputEvents.push(event);
    },
    logOutput: (event) => {
      outputEvents.push(event);
    },
    flush: () => {
      try {
        fs.writeFileSync(path.join(logDir, "1_input_stream.txt"), inputEvents.join("\n"));
        fs.writeFileSync(path.join(logDir, "2_output_stream.txt"), outputEvents.join("\n"));
      } catch (e) {
        console.log("[RESPONSES] Failed to write logs:", e.message);
      }
    }
  };
}

/**
 * Create TransformStream that converts Chat Completions SSE to Responses API SSE
 * @param {Object} logger - Optional logger instance
 * @returns {TransformStream}
 */
export function createResponsesApiTransformStream(logger = null) {
  const state = {
    seq: 0,
    responseId: `resp_${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    started: false,
    nextOutputIndex: 0,
    msgTextBuf: {},
    msgItemAdded: {},
    msgContentAdded: {},
    msgItemDone: {},
    msgOutputIndex: {},
    reasoningId: "",
    reasoningIndex: -1,
    reasoningBuf: "",
    reasoningPartAdded: false,
    reasoningDone: false,
    inThinking: false,
    funcArgsBuf: {},
    funcNames: {},
    funcCallIds: {},
    funcArgsDone: {},
    funcItemDone: {},
    funcOutputIndex: {},
    buffer: "",
    completedSent: false,
    finishReasonSeen: false,
    thinkCarry: "",
    lastIdx: 0,
    usage: null
  };

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const nextSeq = () => ++state.seq;
  
  const emit = (controller, eventType, data) => {
    data.sequence_number = nextSeq();
    const output = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    logger?.logOutput(output.trim());
    controller.enqueue(encoder.encode(output));
  };

  // Responses API output_index is the slot in the output[] array — a monotonic
  // per-item counter, NOT the chat-completions choice.index. Reasoning, message,
  // and each tool call are distinct output items and must get distinct indices.
  // Reusing `idx`/`tcIdx` (all starting at 0) collides them, and strict Responses
  // clients (Codex/Cursor) reject duplicate output_index → dropped tool call.
  const allocOutputIndex = () => state.nextOutputIndex++;

  // Helper to start reasoning
  const startReasoning = (controller, idx) => {
    if (!state.reasoningId) {
      state.reasoningId = `rs_${state.responseId}_${idx}`;
      state.reasoningIndex = allocOutputIndex();
      
      emit(controller, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: state.reasoningIndex,
        item: {
          id: state.reasoningId,
          type: "reasoning",
          summary: []
        }
      });

      emit(controller, "response.reasoning_summary_part.added", {
        type: "response.reasoning_summary_part.added",
        item_id: state.reasoningId,
        output_index: state.reasoningIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" }
      });
      state.reasoningPartAdded = true;
    }
  };

  const emitReasoningDelta = (controller, text) => {
    if (!text) return;
    state.reasoningBuf += text;
    emit(controller, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      delta: text
    });
  };

  const closeReasoning = (controller) => {
    if (state.reasoningId && !state.reasoningDone) {
      state.reasoningDone = true;
      
      emit(controller, "response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        item_id: state.reasoningId,
        output_index: state.reasoningIndex,
        summary_index: 0,
        text: state.reasoningBuf
      });

      emit(controller, "response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done",
        item_id: state.reasoningId,
        output_index: state.reasoningIndex,
        summary_index: 0,
        part: { type: "summary_text", text: state.reasoningBuf }
      });

      emit(controller, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: state.reasoningIndex,
        item: {
          id: state.reasoningId,
          type: "reasoning",
          summary: [{ type: "summary_text", text: state.reasoningBuf }]
        }
      });
    }
  };

  const emitTextDelta = (controller, idx, content) => {
    if (!content) return;
    if (!state.msgItemAdded[idx]) {
      closeReasoning(controller);
      state.msgItemAdded[idx] = true;
      state.msgOutputIndex[idx] = allocOutputIndex();
      const msgId = `msg_${state.responseId}_${idx}`;

      emit(controller, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: state.msgOutputIndex[idx],
        item: { id: msgId, type: "message", content: [], role: "assistant" }
      });
    }
    const outIdx = state.msgOutputIndex[idx];

    if (!state.msgContentAdded[idx]) {
      state.msgContentAdded[idx] = true;

      emit(controller, "response.content_part.added", {
        type: "response.content_part.added",
        item_id: `msg_${state.responseId}_${idx}`,
        output_index: outIdx,
        content_index: 0,
        part: { type: "output_text", annotations: [], logprobs: [], text: "" }
      });
    }

    emit(controller, "response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: `msg_${state.responseId}_${idx}`,
      output_index: outIdx,
      content_index: 0,
      delta: content,
      logprobs: []
    });

    if (!state.msgTextBuf[idx]) state.msgTextBuf[idx] = "";
    state.msgTextBuf[idx] += content;
  };

  const closeMessage = (controller, idx) => {
    if (state.msgItemAdded[idx] && !state.msgItemDone[idx]) {
      state.msgItemDone[idx] = true;
      const fullText = state.msgTextBuf[idx] || "";
      const msgId = `msg_${state.responseId}_${idx}`;
      const outIdx = state.msgOutputIndex?.[idx] ?? parseInt(idx);

      emit(controller, "response.output_text.done", {
        type: "response.output_text.done",
        item_id: msgId,
        output_index: outIdx,
        content_index: 0,
        text: fullText,
        logprobs: []
      });

      emit(controller, "response.content_part.done", {
        type: "response.content_part.done",
        item_id: msgId,
        output_index: outIdx,
        content_index: 0,
        part: { type: "output_text", annotations: [], logprobs: [], text: fullText }
      });

      emit(controller, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: outIdx,
        item: {
          id: msgId,
          type: "message",
          content: [{ type: "output_text", annotations: [], logprobs: [], text: fullText }],
          role: "assistant"
        }
      });
    }
  };

  const closeToolCall = (controller, idx) => {
    const callId = state.funcCallIds[idx];
    if (callId && !state.funcItemDone[idx]) {
      const args = state.funcArgsBuf[idx] || "{}";
      const outIdx = state.funcOutputIndex?.[idx] ?? parseInt(idx);
      
      emit(controller, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: `fc_${callId}`,
        output_index: outIdx,
        arguments: args
      });

      emit(controller, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: outIdx,
        item: {
          id: `fc_${callId}`,
          type: "function_call",
          arguments: args,
          call_id: callId,
          name: state.funcNames[idx] || ""
        }
      });

      state.funcItemDone[idx] = true;
      state.funcArgsDone[idx] = true;
    }
  };

  const sendCompleted = (controller) => {
    if (!state.completedSent) {
      state.completedSent = true;
      const response = {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "completed",
        background: false,
        error: null
      };
      if (state.usage) {
        response.usage = { ...state.usage };
      }
      emit(controller, "response.completed", {
        type: "response.completed",
        response
      });
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      logger?.logInput(text.trim());
      state.buffer += text;

      const messages = state.buffer.split("\n\n");
      state.buffer = messages.pop() || "";

      for (const msg of messages) {
        if (!msg.trim()) continue;

        const dataMatch = msg.match(/^data:\s*(.+)$/m);
        if (!dataMatch) continue;

        const dataStr = dataMatch[1].trim();
        if (dataStr === "[DONE]") continue;

        let parsed;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (!parsed.choices?.length) continue;
        
        const choice = parsed.choices[0];
        const idx = choice.index ?? 0;
        state.lastIdx = idx;
        const delta = choice.delta || {};

        // Emit initial events
        if (!state.started) {
          state.started = true;
          state.responseId = parsed.id ? `resp_${parsed.id}` : state.responseId;
          
          emit(controller, "response.created", {
            type: "response.created",
            response: {
              id: state.responseId,
              object: "response",
              created_at: state.created,
              status: "in_progress",
              background: false,
              error: null,
              output: []
            }
          });

          emit(controller, "response.in_progress", {
            type: "response.in_progress",
            response: {
              id: state.responseId,
              object: "response",
              created_at: state.created,
              status: "in_progress"
            }
          });
        }

        // Handle reasoning_content (OpenAI native format)
        if (delta.reasoning_content) {
          startReasoning(controller, idx);
          emitReasoningDelta(controller, delta.reasoning_content);
        }

        // Handle text content (may contain <think> tags)
        if (delta.content) {
          // Prepend any partial tag held back from the previous chunk, then
          // hold back a new trailing partial so a <think>/</think> tag split
          // across two deltas is still detected as a whole.
          let content = (state.thinkCarry || "") + delta.content;
          state.thinkCarry = "";
          const holdLen = trailingPartialTagLen(content);
          if (holdLen > 0) {
            state.thinkCarry = content.slice(content.length - holdLen);
            content = content.slice(0, content.length - holdLen);
          }
          if (!content) continue;

          if (content.includes("<think>")) {
            state.inThinking = true;
            content = content.replace(/<think>/g, "");
            startReasoning(controller, idx);
          }

          if (content.includes("</think>")) {
            const parts = content.split("</think>");
            const thinkPart = parts[0];
            const textPart = parts.slice(1).join("</think>");
            
            if (thinkPart) emitReasoningDelta(controller, thinkPart);
            closeReasoning(controller);
            state.inThinking = false;
            content = textPart;
          }

          if (state.inThinking && content) {
            emitReasoningDelta(controller, content);
            continue;
          }

          // Regular text content
          if (content) {
            emitTextDelta(controller, idx, content);
          }
        }

        // Handle tool_calls
        if (delta.tool_calls) {
          closeMessage(controller, idx);
          closeReasoning(controller);

          for (const tc of delta.tool_calls) {
            const tcIdx = tc.index ?? 0;
            const newCallId = tc.id;
            const funcName = tc.function?.name;

            if (funcName) state.funcNames[tcIdx] = funcName;

            if (!state.funcCallIds[tcIdx] && newCallId) {
              state.funcCallIds[tcIdx] = newCallId;
              state.funcOutputIndex[tcIdx] = allocOutputIndex();
              
              emit(controller, "response.output_item.added", {
                type: "response.output_item.added",
                output_index: state.funcOutputIndex[tcIdx],
                item: {
                  id: `fc_${newCallId}`,
                  type: "function_call",
                  arguments: "",
                  call_id: newCallId,
                  name: state.funcNames[tcIdx] || ""
                }
              });
            }

            if (!state.funcArgsBuf[tcIdx]) state.funcArgsBuf[tcIdx] = "";

            if (tc.function?.arguments) {
              const refCallId = state.funcCallIds[tcIdx] || newCallId;
              if (refCallId) {
                emit(controller, "response.function_call_arguments.delta", {
                  type: "response.function_call_arguments.delta",
                  item_id: `fc_${refCallId}`,
                  output_index: state.funcOutputIndex[tcIdx] ?? tcIdx,
                  delta: tc.function.arguments
                });
              }
              state.funcArgsBuf[tcIdx] += tc.function.arguments;
            }
          }
        }

        if (parsed.usage) {
          state.usage = {
            input_tokens: parsed.usage.prompt_tokens ?? parsed.usage.input_tokens ?? 0,
            output_tokens: parsed.usage.completion_tokens ?? parsed.usage.output_tokens ?? 0,
            total_tokens: parsed.usage.total_tokens ?? 0
          };
        }

        // Handle finish_reason
        if (choice.finish_reason) {
          state.finishReasonSeen = true;
          // Any held-back fragment never completed into a tag — it is real text.
          if (state.thinkCarry) {
            const carry = state.thinkCarry;
            state.thinkCarry = "";
            if (state.inThinking) emitReasoningDelta(controller, carry);
            else emitTextDelta(controller, idx, carry);
          }
          for (const i in state.msgItemAdded) closeMessage(controller, i);
          closeReasoning(controller);
          for (const i in state.funcCallIds) closeToolCall(controller, i);
          sendCompleted(controller);
        }
      }
    },

    flush(controller) {
      if (!state.finishReasonSeen) {
        // Emit any held-back partial tag as real text — it never completed.
        if (state.thinkCarry) {
          const carry = state.thinkCarry;
          state.thinkCarry = "";
          if (state.inThinking) emitReasoningDelta(controller, carry);
          else emitTextDelta(controller, state.lastIdx || 0, carry);
        }
        for (const i in state.msgItemAdded) closeMessage(controller, i);
        closeReasoning(controller);
        for (const i in state.funcCallIds) closeToolCall(controller, i);
      }

      if (state.finishReasonSeen) {
        for (const i in state.funcCallIds) closeToolCall(controller, i);
        sendCompleted(controller);
        logger?.logOutput("data: [DONE]");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } else if (state.started) {
        emit(controller, "response.failed", {
          type: "response.failed",
          response: {
            id: state.responseId,
            object: "response",
            created_at: state.created,
            status: "failed",
            background: false,
            error: {
              type: "incomplete_stream",
              message: "Stream ended without finish_reason"
            }
          }
        });
      }

      logger?.flush();
    }
  });
}
