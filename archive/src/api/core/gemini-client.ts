import { 
    GoogleGenAI, 
    type Content, 
    type Tool, 
    type GenerateContentParameters,
    type GenerateContentResponse as SDKGenerateContentResponse,
    type Part, 
    HarmCategory, 
    HarmBlockThreshold,
    type GenerateContentConfig
} from '@google/genai';
import { 
  type ILLMClient, 
  type RawResponse, 
  type ChatResponse, 
  type ChatMessage,
  type GenerationConfig as InternalGenerationConfig
} from '@/api/core/interfaces';
import { logger } from '@/utils/logger';
import { saveDiagnosticData } from '@/linear/staging-transformer/json-utils';
import { DEFAULT_GEMINI_MODEL, GeminiModelName, GEMINI_MODELS } from '../../constants/llm';

/**
 * Default configuration values for Gemini API calls
 */
const DEFAULT_CONFIG_INTERNAL: InternalGenerationConfig = {
  temperature: 0.2,
  maxOutputTokens: 8192,
  topP: 0.95,
  topK: 64
};

/**
 * Maps our internal ChatMessage roles to Gemini API roles.
 * Handles 'user', 'assistant' -> 'model', and potentially 'tool' -> 'function'.
 * @param messages Internal chat history
 * @returns Gemini SDK compatible Content array
 */
function mapInternalHistoryToSdkContent(messages: ChatMessage[]): Content[] {
  return messages
    .map((msg): Content | null => {
      if (msg.role === 'user') {
        // Use msg.parts directly if available, otherwise fallback to content
        const partsToUse = msg.parts ?? (msg.content ? [{ text: msg.content }] : []);
        if (partsToUse.length === 0) {
            logger.logCli(`[WARN] User message has no content or parts: ${JSON.stringify(msg)}`);
            return null; // Skip empty messages
        }
        return { role: 'user', parts: partsToUse };
      } else if (msg.role === 'assistant') { // Map assistant to model
         // Use msg.parts directly if available, otherwise fallback to content
         // If content exists, attempt to parse for function calls
        let partsToUse: Part[] = [];
        if (msg.parts) {
            partsToUse = msg.parts;
        } else if (msg.content) {
            try {
                // Attempt to parse content as JSON containing parts or functionCall
                const parsedContent = JSON.parse(msg.content);
                if (parsedContent && Array.isArray(parsedContent.parts)) {
                    partsToUse = parsedContent.parts;
                } else if (parsedContent && typeof parsedContent === 'object' && parsedContent.functionCall) {
                    partsToUse = [{ functionCall: parsedContent.functionCall }];
                } else {
                    // Not structured JSON, treat as simple text
                    partsToUse = [{ text: msg.content }];
                }
            } catch (e) {
                // Parsing failed, treat as simple text
                partsToUse = [{ text: msg.content }];
            }
        }

        if (partsToUse.length === 0) {
            logger.logCli(`[WARN] Assistant/Model message has no content or parts: ${JSON.stringify(msg)}`);
            return null; // Skip empty messages
        }
        return { role: 'model', parts: partsToUse }; // Use 'model' role for SDK
      } else if (msg.role === 'tool') { // Map tool to function
        // Use msg.parts directly if available, otherwise fallback to content
        let partsToUse: Part[] = [];
        if (msg.parts) {
            // Ensure parts contain a functionResponse
            if (msg.parts.some((p: Part) => p.functionResponse)) {
                partsToUse = msg.parts;
            } else {
                logger.logCli(`[WARN] Tool/Function message parts missing functionResponse: ${JSON.stringify(msg)}`);
                return null;
            }
        } else if (msg.content) {
            // Attempt to parse content as {name: string, output: any}
            try {
                const toolResult = JSON.parse(msg.content);
                if (toolResult && toolResult.name && toolResult.output !== undefined) {
                    partsToUse = [{
                        functionResponse: {
                            name: toolResult.name,
                            response: toolResult.output, // Ensure output is mapped correctly
                        },
                    }];
                } else {
                     logger.logCli(`[WARN] Malformed tool/function message content (parsed, but invalid): ${msg.content}`);
                     return null;
                }
            } catch (e) {
                logger.logError(e as Error, 'Failed to parse tool/function message content. Content: ' + msg.content);
                return null;
            }
        } 

        if (partsToUse.length === 0) {
            logger.logCli(`[WARN] Tool/Function message has no content or parts: ${JSON.stringify(msg)}`);
            return null; // Skip empty messages
        }
        return { role: 'function', parts: partsToUse }; // Use 'function' role for SDK
      } else if (msg.role === 'system') {
        // System messages are handled separately, return null here
        logger.logCli(`[DEBUG MAPPER] Ignoring 'system' role in mapInternalHistoryToSdkContent.`);
        return null;
      }
      // Fallback for unknown roles (shouldn't happen with TS)
      logger.logCli(`[WARN] Unknown message role encountered in mapInternalHistoryToSdkContent: ${msg.role}`);
      return null;
    })
    .filter((msg): msg is Content => msg !== null);
}

/**
 * Clean implementation of the ILLMClient interface for Gemini API
 * Handles the raw API communication without any domain-specific logic
 */
export class GeminiClient implements ILLMClient {
  private genAI: GoogleGenAI;
  private modelName: GeminiModelName; // Store model name for requests
  private modelPath: string;        // Store resolved model path
  private debug: boolean;
  
  /**
   * Create a new GeminiClient instance
   * @param modelName The model name to use
   * @param debug Whether to enable debug logging
   */
  constructor(modelName: GeminiModelName = DEFAULT_GEMINI_MODEL, debug: boolean = false) {
    this.debug = debug;
    this.modelName = modelName;
    this.modelPath = GEMINI_MODELS[this.modelName];
    
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }
    
    try {
      this.genAI = new GoogleGenAI({ apiKey });
      
      if (this.debug) {
        logger.logCli(`Initialized GeminiClient with model path: ${this.modelPath}`);
      }
    } catch (error) {
      logger.logError(error as Error, 'Error initializing GeminiClient');
      throw error;
    }
  }

  /**
   * Sends content generation request with support for multiple tools.
   * Directly uses the underlying SDK's generateContent method.
   *
   * @param history Internal ChatMessage history.
   * @param tools Optional array of Tool definitions (using SDK types).
   * @param config Optional GenerationConfig.
   * @param safetySettings Optional safety settings for the SDK
   * @returns The raw GenerateContentResult from the SDK.
   */
  async generateContentWithTools(
    history: ChatMessage[],
    tools?: Tool[],
    config: InternalGenerationConfig = DEFAULT_CONFIG_INTERNAL,
    safetySettings?: Array<{ category: HarmCategory; threshold: HarmBlockThreshold }>,
  ): Promise<SDKGenerateContentResponse> {
    const startTime = Date.now();

    let systemInstructionText: string | undefined = undefined;
    let messagesForSdkMapping = history;

    if (history.length > 0 && history[0].role === 'system') {
      systemInstructionText = history[0].content;
      messagesForSdkMapping = history.slice(1); 
      if (this.debug) {
        logger.logCli(`[GeminiClient GENTOOLS DBG] Extracted system instruction: "${systemInstructionText.substring(0,100)}..."`);
      }
    }

    const sdkHistory = mapInternalHistoryToSdkContent(messagesForSdkMapping);
    const { temperature, maxOutputTokens, topP, topK } = config;

    // Prepare the GenerateContentConfig object
    const sdkGenerationConfig: GenerateContentConfig = {
      temperature,
      maxOutputTokens,
      topP,
      topK,
      ...(tools && tools.length > 0 && { tools }), // Reverted to original spread
      ...(safetySettings && safetySettings.length > 0 && { safetySettings }),
      ...(systemInstructionText && { systemInstruction: { parts: [{ text: systemInstructionText }] } }), 
    };

    // Construct the parameters for the API call
    // GenerateContentParameters has 'contents' and 'config' (of type GenerateContentConfig)
    const parameters: GenerateContentParameters = {
      model: this.modelPath, // model is a direct property of GenerateContentParameters
      contents: sdkHistory,
      config: sdkGenerationConfig, // Pass the assembled GenerateContentConfig here
    };

    if (this.debug) {
        logger.logCli(`[GeminiClient GENTOOLS DBG] SDK History (${sdkHistory.length}):\\\\n${JSON.stringify(sdkHistory, null, 2)}`);
        if (tools) {
            logger.logCli(`[GeminiClient GENTOOLS DBG] Tools provided:\\\\n${JSON.stringify(tools.map(t => ({name: t.functionDeclarations?.[0]?.name, desc: t.functionDeclarations?.[0]?.description?.substring(0,30)})), null, 2)}`);
        }
        const loggableSdkConfig = { ...sdkGenerationConfig };
        saveDiagnosticData({ history: sdkHistory, config: loggableSdkConfig, tools }, 'gemini-gentools-input');
    }
    
    logger.saveApiLog('gemini-gentools-request', { context: '[GeminiClient.generateContentWithTools] Request', history: sdkHistory, config: sdkGenerationConfig });

    try {
      const result: SDKGenerateContentResponse = await this.genAI.models.generateContent(parameters);
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      logger.saveApiLog('gemini-gentools-response', { context: '[GeminiClient.generateContentWithTools] Response', duration, response: result });

      if (this.debug) {
        saveDiagnosticData({ response: result, duration }, 'gemini-gentools-output');
      }
      return result;
    } catch (error: any) {
      logger.logError(error as Error, 'Error in GeminiClient.generateContentWithTools');
      const loggableConfigOnError = {
        ...sdkGenerationConfig
      };
      saveDiagnosticData({ error: (error instanceof Error) ? error.message : String(error), history: sdkHistory, config: loggableConfigOnError, tools }, 'gemini-gentools-error');
      
      if (error instanceof Error) {
        throw new Error(`Gemini API Error in generateContentWithTools: ${error.message}`);
      } else {
        throw new Error(`Unknown error in Gemini API generateContentWithTools: ${String(error)}`);
      }
    }
  }

  /**
   * Send a simple prompt to the LLM and get a text response
   * @param prompt The text prompt to send
   * @param config Optional configuration for generation
   * @returns A raw response with the generated text
   */
  async sendPrompt(prompt: string, config: InternalGenerationConfig = DEFAULT_CONFIG_INTERNAL): Promise<RawResponse> {
    const sdkConfig: GenerateContentConfig = { ...config };
    const result: SDKGenerateContentResponse = await this.genAI.models.generateContent({
        model: this.modelPath,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: sdkConfig
    });
    let combinedText = '';
    if (result.candidates && result.candidates.length > 0 && result.candidates[0].content && result.candidates[0].content.parts) {
        result.candidates[0].content.parts.forEach((part: Part) => {
            if (part.text) {
                combinedText += part.text + ' ';
            }
        });
    }
    return { text: combinedText.trim() };
  }

  /**
   * Send a chat-style conversation
   * @param messages Array of chat messages with roles ('user', 'assistant', 'system')
   * @param config Optional configuration for generation
   * @returns A response with the chat completion
   */
  async sendChat(
    messages: ChatMessage[],
    config: InternalGenerationConfig = DEFAULT_CONFIG_INTERNAL
  ): Promise<ChatResponse> {
    const sdkHistory = mapInternalHistoryToSdkContent(messages);
    const sdkConfig: GenerateContentConfig = { ...config };
    const result: SDKGenerateContentResponse = await this.genAI.models.generateContent({
        model: this.modelPath,
        contents: sdkHistory,
        config: sdkConfig
    });
    
    let combinedText = '';
    if (result.candidates && result.candidates.length > 0 && result.candidates[0].content && result.candidates[0].content.parts) {
        result.candidates[0].content.parts.forEach((part: Part) => {
            if (part.text) {
                combinedText += part.text + ' ';
            }
        });
    }
    const responseText = combinedText.trim();
    return { text: responseText, messages: [...messages, { role: 'assistant', content: responseText }] }; 
  }

  // TODO: Consider adding input validation for messages/history

  // Consider removing or implementing this if needed for schema validation/logging
  /*
  private validateToolSchema(tool: Tool): void {
      if (!tool.functionDeclarations || tool.functionDeclarations.length === 0) {
          throw new Error('Tool must have at least one function declaration.');
      }
      for (const funcDecl of tool.functionDeclarations) {
          if (!funcDecl.name || !funcDecl.description || !funcDecl.parameters) {
              throw new Error(`Invalid function declaration: ${JSON.stringify(funcDecl)}. Missing name, description, or parameters.`);
          }
          // Add more specific schema validation if needed (e.g., checking parameter types)
      }
  }
  */

    // Removed commented-out logRequestDetails function
} 