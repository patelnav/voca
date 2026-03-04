/**
 * Represents the structured response expected from the LLM, especially after processing tool outputs.
 */
export interface StructuredLlmResponse {
  /** The message to be shown to the user. */
  userFacingMessage: string;

  /** The LLM's updated internal scratchpad content. */
  scratchpadContent: string;

  /**
   * Optional. If the LLM intends to call a function, this object will contain the details.
   * This is based on common patterns but might need adjustment to fit the exact Gemini function calling structure if different.
   */
  // functionCall?: {
  //   name: string;
  //   arguments: Record<string, any>;
  // };

  // Ensure no other fields are present unless explicitly part of an evolving schema.
} 