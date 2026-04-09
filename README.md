# FencerIQ v4 — Automated Test Suite

Run from Claude Code or any Node.js environment.

## Setup

```bash
cd fiq-tests
npm install
```

## Run All Tests

```bash
node test.js
```

## Run Specific Section

```bash
node test.js --only unit        # Scoring engine, date math, null guards
node test.js --only db          # DB table existence, integrity, row counts
node test.js --only auth        # Login for all 5 roles
node test.js --only api         # API endpoint availability and security
node test.js --only workflows   # Portal data access + end-to-end flows
node test.js --only regression  # All 30 bugs confirmed fixed
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FIQ_TEST_PASSWORD` | Yes | `FencerIQ2026!` | Password for all test-*.fenceriq.ai accounts |
| `FIQ_BASE_URL` | No | `https://fenceriq.ai` | Deployed app URL |
| `FIQ_SUPABASE_URL` | No | (hardcoded) | Supabase project URL |
| `FIQ_SUPABASE_ANON` | No | (hardcoded) | Supabase anon key |
| `FIQ_SERVICE_KEY` | Recommended | `''` | Service role key for deep DB checks |

```bash
FIQ_TEST_PASSWORD=YourPassword FIQ_SERVICE_KEY=your_key node test.js
```

## Test Accounts Required

These must exist in Supabase Auth with the configured password:
- `test-fencer@fenceriq.ai` — role: athlete
- `test-coach@fenceriq.ai` — role: coach  
- `test-club@fenceriq.ai` — role: club
- `test-parent@fenceriq.ai` — role: parent (optional)
- `friscofencingacademy+admin@gmail.com` — role: admin

If any account doesn't exist or has a different password, those tests will fail — auth failures are caught and reported, not fatal.

## What's Tested

### Section 1 — Unit Tests (no network)
- Scoring engine: qScore, overall, tier, mergeAll
- Null guard regressions (FIX-006b, FIX-018)
- Calendar month billing date (FIX-017C)
- NaN guard for classes_per_month (FIX-008)

### Section 2 — Database Integrity
- All 30 required tables exist (including 5 from FIX-015)
- No stuck onboarding profiles (FIX-003)
- No duplicate athlete player_emails (FIX-003)
- classes_per_month backfill complete (FIX-019B)
- Email queue health
- Recent error_log check

### Section 3 — Auth (5 roles)
- Login success for fencer, coach, club, admin
- Profile role matches expected role
- Unauthenticated API requests rejected (401)

### Section 4 — API Endpoints
- Model allowlist blocks unknown models (FIX-011-R)
- Oversized system prompt handled (FIX-011-R)
- Webhook unsigned requests blocked (FIX-014)
- All key endpoints respond

### Section 5 — Portal Data Access
- Fencer: athlete record, assessments, planner sessions
- Coach: roster, assessments, plan selector
- Club: club record, members, billing plans, coach dropdown
- Admin: all profiles, error log

### Section 6 — Regression Tests
- BUG-001: slider descs guard
- BUG-002: click handler null guard
- BUG-027: ai_usage table exists
- BUG-022: role lock on invite
- BUG-GPT-003: coach query from profiles
- BUG-GPT-004: booking dedup
- BUG-GPT-005: calendar month billing
- BUG-006b: overall() returns null
- BUG-014: webhook blocked
- BUG-018: tier(null) = "No data"
- + 8 more regression checks

### Section 7 — Workflow Integration
- Invite structure and state
- Assessment → scoring chain end-to-end
- Club → billing plan integrity
- Messages / conversations
- Training planner gap_focus columns
- Subscription inheritance

## Exit Codes
- `0` — All tests passed
- `1` — One or more tests failed
- `2` — Fatal error (network, config)

## Manual Tests (not automated)

These require a real browser:
- UI rendering and styling correctness
- Edge browser sessionStorage behavior
- Mobile/responsive layout
- Assessment question flow animation
- PWA install prompt
- Real SMS/email delivery
