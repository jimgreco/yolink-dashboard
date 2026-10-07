# Personal YoLink setup — Jim only

Do not run the credential helper, create a UAC, or submit any actual credential
until Jim explicitly approves the personal-credential action below. The helper
also asks Jim to confirm locally before it transmits anything.

Proposed approval text:

> May I enable your personal YoLink connection on your private dashboard? You
> will enter the UAID and secret yourself in hidden Terminal fields on your Mac.
> They will travel over SSH to your existing EC2 server and over HTTPS to YoLink
> for read-only home/device queries, then be stored encrypted in the dedicated
> `yolink_dashboard` database. Only your verified `jgreco@gmail.com` Google login
> will have dashboard access. We'll verify the actual YoLink Home ID before
> saving and add a second credential only if your houses are separate YoLink Homes.

This creates no commercial developer account or paid service. YoLink UACs do
not have a documented read-only permission scope; the application enforces its
own fixed read-method allowlist. It never sends device-control methods or uses
plaintext MQTT. The current app refreshes while the dashboard is open; it is
not a replacement for YoLink's phone notifications.

## Prerequisites

1. Finish the existing Google client handoff and HTTPS DNS/proxy setup. No new
   approval is needed for that previously authorized infrastructure scope.
2. Deploy the owner-restricted image and migrations through `003_browser_sessions.sql`, with its restricted session-table grants.
   `bootstrap.py` installs `personal-setup.py` on EC2 but never calls YoLink.
3. Sign in to `https://yolink.jim-greco.com` as `jgreco@gmail.com` once. This
   records the verified Google subject. The credential helper refuses to run
   against an unknown or ambiguous owner identity.

## User handoff after approval

1. In the YoLink app, select the relevant Home and open **Account → Advanced
   Settings → Personal Access Credentials → +**. Keep the UAID and secret in
   the app; do not send a screenshot or paste them into chat.
2. Double-click `configure-yolink.command` on the Mac. It opens in Terminal,
   explains the destination and storage, and asks for CONNECT. Enter the UAID
   and secret into its hidden prompts. It refuses a redirected/non-interactive
   terminal or insecure input fallback.
3. Review the Home ID and device names returned by YoLink. Choose Manhattan,
   East Hampton, or Both houses. For Both houses, assign each listed device;
   skipped/new devices remain visibly Unassigned.
4. Type SAVE to reverify the Home ID and persist the encrypted credential.
   Duplicate connections for the same Home are refused. The helper uses a
   five-minute buffer before the next dashboard poll to preserve the API budget.
5. Repeat only if the other house is a different actual YoLink Home. One shared
   Home needs only one credential, regardless of having two physical houses.

The helper has no public HTTP endpoint. Its SSH access uses the existing pinned
EC2 host key. Secret values are never command arguments, logs, browser assets,
Git files, or model output. The dedicated database stores ciphertext only; the
server key remains in the private runtime environment file.

Setup verification should confirm actual house mapping, leak/battery/offline
readings and report timestamps against the YoLink app. A fresh API check never
changes an old device report into a fresh reading. Network failures retain old
alerts, and a Home-ID mismatch clears that connection's cached device data.

Official references: [personal UAC setup](https://doc.yosmart.com/docs/overall/qsg_uac/),
[Home-scoped API and Home ID](https://doc.yosmart.com/docs/account/Home/).
