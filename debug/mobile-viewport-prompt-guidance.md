# Debug: Mobile viewport guidance for generated sites

## Environment
- Bud agent-generated contact dashboard viewed on an iPhone through the local preview tunnel.
- No database or model-specific behavior involved.

## Repro Steps
1. Generate a new contact dashboard and open its preview on mobile.
2. Observe that the intended mobile layout does not display correctly.
3. Add a device-width viewport meta tag; the user reports that the layout now works.

## Observed
- The canonical agent prompt already requests mobile-first UI but omits viewport configuration and explicit mobile verification.
- User supplied: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`.

## Expected
- Newly generated sites configure the mobile viewport and work at phone and desktop sizes without a follow-up request.

## Hypotheses
- A missing viewport declaration allows the mobile browser to use a wider layout viewport, preventing intended responsive breakpoints from applying.
- `viewport-fit=cover` enables edge-to-edge rendering; it is optional and needs safe-area padding for content near device cutouts.

## Proposed Fix
- Expand the canonical frontend prompt with viewport metadata, safe-area handling, accessible zoom, touch interaction, and mobile browser verification.
- Keep viewport ownership in the generated site; no proxy or browser injection is needed.
- Update `service/src/agent/agent.spec.md`.

## Validation
- `pnpm exec node --import tsx --test src/agent/conversation-loader.test.ts`: all 14 tests passed, including canonical prompt loading and versioning.
