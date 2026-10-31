# Security policy

Zephium's backend handles accounts, payments and AI usage for real customers. We appreciate responsible reports.

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** button on the repository's Security tab (private vulnerability reporting), or email security@zephium.app. Do not open public issues, pull requests or discussions for security problems.

Include the affected endpoint or component, reproduction steps against your own account, and the impact you observed. We aim to acknowledge reports within three business days and to share a remediation plan once the issue is confirmed.

## Scope and rules

- Test only against accounts you own. Do not access, modify or exfiltrate other users' data.
- Do not run denial-of-service, load or spam tests, and do not attack payment, email or model providers.
- Never submit real payment card data other than your own purchases; do not attempt refunds or chargebacks as a test.
- Stop and report as soon as you confirm an issue; do not pivot further.

Good-faith research that follows these rules will not be pursued legally. This policy does not authorize testing of third-party services (Polar, Resend, Cloudflare, model providers) or of Zephium infrastructure hosts directly.

## Supported versions

Only the currently deployed release of the hosted service and the `main` branch receive security fixes.
