# Security Policy

## Supported Versions

The following versions of PipeProxy are currently being supported with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0.0 | :x:                |

## Reporting a Vulnerability

We take the security of PipeProxy seriously. If you believe you have found a security vulnerability, please **do not report it via a public issue**. 

Instead, please use the **GitHub Private Vulnerability Reporting** feature of this repository to report issues securely. This allows you to collaborate with us privately on a fix without disclosing the vulnerability or your contact information publicly.

### What to include in your report:
- A description of the vulnerability.
- A proof-of-concept or steps to reproduce.
- Potential impact if exploited.

### Disclosure Policy
When a vulnerability is reported, we will:
1. Confirm the vulnerability and its impact.
2. Work on a fix.
3. Release a new version with the fix.
4. Publicly disclose the vulnerability with credit to the researcher (if desired).

## Security Features of PipeProxy
- **AES-256-GCM Encryption**: All tunnel traffic is encrypted end-to-end.
- **Session-Based Keys**: Unique encryption keys are derived for every connection session.
- **SSRF Protection**: Built-in blocking for local network access attempts.
- **DoS Mitigations**: Rate limiting, Slowloris protection, and OOM prevention.

Thank you for helping keep PipeProxy secure!
