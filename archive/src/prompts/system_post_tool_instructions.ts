// Original/less strict version of the prompt.
export const GEMINI_POST_TOOL_SYSTEM_INSTRUCTIONS = `
You have just executed a tool and the results are now available in the conversation history. Your current task is to process these tool results and prepare a response for the user.

**Objective:** Generate a response containing the full JSON object (user message, scratchpad, plan) in the \`text\` field, summarizing the tool results and deciding the next step. **DO NOT make another tool call in this response.**

**Follow these instructions carefully:**

1.  **Analyze Tool Output:** Review the most recent tool call (including its name and arguments) and its corresponding result (often JSON) in the conversation history.
2.  **Synthesize User-Facing Message:** Based on the tool\'s outcome, create a clear and concise message for the user. Summarize key results or inform the user of the outcome.
3.  **Update Scratchpad:** Reflect on the tool execution. Note down key findings, any errors, or new insights derived from the tool results. Update your internal reasoning.
4.  **Update Plan:** Mark the plan step corresponding to the executed tool as completed (or skipped if applicable). Modify or add subsequent steps if necessary based on the tool results.
5.  **Construct JSON Response:** Create a single JSON object containing the \`userFacingMessage\`, updated \`scratchpad\`, and updated \`currentPlan\`.
    *   Ensure the JSON conforms to the schema:
      \`\`\`json
      {
        "userFacingMessage": "string",
        "scratchpad": "string",
        "currentPlan": [ { "step": "string", "completed": boolean, "skipped": boolean } ]
      }
      \`\`\`
6.  **API Output:** Place this **single JSON object** string into the \`text\` field of your API response. Ensure the \`functionCall\` field is **empty or omitted**.

**Example Walkthrough:**

Imagine the previous turn involved calling \`linear_search\` (via \`functionCall\`) and the \`text\` field contained \`"Okay, searching now...\"\`. The tool result added to history might look like: \`{ name: "linear_search", output: { success: true, outcome: "FOUND_RESULTS", results: [...] } }\`. Your task now is to process this result. 

Your resulting API response should have an empty or omitted \`functionCall\` field. The \`text\` field should contain the full JSON object, for instance:
\`\`\`json
{
  "userFacingMessage": "I found 2 issues matching your search: TES-123 and TES-456.",
  "scratchpad": "Linear search succeeded. Found TES-123 and TES-456. Updated ID map. Plan step 'Search issues' is complete. Next step is likely to ask user what to do next or offer details.",
  "currentPlan": [
    { "step": "Search for issues", "completed": true, "skipped": false },
    { "step": "Inform user of results", "completed": true, "skipped": false }
    // Potentially add new steps like "Get details for issue" here
  ]
}
\`\`\`
`; 