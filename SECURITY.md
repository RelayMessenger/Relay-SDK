# Security

Never include Relay tokens, webhook signing secrets, upload URLs, or private
message data in an issue or test fixture.

Verify webhooks against the unmodified raw request body before parsing it.
Report vulnerabilities privately through the repository security advisory
flow.
