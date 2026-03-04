# Voca Agent Tool Return Pattern Analysis

## Rationale for Refactoring Tool Outputs

The current design of many Voca agent tools involves them returning pre-formatted natural language strings as their primary output (in fields like `output` or `toolOutput`). While sometimes accompanied by structured data, this pattern presents several challenges:

1.  **Violation of Single Responsibility Principle:** Tools are performing two jobs: executing their core logic (e.g., modifying state, fetching data) AND formatting user-facing messages.
2.  **Brittleness:** Relying on the LLM to parse or summarize these natural language strings is fragile. This was identified as a likely cause of the 500 Internal Server Error observed during the summarization step after `stage_add`.
3.  **Inconsistency:** Having each tool format its own messages leads to potential inconsistencies in tone and structure compared to having the central orchestrator manage user communication.
4.  **Difficult Testing:** Asserting the outcome of an agent turn often requires unreliable regex matching on the final LLM-generated natural language response.

**Proposed Improvement:**

Tools should be refactored to focus solely on their core task and return **structured data** to the orchestrator (agent loop). This structured data should clearly indicate:

*   **Success or Failure:** A simple boolean status.
*   **Relevant Data:** Any necessary information resulting from the tool's execution (e.g., fetched data, updated state object, confirmation details).
*   **(Optional but Recommended) Machine-Readable Intent/Outcome:** An enum or specific status code representing the precise outcome (e.g., `StagingOutcome.SUCCESS_ADDED`, `SearchOutcome.FOUND_RESULTS`, `ApplyOutcome.PARTIAL_FAILURE`).

**Benefits:**

*   **Robustness:** Eliminates the fragile LLM summarization step for simple tool results.
*   **Consistency:** The orchestrator can use the structured data to generate consistent user messages (potentially still using the LLM, but prompting it based on facts like "tool X succeeded" rather than asking it to summarize the tool's raw string output).
*   **Improved Testability:** Tests can make precise assertions against the structured success/failure status and the specific outcome enum, removing the need for brittle regex checks on natural language output.

This document analyzes the current state of the tools against this desired pattern.

---

This document analyzes the return patterns of the tools available to the Voca agent, specifically checking if they return pre-formatted natural language strings instead of purely structured data for success/failure and results. Returning natural language strings forces the agent loop/LLM to parse or summarize this string, which can be brittle, as seen with the `stage_add` 500 error reproduction.

## Summary

The following tools have been refactored to return structured data objects instead of pre-formatted natural language strings:
*   `linear_search`
*   `linear_get_details`
*   `stage_add`
*   `stage_list`
*   `stage_remove`
*   `stage_update`
*   `apply_staged_changes`

The `apply_staged_changes` tool still returns a natural language string in its `output` field.

## Tool Analysis

1.  **`linear_search`**
    *   **File:** `src/tools/linear_read.ts`
    *   **Returns:** `Promise<LinearSearchResult>` which includes:
        *   `success: boolean`
        *   `outcome: SearchOutcome` (enum: `FOUND_RESULTS`, `NO_RESULTS`, `ERROR_UNKNOWN`)
        *   `results: readonly SearchResultEntity[]` (array of found `Issue` objects)
        *   `updatedIdMap?: Record<string, LinearGuid>`
        *   `message?: string` (for errors)
    *   **Pattern:** Returns a structured object with search results and status. **Refactored.**

2.  **`linear_get_details`**
    *   **File:** `src/tools/linear_read.ts`
    *   **Returns:** `Promise<LinearDetailsResult>` which includes:
        *   `success: boolean`
        *   `outcome: DetailsOutcome` (enum: `FOUND_DETAILS`, `NOT_FOUND`, `ERROR_UNKNOWN`)
        *   `entity?: DetailedEntity` (the fetched `Issue` or `Project` object)
        *   `updatedIdMap?: Record<string, LinearGuid>`
        *   `updatedTeamWorkflows?: Record<string, TeamWorkflowContext>`
        *   `updatedIssueTeamMap?: Record<LinearGuid, LinearGuid>`
        *   `message?: string` (for errors)
    *   **Pattern:** Returns a structured object with entity details and status. **Refactored.**

3.  **`stage_add`**
    *   **File:** `src/tools/linear_stage.ts`
    *   **Returns:** `StageAddResult` which includes:
        *   `success: boolean`
        *   `newState: AgentState`
        *   `outcome: StageAddOutcome` (enum: `SUCCESS_ADDED`, `SUCCESS_REPLACED_EXISTING`, etc.)
        *   `tempId?: TemporaryFriendlyId`
        *   `message?: string` (for errors)
    *   **Pattern:** Returns a structured object with the new state and outcome status. **Refactored.**

4.  **`stage_list`**
    *   **File:** `src/tools/linear_stage.ts`
    *   **Returns:** `StageListResult` which includes:
        *   `success: boolean`
        *   `stagedChanges: readonly StagedChange[]`
        *   `message?: string` (for errors)
    *   **Pattern:** Returns a structured object with the list of staged changes. **Refactored.**

5.  **`stage_remove`**
    *   **File:** `src/tools/linear_stage.ts`
    *   **Returns:** `StageRemoveResult` which includes:
        *   `success: boolean`
        *   `newState: AgentState`
        *   `outcome: StageRemoveOutcome` (enum: `SUCCESS_REMOVED`, `ERROR_NOT_FOUND`, etc.)
        *   `removedTempId?: TemporaryFriendlyId`
        *   `message?: string` (for errors)
    *   **Pattern:** Returns a structured object with the new state and outcome status. **Refactored.**

6.  **`stage_update`**
    *   **File:** `src/tools/linear_stage.ts`
    *   **Returns:** `StageUpdateResult` which includes:
        *   `success: boolean`
        *   `newState: AgentState`
        *   `outcome: StageUpdateOutcome` (enum: `SUCCESS_UPDATED`, `ERROR_NOT_FOUND`, etc.)
        *   `updatedTempId?: TemporaryFriendlyId`
        *   `message?: string` (for errors)
    *   **Pattern:** Returns a structured object with the new state and outcome status. **Refactored.**

7.  **`apply_staged_changes`**
    *   **File:** `src/tools/linear_apply.ts`
    *   **Returns:** `Promise<ApplyStagedChangesResult>` which includes:
        *   `success: boolean` (Overall success indicator)
        *   `outcome: ApplyOutcome` (Enum: `SUCCESS_ALL_APPLIED`, `SUCCESS_PARTIAL_APPLIED`, `FAILURE_NONE_APPLIED`, `ERROR_PRECONDITION`, `ERROR_UNKNOWN`)
        *   `newState: AgentState` (The resulting agent state)
        *   `results: ApplyChangeDetail[]` (Array of detailed results for each change: `{ status: 'succeeded'|'failed'|'skipped', change: StagedChange, newId?: LinearGuid, reason?: string }`)
        *   `message?: string` (Optional message for overall errors)
    *   **Pattern:** Returns a structured object with detailed outcomes for each change, overall status, and the updated agent state. **Refactored.** 