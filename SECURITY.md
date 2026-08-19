# Security Policy

## Supported versions

The current 0.1.x line receives security fixes. Fixes are released in the latest 0.1.x patch; older patches may remain affected.

## Reporting a vulnerability

Do not disclose an unpatched vulnerability in an issue, discussion, pull request, or other public channel.

Use [GitHub private vulnerability reporting](https://github.com/drawde-nadroj/pi-subagent-supervisor/security/advisories/new). If the private-reporting form is unavailable, open a public issue containing only a request to enable private vulnerability reporting. Do not include vulnerability details in that issue. Wait until the private form is available, then submit the report there.

Include the affected version, impact, reproduction steps or proof of concept, relevant configuration, and any suggested mitigation. Remove credentials, personal data, and unrelated secrets.

The maintainer will acknowledge the report, assess its impact, request more information if needed, and share material progress and disclosure guidance through the private channel. Response and remediation time depend on severity and complexity; no deadline is guaranteed.

## Scope

Agent definitions and project conventions are instructions executed by models with configured tools. Project discovery, writable tools, third-party prompts, provider handling of model requests, and locally stored run history are part of the security and privacy boundary. Session isolation reduces accidental context sharing, but it is not a security sandbox.
