# Debug: Local mobile configurations still target standalone ingestion

## Observed

`Configs/Local.xcconfig` and `Configs/LocalHTTPS.xcconfig` in bud-mobile set
`BUD_INGEST_BASE_URL` to `http://localhost:3002`. No project-level override exists.
`AppConfig.currentIngestEndpointURL` reads this value, so local builds bypass the
main service despite Vite/Caddy already forwarding `/v1/events/*` correctly.

## Fix

Derive the ingestion base from `BUD_APP_ORIGIN` in both local configurations.
Debug uses the Vite origin on 5173 and Local HTTPS uses Caddy on 3443. Production
already uses the main origin. Check expanded Xcode build settings and build the
app. Anonymous requests should reach the API and receive 401 rather than HTML.

Endpoint-partitioned queues keep their original identity. Changing this setting
does not migrate or discard old standalone queues; inventory/mapping remains
explicit. On a physical phone, localhost still requires a separately configured
development connection; this fix does not claim network reachability from iOS.

## Device access

The iPhone became paired/available, but `xcrun devicectl device info apps --device
B919B7B9-512F-5AD2-B247-46A46666BCFB --bundle-id chat.bud.app.local --timeout 20`
failed with CoreDeviceError 12040 and `kAMDMobileImageMounterDeviceLocked`.
Developer access requires the phone to be unlocked; no app was installed/launched.

## Initial validation

Expanded Xcode settings confirm Debug `http://localhost:5173` and Local HTTPS
`https://localhost:3443` for both app and ingestion origins. Debug simulator build
passed (`/tmp/bud-main-ingest-origin-build.log`). Initial anonymous POST through
Vite expected 401 but received 500. `lsof` confirmed listeners on 5173 and 3443,
but none on 3000: the local API process had stopped. This is distinct from the
mobile configuration defect. HTTPS routing checks do not establish phone trust.

The existing `tsx watch` process (63064) was alive with no child. Touching its
watched `src/server.ts` restarted its child without changing source content or
starting a competing watcher. New child 58801 listened on 127.0.0.1:3000.
Anonymous POSTs through both 5173 and 3443 then returned JSON 401 responses.
The HTTPS routing probe disabled local certificate verification and therefore
does not validate certificate trust. No token or user payload was submitted.
