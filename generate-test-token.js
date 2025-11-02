#!/usr/bin/env node

/**
 * Generate JWT Test Token
 *
 * This script generates a JWT token for testing the Redis microservice.
 *
 * Usage:
 *   node generate-test-token.js [user_id]
 *
 * Example:
 *   node generate-test-token.js 123
 */

import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();

// Get user_id from command line argument, default to 'test-user-123'
const userId = process.argv[2] || 'test-user-123';

// Check if JWT_SECRET is configured
if (!process.env.JWT_SECRET) {
  console.error('Error: JWT_SECRET not found in .env file');
  console.error('Please create a .env file with JWT_SECRET=your-secret-key');
  process.exit(1);
}

// Generate the JWT token
const payload = {
  user_id: userId,
  iat: Math.floor(Date.now() / 1000)
};

const token = jwt.sign(payload, process.env.JWT_SECRET);

// Output the results
console.log('\n=== JWT Token Generated ===\n');
console.log('User ID:', userId);
console.log('\nToken:');
console.log(token);
console.log('\n=== Decoded Payload ===\n');
console.log(JSON.stringify(payload, null, 2));
console.log('\n=== Test with cURL ===\n');
console.log('# Health check (no auth required)');
console.log('curl http://localhost:3000/ping\n');
console.log('# Whoami (check token)');
console.log(`curl -H "Authorization: Bearer ${token}" http://localhost:3000/whoami\n`);
console.log('# Debug auth (test key resolution)');
console.log(`curl -H "Authorization: Bearer ${token}" \\
  http://localhost:3000/debug-auth\n`);
console.log('# Execute Redis command');
console.log(`curl -X POST \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '[["GET", "user:AUTH:following"]]' \\
  http://localhost:3000/\n`);
console.log('# Get user hash data');
console.log(`curl -X POST \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '[["HGETALL", "user:AUTH"]]' \\
  http://localhost:3000/\n`);
