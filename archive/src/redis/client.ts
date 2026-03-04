import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
const redisPassword = process.env.REDIS_PASSWORD;

const redisOptions = {
  host: redisHost,
  port: redisPort,
  password: redisPassword,
  // Add other options like TLS if needed in the future
  maxRetriesPerRequest: null, // Recommended by ioredis docs for general use
};

// Initialize the Redis client
const redisClient = new Redis(redisOptions);

// Optional: Add basic error handling and connection logging
redisClient.on('connect', () => {
  console.log(`Connected to Redis at ${redisHost}:${redisPort}`);
});

redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

// Export the client instance for use in other parts of the application
export { redisClient }; 