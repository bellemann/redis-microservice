# TLS Certificate Setup for Redis Cloud

This guide explains how to generate and use TLS certificates for secure Redis connections.

## Quick Start

Generate certificates with default settings (2 years validity):

```bash
./scripts/generate-certs.sh
```

The certificates will be created in the `./certs` directory.

## Custom Certificate Generation

### Specify Validity Period

Generate certificates valid for 3 years:

```bash
./scripts/generate-certs.sh -d 1095
```

Generate certificates valid for 5 years:

```bash
./scripts/generate-certs.sh -d 1825
```

### Specify Custom Domain

```bash
./scripts/generate-certs.sh -f my-redis.example.com -d 730
```

### Custom Output Directory

```bash
./scripts/generate-certs.sh -o /path/to/custom/certs
```

## Certificate Files Explained

After generation, you'll have these files:

### CA (Certificate Authority) Files
- **ca-cert.pem** - Root CA certificate (share this with clients)
- **ca-key.pem** - CA private key (keep this secure, never share!)

### Server Certificates
- **redis-server-cert.pem** - Server certificate
- **redis-server-key.pem** - Server private key
- **redis-server-bundle.pem** - Server certificate + CA chain (recommended for upload)

### Client Certificates
- **redis-client-cert.pem** - Client certificate
- **redis-client-key.pem** - Client private key
- **redis-client-bundle.pem** - Client certificate + CA chain

## Using Certificates with Redis Cloud

### 1. Upload to Redis Cloud

1. Log in to your Redis Cloud console
2. Navigate to your database settings
3. Enable TLS/SSL
4. Upload the following files:
   - **CA Certificate**: `ca-cert.pem`
   - **Server Certificate**: `redis-server-bundle.pem`
   - **Server Private Key**: `redis-server-key.pem`

### 2. Configure Client Mutual TLS (mTLS)

If your Redis Cloud requires client certificates (mutual TLS):

1. Enable "Client Certificate Authentication" in Redis Cloud
2. Upload `ca-cert.pem` as the trusted CA
3. Use `redis-client-cert.pem` and `redis-client-key.pem` in your application

## Using Certificates in Node.js

### Basic TLS Connection

```javascript
const Redis = require('ioredis');
const fs = require('fs');

const redis = new Redis({
  host: 'your-redis-host.example.com',
  port: 6380,
  tls: {
    ca: fs.readFileSync('./certs/ca-cert.pem'),
    rejectUnauthorized: true
  }
});
```

### Mutual TLS (mTLS) Connection

```javascript
const Redis = require('ioredis');
const fs = require('fs');

const redis = new Redis({
  host: 'your-redis-host.example.com',
  port: 6380,
  tls: {
    ca: fs.readFileSync('./certs/ca-cert.pem'),
    cert: fs.readFileSync('./certs/redis-client-cert.pem'),
    key: fs.readFileSync('./certs/redis-client-key.pem'),
    rejectUnauthorized: true
  }
});

redis.on('connect', () => {
  console.log('Connected to Redis with mTLS');
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});
```

### Using with Environment Variables

Update your [.env](.env) file:

```env
REDIS_TLS_CA_CERT=./certs/ca-cert.pem
REDIS_TLS_CLIENT_CERT=./certs/redis-client-cert.pem
REDIS_TLS_CLIENT_KEY=./certs/redis-client-key.pem
```

Then in your code:

```javascript
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT || '6380'),
  tls: {
    ca: fs.readFileSync(process.env.REDIS_TLS_CA_CERT),
    cert: fs.readFileSync(process.env.REDIS_TLS_CLIENT_CERT),
    key: fs.readFileSync(process.env.REDIS_TLS_CLIENT_KEY),
    rejectUnauthorized: true
  }
});
```

## Certificate Information

The generated certificates include:

- **Organization**: Bellemann UG
- **Location**: Walldorf, DE
- **Organizational Unit**: DEVELOPMENT
- **Hash Algorithm**: SHA-256 (strong, widely supported)
- **Key Size**: 2048-bit RSA
- **Default Validity**: 730 days (2 years)

## Viewing Certificate Details

Check certificate expiration date:

```bash
openssl x509 -in certs/redis-server-cert.pem -noout -enddate
```

View full certificate details:

```bash
openssl x509 -in certs/redis-server-cert.pem -noout -text
```

Verify certificate chain:

```bash
openssl verify -CAfile certs/ca-cert.pem certs/redis-server-cert.pem
```

## Security Best Practices

1. **Private Keys**: Never commit `*-key.pem` files to version control
2. **CA Key**: Store `ca-key.pem` securely, it can sign new certificates
3. **File Permissions**: Private keys have 600 permissions (owner read/write only)
4. **Certificate Rotation**: Renew certificates before they expire
5. **Production**: Consider using certificates from a trusted CA for production

## Troubleshooting

### "certificate has expired" Error

Generate new certificates with:

```bash
./scripts/generate-certs.sh -d 1095  # 3 years
```

### "unable to verify the first certificate" Error

Ensure you're using the certificate bundle:
- Use `redis-server-bundle.pem` (includes CA chain)
- Or provide `ca-cert.pem` separately

### "self signed certificate in certificate chain" Warning

This is expected with self-signed certificates. Options:
1. Add `ca-cert.pem` to your system's trusted certificates
2. Keep `rejectUnauthorized: true` and provide the CA cert explicitly
3. For development only: set `rejectUnauthorized: false` (not recommended)

### Connection Timeout with TLS

1. Verify Redis is configured for TLS on the correct port (usually 6380)
2. Check firewall rules allow the TLS port
3. Ensure the hostname matches the certificate CN or SAN entries

## Certificate Renewal

When certificates are about to expire:

1. Generate new certificates:
   ```bash
   ./scripts/generate-certs.sh -d 1095 -o ./certs-new
   ```

2. Test with new certificates in a staging environment

3. Replace old certificates:
   ```bash
   mv ./certs ./certs-old
   mv ./certs-new ./certs
   ```

4. Update Redis Cloud with new certificates

5. Restart your applications to load new certificates

## Additional Resources

- [Redis TLS Documentation](https://redis.io/docs/management/security/encryption/)
- [ioredis TLS Options](https://github.com/luin/ioredis#tls-options)
- [OpenSSL Certificate Guide](https://www.openssl.org/docs/man1.1.1/man1/openssl-x509.html)
