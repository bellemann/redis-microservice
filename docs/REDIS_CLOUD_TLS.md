# Redis Cloud TLS Setup Guide

This guide explains how to enable TLS on your Redis Cloud database and connect to it securely.

## Important Note About Redis Cloud

**Redis Cloud is a managed service** - you don't have direct command-line access to the cluster master node. All configuration is done through the Redis Cloud web console.

The certificates we generated are for **client-side TLS authentication** (optional) or if you're running your own Redis Enterprise server.

## Current Connection

Your current Redis Cloud connection:
```
redis://default:BI8VVZQdFUMTyAlncGeSNnzAwecZIlGp@redis-12193.c311.eu-central-1-1.ec2.redns.redis-cloud.com:12193
```

## Option 1: Enable TLS on Redis Cloud (Recommended for Production)

### Step 1: Enable TLS in Redis Cloud Console

1. **Log in to Redis Cloud**: https://app.redislabs.com/
2. **Select your database** (redis-12193)
3. **Go to Configuration** → **Edit database**
4. **Security section**:
   - Enable **"TLS"** or **"SSL/TLS encryption"**
   - Redis Cloud will automatically provide server certificates
   - Save configuration

### Step 2: Get Your New TLS Connection Details

After enabling TLS, Redis Cloud will provide:
- A new connection URL starting with `rediss://` (note the double 's')
- Usually on a different port (often 12194 instead of 12193)
- Format: `rediss://default:password@redis-12193.c311.eu-central-1-1.ec2.redns.redis-cloud.com:12194`

### Step 3: Update Your `.env` File

Update your `.env` file with the new TLS connection URL:

```env
# Change from redis:// to rediss://
REDIS_URL=rediss://default:BI8VVZQdFUMTyAlncGeSNnzAwecZIlGp@redis-12193.c311.eu-central-1-1.ec2.redns.redis-cloud.com:12194

# For basic TLS (Redis Cloud manages certificates)
USE_REDIS_TLS=false
```

**That's it!** Redis Cloud's managed TLS will work automatically with the `rediss://` URL.

### Step 4: Test Your Connection

```bash
npm start
```

Your application should connect successfully with TLS enabled.

## Option 2: Client Certificate Authentication (Advanced - Mutual TLS)

If your Redis Cloud requires **client certificates** (mutual TLS), follow these additional steps:

### Step 1: Upload Client CA to Redis Cloud

1. In Redis Cloud console → Database Configuration
2. Enable **"Client Certificate Authentication"**
3. Upload `./certs/ca-cert.pem` as the trusted CA

### Step 2: Configure Your Application

Update your `.env` file:

```env
# Use the TLS connection URL
REDIS_URL=rediss://default:BI8VVZQdFUMTyAlncGeSNnzAwecZIlGp@redis-12193.c311.eu-central-1-1.ec2.redns.redis-cloud.com:12194

# Enable client certificates
USE_REDIS_TLS=true
REDIS_TLS_CA_CERT=./certs/ca-cert.pem
REDIS_TLS_CLIENT_CERT=./certs/redis-client-cert.pem
REDIS_TLS_CLIENT_KEY=./certs/redis-client-key.pem
```

### Step 3: Restart Your Application

```bash
npm start
```

You should see:
```
✓ Loaded Redis TLS CA certificate
✓ Loaded Redis TLS client certificate
✓ Loaded Redis TLS client key
✓ Redis TLS enabled
```

## Option 3: Basic TLS Without Certificates (Development)

For development/testing with Redis Cloud's managed TLS:

```env
# Just use rediss:// protocol - Redis Cloud handles everything
REDIS_URL=rediss://default:BI8VVZQdFUMTyAlncGeSNnzAwecZIlGp@redis-12193.c311.eu-central-1-1.ec2.redns.redis-cloud.com:12194

# No client certificates needed
USE_REDIS_TLS=false
```

The `ioredis` library will automatically use TLS when it sees the `rediss://` protocol.

## Testing TLS Connection

### Method 1: Using redis-cli

Test with redis-cli (if you have it installed):

```bash
# Non-TLS connection
redis-cli -u redis://default:password@redis-12193.c311.eu-central-1-1.ec2.redns.redis-cloud.com:12193 PING

# TLS connection
redis-cli -u rediss://default:password@redis-12193.c311.eu-central-1-1.ec2.redns.redis-cloud.com:12194 --tls PING
```

### Method 2: Using Your Application

Create a test script `test-redis-tls.js`:

```javascript
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redis = new Redis(process.env.REDIS_URL, {
  enableReadyCheck: false
});

redis.on('connect', () => {
  console.log('✓ Connected to Redis');
});

redis.on('ready', async () => {
  console.log('✓ Redis is ready');

  // Test command
  const result = await redis.ping();
  console.log('✓ PING response:', result);

  // Check connection info
  const info = await redis.info('server');
  console.log('\nRedis Server Info:');
  console.log(info.split('\n').slice(0, 5).join('\n'));

  await redis.quit();
  console.log('\n✓ Test completed successfully');
});

redis.on('error', (err) => {
  console.error('✗ Redis connection error:', err.message);
  process.exit(1);
});
```

Run it:

```bash
node test-redis-tls.js
```

## Troubleshooting

### Error: "ECONNREFUSED"

**Cause**: Wrong host or port
**Solution**: Double-check your Redis Cloud connection details

### Error: "certificate has expired" or "self signed certificate"

**Cause**: Using custom certificates with Redis Cloud's managed certificates
**Solution**:
- If using Redis Cloud's TLS: Set `USE_REDIS_TLS=false`
- Redis Cloud manages its own certificates automatically

### Error: "Client sent an HTTP request to an HTTPS server"

**Cause**: Using `redis://` instead of `rediss://` for TLS connection
**Solution**: Update URL to use `rediss://` protocol

### Error: "Connection timeout"

**Cause**: Firewall or incorrect port
**Solution**:
1. Verify the TLS port (usually different from non-TLS port)
2. Check Redis Cloud console for correct endpoint
3. Ensure your network allows outbound connections to the TLS port

### Warning: "unable to get local issuer certificate"

**Cause**: Missing CA certificate
**Solution**:
- For Redis Cloud managed TLS: No action needed, set `USE_REDIS_TLS=false`
- For client certificates: Provide `REDIS_TLS_CA_CERT` path

## Security Best Practices

1. **Always use TLS in production** - Protects data in transit
2. **Use environment variables** - Never commit credentials to git
3. **Rotate passwords regularly** - Update in Redis Cloud console
4. **Use client certificates for high security** - Adds mutual authentication
5. **Monitor connection logs** - Check for unauthorized access attempts

## Redis Cloud TLS Pricing

Check your Redis Cloud plan:
- **Free tier**: TLS may not be available
- **Paid plans**: TLS is typically included
- **Enterprise**: Full TLS with client certificate support

Check your specific plan at: https://redis.com/redis-enterprise-cloud/pricing/

## Summary

### Quick Setup (Most Common)

1. Enable TLS in Redis Cloud console
2. Get new `rediss://` connection URL
3. Update `.env` with new URL
4. Keep `USE_REDIS_TLS=false` (Redis Cloud manages certificates)
5. Restart your app

### For Mutual TLS (Advanced)

1. Enable TLS + Client Certificate Authentication in Redis Cloud
2. Upload `ca-cert.pem` to Redis Cloud
3. Update `.env` with `rediss://` URL
4. Set `USE_REDIS_TLS=true` and provide certificate paths
5. Restart your app

## Additional Resources

- [Redis Cloud Documentation](https://docs.redis.com/latest/rc/)
- [Redis Cloud Security](https://docs.redis.com/latest/rc/security/)
- [ioredis TLS Documentation](https://github.com/luin/ioredis#tls-options)
