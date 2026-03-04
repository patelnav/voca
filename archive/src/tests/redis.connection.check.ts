import { redisClient } from '@/redis/client';
import dotenv from 'dotenv';

dotenv.config(); // Load .env for potential connection details

async function testRedisConnection() {
  console.log('Attempting to ping Redis...');
  try {
    const reply = await redisClient.ping();
    if (reply === 'PONG') {
      console.log('Redis connection successful! Received:', reply);
      // Exit successfully, but ensure client disconnects gracefully
      await redisClient.quit();
      process.exit(0);
    } else {
      console.error('Unexpected reply from Redis:', reply);
      await redisClient.quit();
      process.exit(1);
    }
  } catch (error) {
    console.error('Failed to connect to Redis:', error);
    // No need to quit if connection failed initially
    process.exit(1);
  }
}

testRedisConnection(); 