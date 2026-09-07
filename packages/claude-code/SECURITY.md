# Security

Report vulnerabilities privately through the security contact published by
Relay Messenger. Do not include Agent Tokens, private Message content, or other
credentials in a public issue.

The channel treats Relay Message content and Claude Code permission fields as
untrusted input. Sender allowlisting is mandatory. Agent Tokens belong in
Claude Code sensitive user configuration or an owner-only `.env` file and must
never be pasted into a Claude conversation.

See the README sections **Sender and permission safety** and **Durable state**
for the security boundary and fail-closed behavior.
