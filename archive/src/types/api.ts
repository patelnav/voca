import type { Operation } from 'fast-json-patch';
import type { GeminiModelName } from '@/constants/llm';

export interface ApiResponse {
  tts_response: string;
  patches: Operation[];
  active_project?: string;
  conversation_summary?: string[]; // Array of important points from conversation history
}

export interface GeminiConfig {
  model: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
}

export type ModelName = GeminiModelName;

export interface APIResponse {
  tts_response: string;
  patches?: any[];
  active_project?: string;
}

export interface ConversationEntry {
  userCommand: string;
  assistantResponse: string;
  timestamp: Date;
}

export interface ConversationContext {
  history: ConversationEntry[];
  summary: string[];
}
