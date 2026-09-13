# TOTP Generator

A small, client-side time-based one-time password generator.

Enter a Base32-encoded shared secret to generate a six-digit TOTP code and a matching `otpauth://` QR code for authenticator apps.

## Features

- Six-digit codes that refresh every 30 seconds
- HMAC-SHA1 TOTP generation using the browser Web Crypto API
- QR code generation for authenticator app setup
- No backend or account required

## Usage

Open [`index.html`](./index.html) in a modern browser, or serve the project directory with any static HTTP server.

The app expects a Base32-encoded shared secret. Secrets are processed locally in the browser and are not sent to a server by this project.

## Development

Install the development dependency with pnpm:

```sh
pnpm install
```

Run the test suite:

```sh
pnpm test
```

## Compatibility

The generator requires a modern browser with support for `crypto.subtle` and the Canvas API.
