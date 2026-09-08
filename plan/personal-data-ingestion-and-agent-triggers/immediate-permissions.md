# Immediate agent permission saves

Remove the separate Save permissions step on mobile and web. Toggles save on
change; the mobile history stepper saves each step and the web numeric field
saves valid edits on blur/Enter. Display progress and serialize requests. Failed
or uncertain writes restore the last confirmed display and require a reload
before further edits; never automatically retry against a newer grant version.

Ownership remains the authenticated account, resolved by existing cookie/bearer
middleware at `/api/data/agent-grant`. The existing repository authorizes and
stamps the owner. Client state remounts on owner changes and late responses are
withheld. No API, schema or permission scope changes.

Validation: web production build and ngrok-configured physical iPhone build;
manual toggle, failed-save/reload and cross-device conflict checks.

Web production and physical Debug builds passed:
`/tmp/bud-immediate-permissions-web.log` and
`/tmp/bud-immediate-permissions-mobile.log`. Interactive acceptance remains open.
