# Contributing to Zero

Thank you for your interest in contributing to Zero!

## Requirements

- Node.js 20+
- Browser with WebGPU support (Chrome 121+, Safari 18+, Firefox Nightly)
- Git with commit signing configured

## Getting Started

```bash
git clone https://github.com/hypatia-earth/zero.git
cd zero
npm install
npm run dev
```

Open http://localhost:5173 for basic development.

### HTTPS (Required for some features)

These features require HTTPS:
- Service Worker (data caching)
- PWA installation
- Geolocation

To enable HTTPS:

```bash
# Create certs directory (one level up from zero/)
mkdir -p ../certs
cd ../certs

# Generate self-signed certificate
openssl req -x509 -newkey rsa:2048 -keyout hypatia-key.pem -out hypatia.pem \
  -days 365 -nodes -subj "/CN=localhost"
```

Then open https://localhost:5173 and accept the self-signed certificate warning.

## Development

### Code Quality

Before submitting a PR, ensure all checks pass:

```bash
npm run quality
```

This runs TypeScript type checking and linting.

### Shader Development

WGSL shaders are in `src/render/shaders/`. Edit source files, not generated ones:
- Edit: `*.wgsl` (source files)
- Don't edit: `zero-main.wgsl`, `zero-post.wgsl` (auto-generated)

Shaders rebuild automatically in dev mode.

## Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run `npm run quality` and fix any issues
5. Commit with a signed commit (`git commit -S -m "Description"`)
6. Push and open a PR

### Commit Signing

All commits must be signed. [GitHub's guide on signing commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits).

### Commit Messages

- Use present tense ("Add feature" not "Added feature")
- Keep first line under 72 characters
- Reference issues when applicable (`Fixes #123`)

## Issues

- **Bugs**: Include browser, OS, and steps to reproduce
- **Features**: Describe the use case and expected behavior

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
