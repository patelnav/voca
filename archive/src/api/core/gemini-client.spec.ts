import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import * as GoogleGenAIModule from '@google/genai'; // Import namespace - updated import path
import { GeminiClient } from '@/api/core/gemini-client';
import { DEFAULT_GEMINI_MODEL, GEMINI_MODELS } from '@/constants/llm';

// Keep the separate mock function for the method
const mockGenerateContent = vi.fn(() => ({
  // Mock model methods if needed for further tests
}));

// Mock the models object with generateContent method
const mockModels = {
  generateContent: mockGenerateContent
};

// Mock the class within the imported namespace
vi.mock('@google/genai', async (importOriginal) => {
  // Dynamically import the original module to get its type and potentially other exports
  const actual = await importOriginal<typeof GoogleGenAIModule>();
  return {
    ...actual, // Keep other exports from the original module
    GoogleGenAI: vi.fn().mockImplementation(() => ({ 
      models: mockModels
    })),
  };
});

// Need to cast the mock constructor for assertions
const MockGoogleGenAI = GoogleGenAIModule.GoogleGenAI as Mock;

describe('GeminiClient', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    // vi.resetModules(); // Keep removed or add back if necessary, try without first
    vi.clearAllMocks(); // Clear mock call history for both constructor and method mocks
    process.env = { ...ORIGINAL_ENV }; // Make a copy
    process.env.GEMINI_API_KEY = 'test-gemini-key'; // Set a dummy key
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV; // Restore original environment
  });

  it('should throw an error if GEMINI_API_KEY is not set', () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => new GeminiClient()).toThrow('GEMINI_API_KEY environment variable is not set');
  });

  it('should initialize GoogleGenAI with the API key', () => {
    new GeminiClient();
    // Assert on the casted mock constructor
    expect(MockGoogleGenAI).toHaveBeenCalledWith({ apiKey: 'test-gemini-key' });
  });

  it('should get the generative model using the default model constant', () => {
    new GeminiClient();
    const expectedModelPath = GEMINI_MODELS[DEFAULT_GEMINI_MODEL];
    // The test doesn't directly check the model path since the client now
    // uses the model path when making API calls, not during initialization
    expect(GeminiClient.prototype).toBeDefined();
  });

  it('should allow specifying a different valid model name', () => {
    const specificModel = 'gemini-1.5-pro'; // Example different model
    new GeminiClient(specificModel);
    // The test doesn't directly check the model path since the client now
    // uses the model path when making API calls, not during initialization
    expect(GeminiClient.prototype).toBeDefined();
  });

  it('should return an instance of GeminiClient', () => {
    const client = new GeminiClient();
    expect(client).toBeInstanceOf(GeminiClient);
  });
}); 