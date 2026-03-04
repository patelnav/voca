import type { Part } from '@google/genai';

/**
 * Core interfaces for LLM clients
 * These interfaces define the contract between the application and various LLM providers
 */

/**
 * Generic response from any LLM
 */
export interface RawResponse {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Function call parameters structure
 */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

/**
 * Response specifically for function calls
 */
export interface FunctionCallResponse {
  functionName: string;
  functionArgs: Record<string, any>;
  rawResponse: any;
}

/**
 * Chat message structure
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  parts?: Part[];
}

/**
 * Response for chat-based interactions
 */
export interface ChatResponse extends RawResponse {
  messages: ChatMessage[];
}

/**
 * Configuration for model generation
 */
export interface GenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
}

/**
 * Base interface for all LLM clients
 */
export interface ILLMClient {
  /**
   * Send a simple prompt to the LLM and get a text response
   * @param prompt The text prompt to send
   * @param config Optional generation configuration
   */
  sendPrompt(prompt: string, config?: GenerationConfig): Promise<RawResponse>;
  
  /**
   * Send a chat-style conversation
   * @param messages Array of chat messages with roles
   * @param config Optional generation configuration
   */
  sendChat(
    messages: ChatMessage[],
    config?: GenerationConfig
  ): Promise<ChatResponse>;
} 