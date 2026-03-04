import { LinearClient } from '@linear/sdk';

/**
 * Initialize a Linear client with API key from environment variables
 * @returns Initialized Linear client
 */
export function createLinearClient(): LinearClient {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error('LINEAR_API_KEY environment variable is not set');
  }

  return new LinearClient({ 
    apiKey,
    apiUrl: 'https://api.linear.app/graphql'
  });
}

/**
 * Initialize a Linear client with OAuth token
 * @param accessToken The OAuth access token
 * @returns Initialized Linear client
 */
export function createLinearClientWithOAuth(accessToken: string): LinearClient {
  if (!accessToken) {
    throw new Error('Access token is required for OAuth authentication');
  }

  return new LinearClient({ accessToken });
}

/**
 * Get the appropriate Linear client based on available credentials
 * Prioritizes OAuth token over API key if both are available
 * @param oauthToken Optional OAuth token
 * @returns Initialized Linear client
 */
export function getLinearClient(oauthToken?: string): LinearClient {
  if (oauthToken) {
    return createLinearClientWithOAuth(oauthToken);
  }

  return createLinearClient();
}
