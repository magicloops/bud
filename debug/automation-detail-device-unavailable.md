# Debug: Automation detail build device unavailable

## Environment

Local Debug app, connected-device destination previously used successfully.

## Observed

Xcode exited 70 before compilation because the physical iPhone was absent from available destinations.

```text
Command line invocation:
    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild build -project Bud.xcodeproj -scheme Bud -configuration Debug -destination platform=iOS,id=00008150-000971AA0EBA401C -derivedDataPath /tmp/bud-ngrok-device-build "BUD_APP_ORIGIN=https://b21325f57611.ngrok.app" "BUD_AUTH_ISSUER=https://b21325f57611.ngrok.app/api/auth" "BUD_API_AUDIENCE=https://b21325f57611.ngrok.app/api" "BUD_INGEST_BASE_URL=https://b21325f57611.ngrok.app"

Build settings from command line:
    BUD_API_AUDIENCE = https://b21325f57611.ngrok.app/api
    BUD_APP_ORIGIN = https://b21325f57611.ngrok.app
    BUD_AUTH_ISSUER = https://b21325f57611.ngrok.app/api/auth
    BUD_INGEST_BASE_URL = https://b21325f57611.ngrok.app

Resolve Package Graph


Resolved source packages:
  textual: https://github.com/gonzalezreal/textual @ 0.3.1
  swiftui-math: https://github.com/gonzalezreal/swiftui-math @ 0.1.0
  TimelineCore: /Users/adam/bud-mobile/TimelineCore
  swift-concurrency-extras: https://github.com/pointfreeco/swift-concurrency-extras @ 1.3.2
  StreamingMarkdown: /Users/adam/bud-mobile/Packages/StreamingMarkdown

2026-09-06 16:40:36.596 xcodebuild[17276:13101521] Writing error result bundle to /var/folders/_n/tdtkt70j47qgsv8_3yq9vmj80000gn/T/ResultBundle_2026-06-09_16-40-0036.xcresult
xcodebuild: error: Unable to find a destination matching the provided destination specifier:
		{ platform:iOS, id:00008150-000971AA0EBA401C }

	Available destinations for the "Bud" scheme:
		{ platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device }
		{ platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS Simulator Device }
		{ platform:iOS Simulator, arch:arm64, id:3BFD0A78-5C5E-4ACE-B73F-98F4001C5B0F, OS:26.2, name:iPad (A16) }
		{ platform:iOS Simulator, arch:arm64, id:5E98CFAE-61C0-49A1-856C-4DE60C5321C5, OS:26.2, name:iPad Air 11-inch (M3) }
		{ platform:iOS Simulator, arch:arm64, id:AF37DBF9-4844-41CB-8AA1-21ADBF2BB5B3, OS:26.2, name:iPad Air 13-inch (M3) }
		{ platform:iOS Simulator, arch:arm64, id:4EEA211E-3DF5-421A-BA69-75E518DC7109, OS:26.2, name:iPad Pro 11-inch (M5) }
		{ platform:iOS Simulator, arch:arm64, id:2CAA2C54-75E2-459E-B630-C385BF35B523, OS:26.2, name:iPad Pro 13-inch (M5) }
		{ platform:iOS Simulator, arch:arm64, id:7F6CC47C-A84D-478F-B36E-4FD2F6C75106, OS:26.2, name:iPad mini (A17 Pro) }
		{ platform:iOS Simulator, arch:arm64, id:5D057932-0651-4129-A585-1D37E8B7D0AB, OS:26.2, name:iPhone 16e }
		{ platform:iOS Simulator, arch:arm64, id:905B18E9-A744-40E2-B0C4-63B341E5D5BC, OS:26.2, name:iPhone 17 }
		{ platform:iOS Simulator, arch:arm64, id:BC8F97A1-47D7-416C-8682-4E4D7D342B9E, OS:26.2, name:iPhone 17 Pro }
		{ platform:iOS Simulator, arch:arm64, id:19DA9A7F-42A7-48A6-879C-B68EE17BC0CD, OS:26.2, name:iPhone 17 Pro Max }
		{ platform:iOS Simulator, arch:arm64, id:50F74821-758F-48DA-80D2-2A7315811A11, OS:26.2, name:iPhone Air }

```

## Proposed validation

Compile against the available iPhone 17 simulator. Physical installation and interaction remain pending until the device reconnects. No source fix is implied by this destination error.
