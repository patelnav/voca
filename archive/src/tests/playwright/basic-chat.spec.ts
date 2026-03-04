import { test, expect } from '@playwright/test';

test.describe('Basic Chat Flow', () => {
  test('should allow a user to send a message and receive a response', async ({ page }) => {
    // 1. Navigate to the home page
    await page.goto('/');

    // 2. Find the chat input and type a message
    // Using aria-label as it's more specific from VocaClient.tsx
    const chatInput = page.locator('input[aria-label="User command input"], input[placeholder="Enter your command..."]');
    await expect(chatInput).toBeVisible({ timeout: 10000 }); // Wait for input to be visible
    await chatInput.fill('hello');

    // 3. Find and click the send button
    // Using text content as it's specified in VocaClient.tsx
    const sendButton = page.locator('button:has-text("Send")');
    await expect(sendButton).toBeVisible();
    await expect(sendButton).toBeEnabled(); // Ensure button is not disabled before clicking
    await sendButton.click();

    // 4. Wait for an assistant message to appear
    const assistantMessage = page.locator('.assistant-message, [data-testid^="assistant-message-"]').last();
    
    await expect(assistantMessage).toBeVisible({ timeout: 30000 });
    await expect(assistantMessage).not.toBeEmpty({ timeout: 30000 });

    // 5. Assert that the message is visible and has content
    console.log('Assistant response received:', await assistantMessage.textContent());
    expect(await assistantMessage.textContent()).not.toBeNull();
  });
}); 