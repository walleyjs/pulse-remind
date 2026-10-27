# Security Policy

PulseRemind takes the security and privacy of AI chat interactions, web monitoring, and temporal notifications seriously. We appreciate the community's efforts in identifying and responsibly disclosing vulnerabilities.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Scope & Threat Model

PulseRemind sits at the boundary between conversational AI models and external web state. We actively welcome vulnerability reports regarding:
- **Tenant Isolation & Boundary Leaks**: Unauthorized cross-tenant watch inspection or notification interception.
- **SSRF (Server-Side Request Forgery)**: Bypassing loopback or private network guards when the ResolutionEngine probes target URLs.
- **PII Scrubbing Failures**: Failures of the `PrivacyMinimizer` to scrub sensitive personal data (SSNs, phone numbers, raw credentials) from chat contexts.
- **Prompt Injection & Tool Manipulation**: Vulnerabilities where remote HTML state hijacks the LLM via tool output manipulation.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report vulnerabilities through one of the following methods:
1. **GitHub Private Vulnerability Reporting**: Open an advisory via the [Security tab](https://github.com/walleyjs/pulse-remind/security/advisories).
2. **Email**: Send encrypted or detailed disclosures to `security@pulseremind.org` (or directly via the primary maintainer's contact).

### What to Include in Your Report
- A detailed description of the vulnerability and its potential impact.
- Step-by-step reproduction instructions or a minimal Proof of Concept (PoC).
- Any proposed remediation or patches.

## Response SLA & Coordinated Disclosure

- **Initial Acknowledgement**: Within 48 hours of receipt.
- **Triage & Status Assessment**: Within 5 business days.
- **Remediation & Patch**: Targeted within 14 calendar days.
- **Public Disclosure**: We follow standard Coordinated Vulnerability Disclosure (CVD). Public advisories are issued after a patch is published and consumers have had reasonable time to upgrade.
