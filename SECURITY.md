# SECURITY.md — Trust Boundaries and Controls

## Threat surfaces

Uploads (GLB/glTF, PNG/JPG/WebP, USDZ), GLB/USD parser behavior, external URLs embedded in glTF/USD, converter/container resources, R2 asset access, cross-tenant drafts, sharing links, public scene manifests, AR intent links, and action URLs.

## Requirements

### Authentication/authorization
- Authenticated creator endpoints; secure session cookies/tokens, CSRF protection where relevant.
- Enforce owner ID on every draft, asset, job, revision and derivative request.
- Public endpoints resolve only published immutable revision and approved assets.
- Signed/authorized uploads and private assets; do not accidentally publish originals.

### Upload validation
- File size, pixel dimension, decompression and parser limits.
- Validate actual file signatures, not just filename or Content-Type.
- Sanitize filenames; use generated R2 keys. Store original hash.
- For glTF, disallow or strictly control external dependencies, remote URLs and unsafe URI schemes.
- Zip bomb detection and file-count/size limits when unpacking archive-like formats.

### Converter isolation
- Run OpenUSD/Blender in constrained container with CPU/memory/disk/time limits.
- Separate temp directory per job; clean artifacts and apply bounded retries.
- Deny arbitrary outbound network and filesystem reads unless required, explicitly authorized and allowlisted.
- No shell interpolation from user values. Use argument arrays, exact executables and validated resource paths.
- Log errors without secrets or customer binary asset contents.

### Actions and content
- Allowlist outbound link protocols (`https`, `mailto`, `tel`) with validation and UX confirmation for sensitive destinations.
- Avoid user-defined HTML/JS execution; render plain text through safe React bindings.
- Use Content Security Policy, strict CORS for authenticated APIs, and per-asset cache policies.
- Generate Scene Viewer intent URLs via tested encoder; avoid delimiter injection in `file`, `link`, `title`, fallback params.
- Quick Look custom banners should be server-owned sanitized templates, not arbitrary creator HTML.

### Infra
- Secrets in Cloudflare bindings / deployment secret store, not `.env` committed to Git.
- Rate limiting, quotas, bot protection (Turnstile if needed), audit job transitions and auth failures.
- Use immutable revision outputs, verified checksums and explicit publication pointer update.
- Restrict Workflows/Containers access to authorized internal invocations.

### Privacy
- Do not store camera frames, tracked surroundings or raw location from AR sessions.
- Aggregate only observable events (page load, launch intent, supported on-page CTA, session start where exposed).
- Document analytics and deletion policy.

## Security gate checklist

- [ ] AuthZ tests cross user and across publish revisions.
- [ ] URL and intent encoder abuse cases tested.
- [ ] Decompression bomb and oversized image fixtures rejected.
- [ ] Sandbox resource budgets configured.
- [ ] R2 private/public access separated. *(Private side implemented: no public bucket access, owner-only routes, signed cookieless reads (ADR-022). Public published outputs not built yet; edge verification pending.)*
- [x] Conversion container isolation (ADR-023, implemented; Cloudflare side unverified): the USD converter runs with internet access disabled, receives the source in the request body from the Worker and returns the result; it holds no credentials or storage access and never sees user filenames. Locally the same image runs read-only with memory/CPU/pids limits, bound to 127.0.0.1. `USD_CONVERTER_URL` is honoured only with `APP_ENV=development` and a loopback host. Derivative signatures carry a kind so they cannot open originals. Per-user cap of 3 active conversions; outputs count toward the quota.
- [ ] No arbitrary active content in banner/panel assets.
- [ ] Secrets audit and dependency scanning completed.
