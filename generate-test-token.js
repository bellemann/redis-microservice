#!/usr/bin/env node

/**
 * Generate JWT Test Token
 *
 * This script generates a JWT token for testing the Redis microservice.
 *
 * Usage:
 *   node generate-test-token.js [user_id] [role]
 *
 * Examples:
 *   node generate-test-token.js 123 user
 *   node generate-test-token.js 456 admin
 *   node generate-test-token.js 789 model
 */

import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();

// Get user_id and role from command line arguments
const userId = process.argv[2] || 'test-user-123';
const role = process.argv[3] || 'user';

// Check if JWT_SECRET is configured
if (!process.env.JWT_SECRET) {
  console.error('Error: JWT_SECRET not found in .env file');
  console.error('Please create a .env file with JWT_SECRET=your-secret-key');
  process.exit(1);
}

// Generate the JWT token
const payload = {
  user_id: userId,
  role: role
};

// Sign with 900 seconds (15 minutes) expiration
const token = jwt.sign(payload, process.env.JWT_SECRET, {
  expiresIn: 900
});

// Decode the token to show the full payload including exp
const decoded = jwt.decode(token);

// Output the results
console.log('\n=== JWT Token Generated ===\n');
console.log('User ID:', userId);
console.log('Role:', role);
console.log('Expires in: 900 seconds (15 minutes)');
console.log('\nToken:');
console.log(token);
console.log('\n=== Decoded Payload ===\n');
console.log(JSON.stringify(decoded, null, 2));
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
