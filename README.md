# Inventory Capture

A small single-page web app for photographing personal property and filing it
into the owner's own Dropbox. Add it to an iPhone home screen; there is no
App Store app and no server.

This repository is public only because GitHub Pages requires it. **The page
holds no data of any kind.** It is an empty form until someone signs it in
against their own Dropbox account with their own Dropbox app key, which is
entered on the device and never leaves it.

- No inventory data, photos, serial numbers or valuations are here.
- No API keys, tokens or secrets are here.
- Dropbox sign-in uses OAuth with PKCE, so there is no client secret to leak.
  The refresh token is stored only in the browser on the device.

Items are saved into the device's own storage the moment they are captured and
uploaded when there is a connection, so nothing is lost with no signal.

Built with Claude Code. No build step, no dependencies.
