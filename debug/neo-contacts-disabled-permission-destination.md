# Debug: Contacts unavailable after recreating preview

September 7, 2026. Dashboard /api/contacts returns generic HTTP503. Its helper
contacts query returns HTTP403 app_data_key_invalid with proper mkcert CA trust.
The configured key dak_01M1YY6XKCP3C45Z725DEGFYJG is installed and its request is
approved, but its bound site site_01M1YY2GK1TMCYNPKC604ECHBT was disabled at
23:12:59 UTC. That site was preserved during the earlier hostname migration.
A new site site_01M1Z2AZNJGBW75N3RRXH7SZDV, neo-contacts-5v8y86.bud.systems,
now targets the same 127.0.0.1:5174 app. Its identity differs from the old grant.

AppKeys.authenticate checks the destination site is still enabled. Rejecting
the old key is expected. Do not silently rebind it or reactivate a disabled site.
The agent should request a new human-reviewed app key for the current private
site, install using the existing backend helper, and update the configured key ID.
No credential or personal contact values were printed during diagnostic queries.

Separate environment observation: standalone Node lacks mkcert trust; the running
Vite log reports NODE_TLS_REJECT_UNAUTHORIZED=0. The backend should instead launch
with NODE_EXTRA_CA_CERTS pointing to mkcert rootCA.pem and normal TLS validation.
The confirmed 403 persists with proper CA trust, so TLS is not the current 503 cause.

Initial metadata query incorrectly referenced data_app_key.expires_at (42703);
corrected to key status and destination site's expiry and enabled state.
