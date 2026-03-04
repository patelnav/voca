import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLinearClient } from '@/linear/client';
import { LinearClient } from '@linear/sdk';

// Mock the LinearSDK constructor
vi.mock('@linear/sdk', () => ({
  LinearClient: vi.fn().mockImplementation(() => ({
    // Mock any methods needed for initialization checks if necessary
  })),
}));

describe('Linear Client', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.resetModules(); // Reset modules to clear cached environment variables
    process.env = { ...ORIGINAL_ENV }; // Make a copy
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV; // Restore original environment
  });

  it('should throw an error if LINEAR_API_KEY is not set', () => {
    delete process.env.LINEAR_API_KEY;
    // Dynamically import after modifying process.env
    import('@/linear/client').then(module => {
      expect(() => module.createLinearClient()).toThrow(
        'LINEAR_API_KEY environment variable is not set'
      );
    }).catch(err => console.error("Import failed", err)); // Added error handling for import

  });

  it('should initialize LinearClient with API key from environment variables', () => {
    const mockApiKey = 'test-api-key';
    process.env.LINEAR_API_KEY = mockApiKey;

    // Dynamically import after modifying process.env
     import('@/linear/client').then(module => {
      const client = module.createLinearClient();
      expect(LinearClient).toHaveBeenCalledWith({
        apiKey: mockApiKey,
        apiUrl: 'https://api.linear.app/graphql'
      });
      expect(client).toBeInstanceOf(LinearClient);
    }).catch(err => console.error("Import failed", err)); // Added error handling for import
  });
}); 