# Voca Agent Design (As of Current Implementation)

This document outlines the design and operational flow of the Voca agent based on the current codebase (`src/loop.ts`, `src/loop/tool-execution.ts`, `src/loop/state-helpers.ts`, various prompts).

## 1. Goal

Voca aims to be an AI assistant integrated with Linear, capable of understanding user requests, interacting with the Linear API via tools, and assisting with project management tasks like issue creation, updates, search, and providing information.

## 2. Core Components

*   **Main Loop (`src/loop.ts`):** Orchestrates the conversation turn, processing user input, managing state, calling the LLM, and invoking tool execution.
*   **State Manager (`src/state/manager.ts`):** Handles loading and saving the `AgentState` to/from Redis using a session ID.
*   **LLM Client (`src/api/core/gemini-client.ts`):** Interfaces with the Google Gemini API for generating content and requesting tool calls.
*   **Linear Client (`src/linear/client.ts`):** Provides an authenticated client for interacting with the Linear API.
*   **Tools (`src/tools/`):** Functions implementing specific actions (e.g., `linear_search`, `linear_get_details`, `stage_add`, `apply_staged_changes`).
*   **Prompts (`src/prompts/`):** System instructions guiding the LLM's behavior, including static context, scratchpad usage, task-specific instructions, and post-tool summarization guidelines.
*   **State (`src/state/types.ts`, `src/types/agent-output.ts`):** Defines the structure of the agent's memory (`AgentState`) and the output of a conversation turn (`AgentTurnOutput`).

## 3. Conversation Turn Flow (Corrected)

The agent processes a conversation turn, including potential tool use, within a single invocation of `runConversationTurn`. The logic distinguishes between needing to call a tool and providing a text-only response.

**Step 1: Initial User Input & LLM Call 1 (in `runConversationTurn`)**

1.  Receive `sessionId` and `userInput`.
2.  Load `AgentState` from Redis.
3.  Add user input to `conversation_history`.
4.  Construct the system prompt using static parts, serialized core context, scratchpad instructions (`GEMINI_SYSTEM_PROMPT_SCRATCHPAD_INSTRUCTIONS`), current scratchpad content, and task-specific instructions.
    *   The scratchpad instructions guide the LLM on *how* to respond based on whether a tool is needed.
5.  Call `geminiClient.generateContentWithTools` with history and available tools.
6.  Receive the SDK response, containing potential `functionCalls` (tool requests) and `text` (LLM's textual response).

**Step 2a: Text-Only Response Path (No Tool Call Requested)**

1.  If the SDK response contains *no* `functionCalls`:
2.  The LLM is expected (per `GEMINI_SYSTEM_PROMPT_SCRATCHPAD_INSTRUCTIONS`) to have put a **JSON object** (`{userFacingMessage, scratchpad, currentPlan}`) in the `text` field.
3.  Parse this `text` using `extractLlmResponseAndScratchpad` to get `userFacingMessage`, `newScratchpad`, and `updatedPlan`.
4.  Update `AgentState` with `newScratchpad` and `updatedPlan`.
5.  Add `userFacingMessage` to history as the assistant message.
6.  Save updated `AgentState`.
7.  Return an `AgentTurnOutput` with `textResponse` set to `userFacingMessage`.

**Step 2b: Tool Call Path (Function Call Requested)**

1.  If the SDK response *does* contain `functionCalls`:
2.  The LLM is expected (per `GEMINI_SYSTEM_PROMPT_SCRATCHPAD_INSTRUCTIONS`) to have put only a **simple string** (e.g., "Okay, I'll search for that.") in the `text` field.
3.  Parse this `text` using `extractLlmResponseAndScratchpad`. Since it's not JSON, the function returns the string as `userFacingMessage` and `null` for scratchpad/plan.
4.  Call `runToolAndGenerateResponse` from `src/loop/tool-execution.ts`, passing the `toolCall`, `AgentState`, clients, and the extracted `userFacingMessage` (the simple string).

**Step 3: Inside `runToolAndGenerateResponse` (Post-Tool Summarization)**

1.  **Initialization & History:**
    *   Store the incoming `userFacingMessage` (simple string from Step 2b).
    *   Add this simple message (if present) and the `functionCall` details to the history.
2.  **Tool Execution:** Call `executeToolCall` to run the tool function (e.g., `linear_search`). This returns the structured tool result and updates state.
3.  **History Update:** Add the structured tool result to history (`role: 'tool'`).
4.  **LLM Call 2 (Summarization):**
    *   Construct a new system prompt using `GEMINI_POST_TOOL_SYSTEM_INSTRUCTIONS`. This prompt explicitly asks the LLM to review the tool result and generate a **JSON object** (`{userFacingMessage, scratchpad, currentPlan}`) in its `text` response, summarizing the outcome.
    *   Call `geminiClient.generateContentWithTools` with the updated history and *no tools*.
5.  **Process Summarization Response:**
    *   Extract the `text` from the second LLM response.
    *   Pass this text to `extractLlmResponseAndScratchpad`. It now expects and parses the **JSON object** requested by the post-tool prompt.
    *   Extract `synthesizedTextOutput` (from `userFacingMessage` field), `synthesizedScratchpad` (from `scratchpad` field), and `synthesizedPlan` (from `currentPlan` field).
6.  **State Update & Final Output:**
    *   Update `AgentState` with the `synthesizedScratchpad` and `synthesizedPlan`.
    *   Add `synthesizedTextOutput` to history as the final assistant message for the turn.
    *   Construct the final `AgentTurnOutput`:
        *   `textResponse` is `synthesizedTextOutput`.
        *   `intent` is determined based on the tool outcome.
        *   `toolResult` includes details of the tool execution and the `synthesizedTextOutput` as its summary.
7.  **Save State & Return:** Save the final `AgentState`, return `{ agentState, turnOutput }`.

**Step 4: Back in `runConversationTurn` (Tool Call Path)**

1.  Receive the result from `runToolAndGenerateResponse`.
2.  Update its `finalAgentState`.
3.  Return the final `turnOutput` (containing the summarized tool result message).

## 4. State Management

*   State (`AgentState`) is persisted between turns in Redis, keyed by `sessionId`.
*   Includes `conversation_history`, `id_map`, `team_workflows`, `issue_team_map`, `staged_changes`, `llm_scratchpad`, `current_plan` (using the array-based `Plan` type), etc.
*   Core context is serialized and included in LLM prompts.
*   Tools like `linear_get_details` and staging operations can update the state.

## 5. Scratchpad

*   Intended as the LLM's internal monologue/working notes.
*   The LLM includes it in the `"scratchpad"` field of its JSON output (both in text-only responses and post-tool summarization).
*   `extractLlmResponseAndScratchpad` correctly parses this field.
*   The `llm_scratchpad` field in `AgentState` is updated accordingly.

## 6. Current Design Notes

*   **Unified JSON Output (Post-Tool):** The agent now consistently expects the LLM to produce a structured JSON object in its `text` field after executing a tool, containing the user message, scratchpad, and plan.
*   **Separate Simple Text Output (During Tool Call):** When initiating a tool call, the LLM provides only a simple user-facing string, cleanly separating the tool invocation from complex JSON generation.
*   **Type Consistency:** Type definitions for `Plan` (as `PlanStep[]`) and `StructuredLlmResponse` (using `scratchpad` and `currentPlan`) are now consistent across `state/types.ts`, `types/agent-output.ts`, and the parsing logic in `loop/state-helpers.ts`.
*   **Turn Structure:** The agent performs tool execution and summarization within a single `runConversationTurn` call from the user's perspective.

## 7. Areas for Future Review / Improvement

*   **Complex Plan Handling:** The current `Plan` type (array of steps) is relatively simple. More complex planning scenarios might require evolving the `Plan` structure and the LLM's interaction with it.
*   **Error Handling:** While basic error paths exist, robustness could be improved, especially for handling unexpected LLM responses or tool failures gracefully.
*   **Context Length Management:** As conversation history grows, strategies for summarizing or truncating history passed to the LLM will be necessary.
*   **Prompt Optimization:** Continuously refining prompts for clarity, efficiency, and reliability is an ongoing process.
*   **Observability:** Enhancing logging and tracing for easier debugging and performance monitoring. 