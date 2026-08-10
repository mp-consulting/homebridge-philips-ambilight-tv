# Changelog

All notable changes to this project will be documented in this file.

## [1.6.10] - 2026-08-10

### Fixed

- **The Homebridge log showed `[PhilipsAmbilightTV]` instead of `[Philips Ambilight TV]`**: Homebridge derives a plugin's log prefix from `name` in its platform config, falling back to the plugin alias when that key is absent. `config.schema.json` had no `name` property at all, so the settings form never offered the field and nothing ever wrote it into `config.json`. `name` is now the first control in the form and defaults to `Philips Ambilight TV`. The custom UI compounded this by rebuilding the whole platform block from scratch on every keystroke, discarding any `name` already in the config; it now carries the existing value through.
- **404s in the browser console on every visit to the settings page**: the vendored minified Bootstrap files kept their trailing `sourceMappingURL` comment, so the browser asked for `bootstrap.min.css.map` and `bootstrap.bundle.min.js.map` and got a 404 for each. The copy step now strips the comment instead of shipping ~920 kB of source maps.

## [1.6.9] - 2026-08-09

### Changed

- **Node.js support is now `^22.10.0 || ^24.0.0 || ^26.0.0`**: adds Node 26, which Homebridge 2.3.0 supports as of this release, and drops Node 20. Homebridge 2.x has never accepted Node 20 (it has required `^22 || ^24` since 2.0.0), so the previous range advertised a combination that could not actually run. CI now builds on Node 22.x, 24.x and 26.x.

## [1.6.8] - 2026-08-05

### Fixed

- **The TV could vanish from the Home app and the iOS Remote after re-running the pairing wizard.** A TV is published as its own accessory, and Homebridge derives the identity a controller pairs against from the accessory's UUID alone — which this plugin built straight from the MAC in your config. The *spelling* of that address therefore decided which accessory HomeKit saw: `AA:BB:CC:DD:EE:FF`, `aa:bb:cc:dd:ee:ff` and `aa-bb-cc-dd-ee-ff` all name the same TV, all pass validation, and each produced a different one. Re-pairing was enough to switch between them, because the wizard's "Get MAC" reads the address from the operating system, which prints it in lowercase, while an address typed off the TV's own network screen is usually uppercase. The TV you had paired stayed paired — it simply stopped being advertised, so it went unresponsive in the Home app and disappeared from Control Center's Remote, taking its room, scenes and automations with it. Each TV's identity is now decided once and remembered, so later changes to how the address is written are inert; the wizard also writes one consistent spelling from now on.
- **A TV this has already happened to is put back on its own.** On startup the plugin looks for a pairing left behind under another spelling of the same address and, finding one, publishes the TV under that identity again. The accessory returns where HomeKit expects it — no removing and re-adding, and nothing set up against it is lost. Every way of writing the address is searched — any mix of upper and lower case, with colons or with dashes. An address mixing the two separators is the one spelling not covered; the configured address is followed as it is written until a pairing turns up, so writing it back exactly as it was still fixes that by hand. If you have already removed the TV from the Home app there is nothing left to recover: add it once more and it will stay put.

## [1.6.7] - 2026-08-05

### Fixed

- **A scene carrying both a source switch and a leftover input still launched two apps, and its switches still flickered** ([#17](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/17)): v1.6.6 decided which of the two halves wins, but it could only weigh a write against one it had already seen — so it settled the conflict in one arrival order only. When the Home app sent the leftover input first, that input launched before the switch had been heard from: the TV opened one app and then the other, and the first source's switch lit up in the Home app only to go dark again when the second won. An input arriving while source switches are in use now waits a quarter of a second for a switch that may be following it, so the scene produces a single launch, and a single lit switch, whichever order the two are written in. The log line naming the source that was dropped — and how to correct the scene — now appears in both orders as well.

## [1.6.6] - 2026-08-05

### Fixed

- **Nothing the TV did reached HomeKit any more — no source changes from the remote, and the tile stayed on after the TV was switched off** ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)): once the TV's push channel proves it is working, the plugin stops polling and lets the channel do the work. Turning the TV off shut that channel down — correctly, since a TV in standby has nothing to push — but never brought the poll back, so the plugin was left with nothing watching the TV at all. From that moment on it only knew what HomeKit itself had commanded: the TV coming back on, a source picked up with the remote, or the TV being switched off went unnoticed until Homebridge was restarted. The poll now always resumes when the push channel is torn down. This has been latent since v1.4.0 but only became reachable in v1.6.0, which is when TVs that announce only `activities/tv` — this reporter's among them — started confirming the channel and dropping the poll.
- **A push channel that stops delivering can no longer freeze the plugin.** A TV that answers the notification request without reporting anything kept the channel alive and looking healthy, so the failure count never built up and the fallback never kicked in. Such an answer no longer counts as a delivery, and independently of that, going a minute without a single word from the TV now brings interval polling back. HomeKit is never more than that behind the TV, whatever the channel does.
- **A source could still be missed when it was picked as part of turning the TV on** ([#17](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/17)): the TV answers `OK` to an app launch it receives while it is still coming out of standby, and then drops it — so the plugin recorded the source as applied, told the Home app so, and never tried again while the TV woke onto its own home screen. A launch made after a power-on is now checked against what the TV reports it is actually showing, and repeated until it takes. Only evidence to the contrary counts as a failure — the TV sitting on its launcher, or on a different app — so an app the TV never names in a report of its own is not relaunched underneath you.
- **A scene asking for two different sources at once now resolves the same way every time.** The Home app fills a scene's TV input in from whatever it happened to be when the scene was created, so a scene built around a source switch routinely carries an unrelated leftover input as well. Both are written in the same instant with no ordering guarantee, which made the outcome a coin flip. The switch now wins: it is the half of the pair you added on purpose. The wheel follows it rather than fighting it, and the log says which source was dropped so the scene can be corrected.

## [1.6.5] - 2026-08-04

### Fixed

- **Scenes that pick a source still landed on the wrong app, or on none at all** ([#17](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/17)): v1.6.4 taught the input wheel to hold a source until the TV had finished waking, but a source is exposed to HomeKit twice — as an entry on the wheel and as its own switch — and the switches were left launching on their own. A Home scene captures both, writes them at the same moment, and the two launches then fought over the TV: one would win on screen while the other won in the Home app, which is why a switch would light up and then go out again with the right app playing. Both now go through one place, so a scene produces exactly one launch and the Home app shows what the TV is actually on.
- **A source picked as part of turning the TV on was sometimes never applied.** The held selection was waiting for the next poll to notice the TV had come on. A TV switched off again a few seconds later never gives it that moment, so the selection sat there and quietly expired. Turning the TV on now applies it directly.
- **Turning the TV off no longer leaves a source waiting to fire.** A source picked just before switching off could still be applied on the next power-on, dragging the TV off whatever had been chosen since. An explicit off now retires it — a TV reporting standby while it boots does not, so a scene's source is still held across the wake it was meant for.
- **Source switches no longer flicker off while the TV wakes.** A switch turned on for a TV that is still starting up stays on, matching how the wheel already behaved, and only goes back to the previous source if the TV genuinely refuses.

## [1.6.4] - 2026-08-03

### Fixed

- **HomeKit jumped back to Home about half a minute after every source change** ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)): the TV answers "no trackable app" (`NA`) not only on its home screen but also for the whole time an app it does not track sits in the foreground. Since v1.6.0 that answer is read every ten seconds, so once the guard that protects a fresh selection expired, a perfectly ordinary "no app" reply dragged the wheel and the switches onto **Home** while the app carried on playing. `NA` is now treated as what it is — an absence of information — and is ignored while the current input is an app the TV has never named in a report of its own. Apps the TV does report are unaffected: leaving one for the home screen still shows up as Home, as does pressing Home from the tuner or an HDMI input, and a TV waking from standby still aligns on whatever it wakes into.
- **Switching to Watch TV from inside an app often did nothing.** Watch TV was selected by sending the `WatchTV` remote key, which Android delivers to the foreground app — and many streaming apps swallow it. That is why the switch worked from the home screen but usually failed from within an app, while going the other way (Watch TV to an app) always worked. The tuner is now selected through the TV's source service, the same way HDMI inputs are, with the key press kept as a fallback for sets that reject it.

### Changed

- **A configured TV can be re-paired from the plugin settings.** Editing a TV now offers **Re-pair**, which runs the PIN flow against the TV and swaps in the fresh credentials in place — the name, sources, switches and custom apps are all kept, and the HomeKit accessory stays the one you have already placed in a room. Previously the only way to renew credentials, or to record the TV's certificate for the pinning added in v1.6.0, was to delete the TV and add it back.

## [1.6.3] - 2026-08-03

### Fixed

- **HAP-NodeJS warned that the "Ambilight + Hue" switch had an invalid name.** HomeKit only accepts letters, numbers, spaces and a small set of punctuation in an accessory name, and `+` is not among them. The TV's own name and the app names read from the TV were already passed through the plugin's sanitizer (which renders Disney+ as "Disney Plus"), but the switch's label was a hardcoded string appended afterwards, so the `+` survived into the `Name` characteristic. Apple warns that such a name can stop an accessory being added in the Home app or leave it unresponsive. The switch is now called **Ambilight Plus Hue**. Existing installs are migrated automatically, unless the tile was renamed in the Home app — in that case your name is kept.

## [1.6.2] - 2026-08-03

### Fixed

- **The plugin settings screen was broken: "Edit" did nothing and icons were missing.** Bootstrap's stylesheet, icon font and JavaScript bundle were loaded from a CDN, but the Homebridge UI serves plugin pages under a Content-Security-Policy that only permits `'self'` for scripts, styles and fonts — so all three were blocked in every installation. With the bundle blocked, `bootstrap` was undefined and clicking **Edit** threw `ReferenceError: Can't find variable: bootstrap` instead of opening the screen. Bootstrap and Bootstrap Icons are now shipped with the plugin and served locally, which also means the settings UI no longer needs internet access to render.

## [1.6.1] - 2026-08-03

### Fixed

- **A scene that turns the TV on and picks a source only turned the TV on** ([#17](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/17)): HomeKit writes the power and the source as two separate instructions at the same moment, with no guarantee of order, and the TV needs several seconds after accepting the power command before it will accept a launch. The plugin acted on the source instruction immediately, so it was sent to a TV that was off or still starting up, failed, and was never tried again — the TV came on and stayed where it was. A source chosen while the TV is off or still waking is now held and applied as soon as the TV is genuinely ready, retrying over about 12 seconds to cover a slow start. A source the TV refuses when it is properly awake still reports an error as before.

## [1.6.0] - 2026-08-03

### Security

- **The TV's certificate is now pinned.** Philips TVs serve self-signed certificates, so ordinary chain verification can never succeed and the plugin previously accepted any certificate — meaning nothing distinguished the real TV from anything else answering on its address. Pairing now records the TV's SHA-256 certificate fingerprint in the device config, and every later connection verifies against it, refusing to connect on a mismatch. Once a fingerprint is stored the plaintext HTTP fallback is skipped too, since downgrading to HTTP would sidestep the pin.

  Existing setups keep working unchanged: a config with no stored fingerprint connects exactly as before and logs a debug note suggesting a re-pair. Re-pair the TV from the plugin settings to enable verification.

- **Text from the TV is sanitized before it reaches the log.** Resource names from `notifychange` and unparseable response bodies were interpolated straight into log lines, so a newline in either could forge additional Homebridge log entries.

### Fixed

- **Switching source/app with the physical TV remote didn't update HomeKit** ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)): The long-poll subscribes to `activities/tv` because the TV pushes it on every state change, but the plugin discarded it as noise and only refreshed on other resources. Once the long-poll was confirmed working (which stops the interval-poll baseline), a change made from the physical remote — which some models only surface via `activities/tv`, not `activities/current` — never triggered a refresh, so the wheel and switches went stale until an action from the Home app moved them. `activities/tv` is now used as a throttled refresh trigger (at most once every 10s, so the once-a-second tuner ticks don't cause constant polling), so remote-driven changes reach HomeKit within about 10 seconds. A report that directly names a resource still refreshes immediately.

## [1.5.24] - 2026-07-17

### Fixed

- **Pressing Home on the TV remote showed "Watch TV" in HomeKit** ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)): On firmwares that report `NA` for the home screen, v1.5.23's rule "NA confirms the current input when it's already a source" meant going Home from the tuner just re-confirmed Watch TV. A sustained `NA` now always maps to the **Home** input (these firmwares report `org.droidtv.playtv` for the tuner, so `NA` unambiguously means the home screen).
- **App selected on the TV ended up shown as "Watch TV" in HomeKit** ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)): The TV emits system reports (`org.droidtv.playtv`, `NA`) transiently while switching between apps, and applying one of them instantly could ratchet the state off the real app (Disney+ playing → transient `playtv` → mapped to Watch TV → stuck). Ambiguous system reports now need **two consecutive sightings** before they are applied — a report that directly names an app still applies immediately, and the power-on sync performs a second spaced read so a TV that wakes onto its home screen still aligns right away.
- **App launches failed with "The TV rejected the launch activity …MainActivity"** ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)): When the plugin had not yet been able to enumerate the TV's apps (e.g. Homebridge restarted while the TV was slow or asleep), launching fell back to a guessed `<package>.MainActivity` activity, which some apps (notably Disney+) reject. On a rejected guess the plugin now refreshes the TV's app list to learn the real launch intent and retries once.

## [1.5.23] - 2026-07-14

### Fixed

- **Returning to the TV's home screen was invisible to HomeKit** ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)): Pressing Home on the TV remote (or the TV waking from standby onto its home screen) never updated the wheel or switches, because the home-screen detection added in v1.5.22 only recognised the classic Android TV launcher package. Newer Philips models run the Google TV launcher (`com.google.android.apps.tv.launcherx`) and some firmwares report the literal `NA` instead — both slipped through. Detection now covers the Google TV launcher, catches unlisted launcher variants by name, and resolves `NA`: when the current input is already Watch TV/HDMI it is confirmed (some firmwares report `NA` on the tuner), otherwise the TV just left a tracked app and the **Home** input is applied. This also fixes the wrong/missing state on the **first turn-on from standby**, which had the same root cause. A package explicitly registered as an input is never remapped, and the Google TV launcher no longer shows up as a discovered app input.

## [1.5.22] - 2026-07-14

### Fixed

- **Rapid input-wheel selections became unreliable and could leave the wheel showing "No Response"** ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)): Every wheel move launched its source on the TV back-to-back, so a burst of selections piled requests up until the *newest* one — the source the user actually wanted — was dropped by the request queue or blew HomeKit's 10-second callback deadline. Wheel selections are now coalesced: launches run one at a time and a selection that is superseded by a newer one is skipped entirely, so only the final choice is launched and it always fits within the deadline.
- **Wheel selection didn't light up the matching source switch** ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)): Switching via a source switch updated the wheel, but switching via the wheel left the switches untouched until a later poll — which, arriving while the TV was still mid-switch, could even flip the previous switch back ON. A successful wheel switch now updates the switches immediately, and a state report that contradicts a selection still in flight is withheld from the switches just like it already was from the wheel — so wheel, switches, HomeKit state, and the real TV stay aligned.
- **Wheel and switches stayed stale after waking the TV from standby** ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)): Right after a wake the TV reports its current activity as `NA`, the Android launcher, or the system `org.droidtv.playtv` package — none of which matched a registered input, so the power-on sync (added in v1.5.21) found nothing to apply. These reports are now resolved: the launcher maps to the **Home** input, `playtv` confirms the current input when it's already Watch TV/HDMI (falling back to **Watch TV** otherwise), and `NA` is treated as "no report" instead of an unknown app.
- **Wheel could still bounce back mid-switch on long-poll TVs** ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)): The guard that ignores state reports while a selection is being executed counted *polls* (3), but the long-poll connection can deliver several reports within seconds of the launch — expiring the guard while a cold app start (10s+) was still in progress. The guard is now time-based (20s), so slow app launches no longer bounce the wheel, while a genuinely failed switch is still corrected afterwards.

## [1.5.21] - 2026-07-13

### Fixed

- **Source switch renames didn't survive a restart** ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)): The Apple Home app often keeps a switch rename *client-side* and never writes it back to the accessory, so the plugin couldn't capture it — and then re-asserting the default name on every launch actively reset the user's rename (e.g. "Ver TV" → "Watch TV", "Nintendo" → "HDMI 3"). The plugin no longer overwrites a switch's name on restart: a rename it *did* capture is still restored, a brand-new switch is seeded with the source label, and an existing switch is left alone except to upgrade a leftover package-id placeholder to the real app name.
- **Input-selector "wheel" would stop updating / bounce back after selecting a source** ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)): Selecting an input now confirms the choice on the Television service, and a state poll that arrives before the TV finishes switching (still reporting the previous app) is ignored for a few cycles instead of bouncing the wheel back off the selection. A switch that genuinely fails is still reflected after a short grace period.
- **Wrong/no source switch on the first turn-on** ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)): When the TV wakes, the plugin now pulls the current source immediately (after reconciling the input list) so the correct input and switch light up right away instead of after the next poll cycle.

## [1.5.20] - 2026-07-13

### Fixed

- **Input-selector "wheel" showed generic names like "Entrada 1, 2, 3" in non-English Home apps**: The workaround for the tvOS HomeHub bug ([homebridge/homebridge#3703](https://github.com/homebridge/homebridge/issues/3703)) — where the controller writes its own generic placeholder back into an input's name — only recognised the **English** string "Input Source". In a localized Home app the controller writes the translated placeholder (Spanish "Entrada 2", German "Eingang 3", etc.), which slipped past the filter and permanently overwrote the real app label on the wheel, so even a manual rename was re-clobbered. The guard now matches the localized generic names across common languages, so friendly names survive. Source **switches** were never affected ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)).
- **Source switch lingered ON for several seconds after turning the TV off from HomeKit**: The switches were only reset when the next state poll noticed the TV was off — up to the ~10s polling interval away. Turning the TV off from HomeKit now resets the source switches immediately ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)).

## [1.5.19] - 2026-07-12

### Fixed

- **Sources screen hung after closing and reopening the plugin config**: Reproduced on Chrome (and Safari) — after you close the plugin config modal and reopen it, triggering the sources screen would spin forever and log `TypeError: null ... postMessage`. This is a Config UI X bug: closing the modal destroys its iframe but leaves a stale socket subscription, so the TV's `/get-sources` response is delivered to the now-null iframe and dropped. The plugin now caches each TV's fetched source list in **`localStorage`**, which (unlike the previous in-memory cache) survives the modal/iframe reload — so reopening renders from the cache instead of re-requesting, and the hang can't occur. A **"Refresh from TV"** button forces a genuine re-fetch, and the cache expires after 1 hour ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)).

## [1.5.18] - 2026-07-12

### Fixed

- **Reverted the v1.5.17 config-load change that broke the settings screen in Safari**: v1.5.17 wrapped the initial `getPluginConfig()` in a retry with a 6s timeout. On Safari that fires too early and stacks concurrent requests, which the Config UI X iframe can't match up — so the screen fell back to the setup wizard instead of showing the configured TV. The config load is back to the simple, reliable single call that worked through v1.5.16 ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)).

## [1.5.17] - 2026-07-12

### Fixed

- **Configuration screen sometimes blank in Safari (incl. iPhone/iPad)**: The settings UI loaded the Homebridge *user settings* (for theme) before the *plugin config*, which made the config the second IPC call — and Safari's Config UI X iframe can drop the response to a later request, leaving the screen blank. The plugin config is now the **first** call, is **retried** if its response is dropped (so it self-heals instead of hanging), and falls back to the setup wizard rather than a blank page if it truly can't load. Theme detection is now deferred and non-blocking. Note: iOS/iPadOS browsers are all Safari/WebKit, so this path matters there; the source-configuration screen's repeated fetches can still hit the same upstream Safari limitation ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)).

## [1.5.16] - 2026-07-12

### Fixed

- **Sources/switches showed a long package id instead of the app name**: A source you selected while the TV was asleep is registered immediately (so it's never dropped) but, before the TV is reachable, it's labelled with the app's package id (e.g. `com.netflix.ninja`). Once the TV wakes and reports its real labels, the plugin now upgrades those placeholder names in place — on both the input and its source switch — without ever overriding a name you set in the sources config or changed in HomeKit ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)).
- **Source switch renames were not persistent**: Renaming a source **switch** in the Apple Home app is now saved to disk (keyed by the TV's MAC) and restored on restart, so it survives reboots and re-discovery. Previously the name reverted because the accessory is published as external and its context isn't persisted by Homebridge ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)).

## [1.5.15] - 2026-07-12

### Changed

- **Removed the session source cache again** (added v1.5.12, restored v1.5.14): by preference, the source-configuration screen always fetches a fresh list on open, matching the pre-cache behaviour of v1.5.11. Note that on **Safari** the Config UI X iframe bridge can still drop the response to a repeated request; use a Chromium-based browser or Firefox for the source-configuration screen ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)).

## [1.5.14] - 2026-07-12

### Fixed

- **Restored the session source cache (reverted in v1.5.13), because it is required for Safari**: v1.5.13 removed the cache after confirming Chrome doesn't need it — but that broke the source-configuration screen on **Safari**, where the Config UI X iframe bridge drops the response to the *second* `homebridge.request` in a session. The cache renders reopens from the first fetch instead of issuing that second request, so the screen works in Safari again. It's harmless on Chromium/Firefox (reopen is simply instant), and the **"Refresh from TV"** button is back for deliberately re-fetching newly-installed apps ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)).

## [1.5.13] - 2026-07-12

### Changed

- **Reverted the session source cache added in v1.5.12**: The cache (and its "Refresh from TV" button) worked around a Config UI X iframe bug that only affects **Safari** — its `postMessage` bridge drops the response to a repeated request. On Chrome/Edge/Firefox, repeated `/get-sources` requests work fine (verified end-to-end), so the cache added stale-list behaviour (newly-installed apps not appearing until a manual refresh) for no benefit on the browsers that work — and it cannot reliably rescue Safari, where the first request can already fail. The source configuration screen now always fetches a fresh list on open. Safari remains affected by the upstream Config UI X bug; use a Chromium-based browser (or Firefox) for the source-configuration screen ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)).

## [1.5.12] - 2026-07-12

### Fixed

- **Sources screen stuck on "Fetching sources" the second time it's opened**: Reopening the source-config screen (or resetting the order) issued another `/get-sources` request, and Homebridge Config UI X drops the response to that second request — it tries to `postMessage` to a plugin iframe whose `contentWindow` has gone `null` and throws, so the screen hangs (reproducible even on Config UI X 5.24.0 / Homebridge 2.1.1; the missing null-check is upstream). The plugin now **caches each TV's fetched source list for the session** and renders reopens and order-resets from that cache instead of re-requesting, so the failing second request never happens. A new **"Refresh from TV"** button performs a deliberate re-fetch when you actually want to pick up newly-installed apps ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)).

## [1.5.11] - 2026-07-12

### Fixed

- **Source-config screen sometimes hung on "Fetching sources" until a full page reload**: The setup wizard's `/get-sources` request could time out even though the plugin fetched the sources correctly. The root cause is upstream in Homebridge Config UI X (it tries to deliver the response to a plugin iframe whose `contentWindow` is momentarily `null` and throws, dropping the response) — **updating homebridge-config-ui-x is the actual fix**. This release reduces how often the plugin triggers it: source-config changes now debounce their disk save instead of saving on every show/hide toggle and drag (each save re-rendered the settings view and could invalidate the iframe), the routine per-request `[Sources]` log lines are gated behind a `PHILIPS_TV_UI_DEBUG` flag to cut socket-channel chatter, and the sources fetch guards against overlapping requests ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)).

## [1.5.10] - 2026-07-12

### Changed

- **Clearer message when the setup wizard can't fetch sources in time**: If the "Fetching sources" step times out, the retryable error now tells you to turn the TV on and wait until it shows the **Home screen** — a TV freshly woken from standby is still starting its apps, which is the usual cause — instead of only saying to make sure it is powered on ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)).

## [1.5.9] - 2026-07-11

### Fixed

- **Selected sources missing after a restart, and fewer source switches than selected**: The v1.5.7/v1.5.8 fixes only covered the setup wizard. At runtime, a TV that was asleep or slow when the child bridge started could still end up with missing inputs and fewer source switches than the number of sources marked visible (e.g. 10 switches for 12 selected sources). Three causes are addressed ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)):
  - Every source marked **visible** in the sources config is now registered as an input at startup, independent of whether the TV was reachable at that moment — so a selected source is never dropped just because the TV was asleep.
  - The app list is now **reconciled when the TV wakes** (on power-on), not only once shortly after boot, so apps that couldn't be enumerated on a sleeping TV are backfilled without needing a restart.
  - **Source switches are rebuilt whenever the input list changes**, so the number of switches always matches the sources you marked visible.

## [1.5.8] - 2026-07-09

### Fixed

- **Setup wizard still hangs / shows no sources on a slow TV**: A follow-up to the v1.5.7 fix. The wizard reused the runtime client's deliberately short 2 s per-request timeout (tuned to stay under HomeKit's characteristic-callback deadline), so a Philips TV that was slow to answer — typically one freshly woken from standby, which is slow to serve `/applications` — tripped the timeout and the wizard quietly fell back to the generic built-in list, or kept spinning. The setup source fetch now uses a longer 6 s per-request timeout, is bounded by a single shared 15 s deadline across the sources and apps requests so the "Fetching sources" step can never hang, and the settings page shows a retryable error instead of an endless spinner if the request is wedged ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)).

## [1.5.7] - 2026-07-09

### Fixed

- **Setup wizard hangs on "Fetching sources from TV"**: The wizard could spin indefinitely and never list the TV's sources. The HTTP timeout only covered the connection and response headers, not the response *body* — so a TV that returned `200` headers but then stalled the body left the sources request unresolved forever, and the built-in-sources fallback was never reached. The request now buffers the body while the abort timer is still armed, so a stalled body is aborted at the deadline and the wizard falls back to the built-in sources ([#14](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/14)). This also hardens the pairing and system-info requests against the same failure.

## [1.5.6] - 2026-07-05

### Changed

- **Dependencies**: Updated dependencies to their latest compatible versions and regenerated the lockfile.

## [1.5.5] - 2026-05-31

### Changed

- **Clearer launch failures**: When a custom app fails to launch, the log now names the app and the launch activity that was tried (and hints to set the correct one) instead of a generic "Failed to switch input" — the usual cause is a wrong launch activity that the TV rejects ([#11](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/11))

## [1.5.4] - 2026-05-31

### Fixed

- **Custom apps dropped on save**: `customApps` was defined in the config schema but missing from the schema layout, so saving the plugin config through Homebridge's standard settings form could drop the custom apps. They are now part of the layout and survive a save ([#11](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/11))

## [1.5.3] - 2026-05-30

### Fixed

- **Ambilight tile stayed on after power-off**: When the TV powered off, the Ambilight lightbulb in HomeKit kept showing "On" (only the Ambilight state sensor was updated). The lightbulb now switches to Off when the TV powers off

## [1.5.2] - 2026-05-30

### Fixed

- **Start Ambilight on power-on**: The `ambilightOnStart` option never triggered when the TV was off at Homebridge startup (the common case) — the first power-on after startup was mistaken for the initial state sync and skipped. The power poll now reports its initial state at startup, so a genuine off→on transition correctly auto-starts Ambilight (while a Homebridge restart with the TV already on still skips it)

## [1.5.1] - 2026-05-30

### Fixed

- **Custom app launching**: Philips firmware rejects a launch without a valid launch activity (`className`), so custom apps could fail to start. The fallback now uses `<packageName>.MainActivity` (the common Android convention) instead of a bare `MainActivity`. For apps that use a different launcher (e.g. YouTube, Prime Video), capture the exact activity with **Detect from TV** or set it in the new optional **Launch activity** field ([#11](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/11))

### Changed

- **Detect from TV**: The launch activity is now a visible optional field, and detection captures the app's real launch activity (which often differs from `<package>.MainActivity`). When the TV is on live TV or the home screen, detection now tells you to open the target app first instead of returning the system activity

## [1.5.0] - 2026-05-30

### Added

- **Custom apps**: Add apps your TV doesn't report through its app list (e.g. sideloaded or region-specific apps like EON), in addition to auto-discovered apps. A dedicated **Apps** tab in the config UI lets you add them, with a **Detect from TV** button that auto-fills the package name and launch activity from whatever app is open on the TV. Custom apps appear in the sources list with a distinct "Custom" badge so their visibility and order can be managed like any other source ([#11](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/11))
- **Start Ambilight on power-on**: New `ambilightOnStart` option (toggle next to Ambilight Mode) automatically turns Ambilight on, in the configured mode, whenever the TV powers on

## [1.4.0] - 2026-05-30

### Added

- **Ambilight + Hue switch**: Optional switch to toggle the Philips Hue integration (Hue lamps following Ambilight) independently of the main Ambilight controls, for use in HomeKit scenes and automations. Enable via the new `ambilightHueSwitch` option (config UI: Automations tab). Backed by the TV's `/HueLamp/power` endpoint ([#12](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/12))

### Fixed

- **Visible apps dropped from sources**: Apps explicitly marked visible in the sources config were silently discarded at runtime by the system/launcher package exclusion list, even though the config UI showed them as available. An app set visible now always overrides the exclusion list ([#11](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/11))

## [1.3.7] - 2026-04-17

### Fixed

- **Node 20.x compatibility**: Pin `undici` back to 7.x — v8 requires a Node 20 minor that ships `webidl.util.markAsUncloneable`, causing `TypeError: webidl.util.markAsUncloneable is not a function` on older 20.x. Keeps the plugin working across `^20.18.0 || ^22.10.0 || ^24.0.0`

## [1.3.6] - 2026-04-17

### Changed

- **Dependencies**: Updated all dependencies to latest versions, including major bump for `undici` (7→8)

## [1.3.5] - 2026-04-13

### Fixed

- **Power-on retry**: Fix turn-on commands being silently ignored after the first failed attempt — the optimistic `isPoweredOn = true` after sending a WoL packet caused the poll manager's state to diverge from the accessory's state, so subsequent turn-on taps hit the "already on" early-exit and did nothing. The TV now only reports confirmed power-on when the API responds; if only WoL was sent (TV in deep standby), `isPoweredOn` stays false and retries work correctly ([#10](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/10))
- **Source count mismatch**: User-configured visible sources now take priority within the 30-source cap — previously, sources marked visible in the Homebridge UI could be silently dropped if they fell beyond the 24th app slot in alphabetical order, causing HomeKit to show fewer sources than configured ([#9](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/9))

### Changed

- **Setup wizard**: The sources configuration screen now appears immediately after completing the pairing wizard, so visibility and order can be set before adding the TV to HomeKit ([#8](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/8))

## [1.3.4] - 2026-04-06

### Fixed

- **Ambilight switch bounce**: Fix Ambilight turning back on a few seconds after being switched off — the style-retry timer from a prior ON action was not cancelled, causing it to misinterpret the OFF state as drift and re-apply the ON style

## [1.3.3] - 2026-04-06

### Fixed

- **Source switch state sync**: Switching via a source switch now updates the TV accessory tile label (ActiveIdentifier) in HomeKit, keeping the input wheel and tile subtitle in sync with the active source

## [1.3.2] - 2026-04-06

### Fixed

- **Source switches**: Fix switches bouncing off in HomeKit after activating Watch TV, Home, or TV channels — the polling service was overriding the switch state with unrecognized system package names from the TV

## [1.3.1] - 2026-04-05

### Fixed

- **Home source switch**: Fix Home switch sending a bogus intent instead of the Home key — the source switch now correctly calls `launchHome()` like the input wheel does

## [1.3.0] - 2026-04-05

### Added

- **Home input source**: "Home" is now available as a selectable input source in the HomeKit wheel, allowing users to navigate to the TV home screen directly from the source picker (in addition to the existing remote button mapping)

## [1.2.2] - 2026-04-04

### Fixed

- **Activity polling**: Remove buggy `org.droidtv.playtv` to `WATCH_TV_URI` mapping in `getCurrentActivity()` that interfered with source detection

## [1.2.1] - 2026-04-04

### Fixed

- **Watch TV / channel switching**: Use `WatchTV` remote key to activate the TV tuner instead of launching an intent with `content://android.media.tv/channel`, which incorrectly opened the TV Guide instead of live TV

## [1.2.0] - 2026-04-04

### Added

- **Source switch visibility filtering**: Source switches now only expose visible (non-hidden) sources, so hidden sources are not cluttering HomeKit automations

### Fixed

- **Source switch naming**: Switches now use the source name only (e.g. "Netflix") instead of prefixing with the TV model name (e.g. "43PUS7303 12 Netflix")
- **Source switch rename persistence**: User-renamed switches no longer revert to default names after Homebridge restarts or plugin updates

## [1.1.2] - 2026-04-04

### Fixed

- **Wake-on-LAN**: Return success optimistically after sending WoL packets so the TV can be turned on even when fully off (API unreachable); the polling service reconciles the actual state once the TV boots

## [1.1.1] - 2026-04-04

### Fixed

- **Sources UI**: Render sources list immediately when hiding/showing a source instead of waiting for the async config save, fixing the issue where hidden sources wouldn't appear in the hidden column until a page refresh

## [1.1.0] - 2026-04-04

### Added

- **Input source switches**: Expose input sources as Switch accessories for HomeKit automations
- **Remote button mappings**: Add configurable back and play/pause remote button mappings
- **Custom UI**: Add remote key and source switch settings to the configuration UI with tabbed layout

### Fixed

- **Channel switching**: Activate TV tuner before switching channels to prevent black screen

### Changed

- **Node.js**: Add Node.js 24.x support to CI matrix and standardize engines to `^20.18.0 || ^22.10.0 || ^24.0.0`
- **Assets**: Convert ambilight-tv image from JPG to WebP

## [1.0.23] - 2026-03-30

### Fixed

- **Ambilight callback timeout**: Bail early from Ambilight ON handler when power call fails instead of chaining a second doomed request; reduce POST timeout from 5s to 3s so sequential API calls fit within Homebridge's callback window

## [1.0.22] - 2026-03-30

### Fixed

- **API queue timeout**: Add 8-second queue-level timeout to prevent Homebridge "didn't respond at all" warnings when the TV is unreachable and multiple commands pile up behind timed-out requests
- **Dependencies**: Hoist `class-validator` as a direct dependency so `homebridge-config-ui-x` resolves it correctly at runtime

### Changed

- **Node.js**: Bump `.tool-versions` to Node 20.22.2

## [1.0.21] - 2026-03-30

### Fixed

- package-lock.json sync

## [1.0.20] - 2026-03-30

### Changed

- **Dependencies**: Updated all dependencies to latest versions including `@homebridge/plugin-ui-utils` ^2.2.3, `undici` ^7.24.6, `eslint` ^10.1.0, `typescript` ^6.0.2, `vitest` ^4.1.2, and other dev dependencies.

## [1.0.19] - 2026-03-05

### Fixed

- **Config UI light mode**: Hardcoded `data-bs-theme="dark"` broke layout in light mode. Added early inline theme detection from `window.matchMedia` and confirmed via `homebridge.getUserSettings()` after ready.

## [1.0.18] - 2026-03-04

### Changed

- **Sources editor**: Replaced single scrollable list with a two-column layout — hidden sources on the left (click `+` to show), visible sources on the right (drag to reorder, click `×` to hide)
- **Sources editor**: Column headers use colored pill badges with a border separator instead of a plain alert block

## [1.0.17] - 2026-03-04

### Changed

- **Config UI**: Migrate to homebridge-ui-kit design system (Bootstrap 5.3 + Bootstrap Icons, shared kit.css/kit.js, `data-bs-theme="dark"` dark mode)
- **Config UI**: Hide header on edit and sources screens to reclaim vertical space
- Standardize `.gitignore` and `.npmignore`

## [1.0.16] - 2026-03-04

### Fixed

- **State sensor HAP warning**: Register `ConfiguredName` as optional characteristic on MotionSensor services before setting it, eliminating "Characteristic not in required or optional characteristic section" warnings

## [1.0.15] - 2026-03-03

### Changed

- **Wizard confirm screen layout**: 2-column layout matching the edit screen — connection settings on the left, HomeKit settings on the right

### Docs

- **API reference**: Added missing endpoints (`/audio`, `/storage`, `/timestamp`, `POST /ambilight/cached`, `/epg_source`, `/recordings`), documented simple vs expert ambilight configuration modes, added mute via `/input/key` note

## [1.0.14] - 2026-03-03

### Added

- **Configurable info button**: The HomeKit remote's information button can now be mapped to Source, Info, Options, or Find — configurable in the Homebridge UI (defaults to Source)

### Fixed

- **Mute button**: Mute now uses `sendKey('Mute')` instead of `POST /audio/volume`, matching how the TV actually handles mute toggling
- **Mute state sync**: Mute handler now updates local state after success, preventing poll from reverting the change
- **State sensor names**: Set `ConfiguredName` on MotionSensor services so HomeKit displays distinct names (e.g. "TV Power", "TV Ambilight", "TV Muted") instead of all showing "TV"

### Changed

- **Edit screen layout**: 2-column layout — connection settings on the left, HomeKit settings on the right

## [1.0.12] - 2026-03-02

### Fixed

- **Long-poll log spam**: Long-poll no longer retries endlessly when the TV is off — eliminated the repeating "Long-poll failed / Retrying long-poll mode" warnings that filled logs every 2–3 minutes
- **Long-poll lifecycle tied to power state**: Long-poll now starts only when the TV is on and stops immediately when it turns off, instead of blindly retrying regardless of power state
- **Long-poll race condition**: Fixed potential orphaned NotifyChangeClient when a retry timer races with a power-on detection, which could leak connections

### Changed

- **Startup optimization**: Long-poll is no longer attempted at startup when the TV is off — it starts automatically when the TV becomes reachable
- **Test coverage**: Added 7 new tests for long-poll lifecycle (20 total for StatePollManager, 130 total)

## [1.0.11] - 2026-02-28

### Added

- **Adaptive Lighting**: Ambilight lightbulb now supports HomeKit Adaptive Lighting — color temperature adjusts automatically throughout the day (cooler during daytime, warmer at night)
- **Color temperature control**: New color temperature slider (140–500 mireds) in HomeKit, with automatic hue/saturation sync
- **State sensors UI**: Toggle switches in the Homebridge custom UI to enable/disable power, ambilight, and mute state sensors
- **Shutdown cleanup**: Platform now listens for the Homebridge `shutdown` event and cleanly stops all poll timers and long-poll connections
- **Test coverage**: Added tests for InputSourceManager (15), StatePollManager (13), NotifyChangeClient (10), and expanded AmbilightService tests (18 total) — 123 tests total

### Changed

- **Shared digest auth**: Extracted `DigestAuthSession` class to deduplicate digest authentication logic between `PhilipsTVClient` and `NotifyChangeClient`
- **Differentiated timeouts**: GET requests use 2s timeout, POST requests use 5s timeout (ambilight changes and other writes need more time)
- **Async file persistence**: `InputSourceManager` now writes input configs to disk asynchronously to avoid blocking the event loop
- **Defensive color clamping**: Color conversion methods now clamp output values to valid ranges to prevent out-of-bounds values from reaching the TV API

### Fixed

- **Node version check**: Removed overly permissive `major >= 23` check to match `package.json` engines (`^20.18.0 || ^22.10.0`)
- **Stale accessory log level**: Downgraded "Removing stale cached accessory" from `info` to `debug` to reduce log noise on every restart
- **JSON parse safety**: Added try-catch around JSON parsing in both `PhilipsTVClient` and `NotifyChangeClient` to prevent crashes on malformed TV responses

## [1.0.10] - 2026-02-28

### Added

- **Configurable ambilight mode**: Choose which ambilight mode activates when turning on via HomeKit (Follow Video, Follow Audio, or Lounge Light) — configurable in both the standard schema and the custom Homebridge UI
- **Ambilight style drift recovery**: Background retries detect and re-apply the desired ambilight style if the TV overrides it after power on
- **Poll cooldown after user actions**: Suppresses poll updates for 10 seconds after user-initiated changes to prevent race conditions with stale TV state
- **Input config file persistence**: Input source configs (names, visibility, order) are now persisted to disk, surviving restarts for external accessories

### Fixed

- **Ambilight API format**: Use `menuSetting` instead of `algorithm`/`isExpert` when setting ambilight styles, matching the format the TV actually expects — fixes styles being silently ignored by the TV
- **Config save in custom UI**: `savePluginConfig()` is now called after `updatePluginConfig()` so settings are actually written to disk
- **Nodemon flag order**: Fixed `-P -I .` to `-I -P .` so the plugin path is parsed correctly during development

### Changed

- Removed fallback app list in favor of dynamic-only app discovery
- Debug report output moved to `tmp/` directory

## [1.0.9] - 2026-02-27

### Added

- **Long-poll support** (`NotifyChangeClient`): Connects to the TV's `/notifychange` endpoint for near-instant state change detection, with automatic fallback to interval polling
- **State sensors** (`StateSensorService`): Optional MotionSensor services for power, ambilight, and mute states — enables HomeKit automations triggered by TV state changes
- **Dynamic app discovery**: Automatically discovers all installed apps from the TV and adds them as input sources (up to 30 total), replacing the previous hard-coded app list
- **Source config support**: Applies visibility, order, and custom names from the Homebridge UI sources configuration
- **DisplayOrder TLV8 encoding**: Input sources are properly ordered in HomeKit using the TLV8 DisplayOrder characteristic
- Sample test config (`config.sample.json`) for development setup

### Changed

- **External accessory publishing**: TV accessories are now always published fresh as external accessories on each startup, fixing "Not Responding" issues caused by stale cached platform accessories
- **Quiet polling logs**: GET request/response debug logging removed from steady-state polling; only POST requests (user actions), errors, and actual state changes are logged
- **Change-detection logging**: StatePollManager now tracks previous values and only logs when power, volume, ambilight, or active app actually changes
- **Input source initialization**: `Active`, `ActiveIdentifier`, and `CurrentMediaState` characteristics are now set before handlers are registered, matching HAP best practices
- **Input source naming**: Uses `setCharacteristic()` to properly set ConfiguredName, fixing generic "Input Source #" names in HomeKit
- Increased max input sources from 15 to 30
- Input source names are sanitized for HomeKit compatibility
- Filters out system/launcher packages from auto-discovered apps

### Fixed

- Fixed "Not Responding" in HomeKit caused by cached platform accessories not being re-published as external accessories on restart
- Fixed input sources showing generic names ("Input Source", "Input Source 2") instead of real app/source names
- Fixed `CurrentVisibilityState.NOT_VISIBLE` TypeScript error — corrected to `HIDDEN`
- Fixed NotifyChange tight loop when TV pushes `activities/tv` every ~1 second — added minimum delay and filtered noise notifications

## [1.0.8] - 2026-02-27

### Added

- Unit test suite with 72 tests covering API utilities, TV client, and Ambilight color conversion
- Config validation for device entries (IP format, MAC format, required fields, polling interval range)
- Node.js version check at startup with warning for unsupported versions
- Vitest configuration and CI test step

### Changed

- **Digest auth caching**: Credentials are now sent proactively after the first 401 handshake, halving HTTP round-trips to the TV during steady-state polling
- Replaced `node-fetch` with native `fetch` via `undici` — fewer dependencies, same API
- Split 818-line `platformAccessory.ts` into focused modules: `AmbilightService`, `InputSourceManager`, `StatePollManager`
- Eliminated duplicated API code in `homebridge-ui/` — UI server now imports directly from `dist/api/`
- Simplified build script (removed file copy step)
- CI now uses `npm ci` with caching for faster, deterministic builds
- Removed unused `homebridge-lib` and `ts-node` dependencies

## [1.0.6] - 2026-02-27

### Added

- Debug logging for all API requests (method, endpoint, result, duration) visible in Homebridge debug mode (`-D`)

### Changed

- Reduced default API timeout from 5s to 2s to match pylips behavior — faster failure detection when TV is unreachable
- Enabled HTTP keep-alive on the HTTPS agent for connection reuse, matching pylips' session pooling behavior
- Merged v1.0.5 request serialization improvements

## [1.0.5] - 2026-02-27

### Fixed

- Serialized all API requests to the TV using a request queue to prevent overwhelming the JointSpace API server, which could crash under concurrent load ([#1](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/1))
- Added 100ms inter-request delay between consecutive API calls to give the TV time to process each request
- Delayed initial state polling by 5 seconds after accessory creation to let the TV API stabilize on startup
- Moved background app fetch after the first poll to avoid concurrent requests on startup

## [1.0.4] - 2026-02-27

### Fixed

- Fixed write handlers (`onSet`) for Active and On characteristics not responding within Homebridge's timeout window, causing "didn't respond at all!" warnings and slowing down the entire Homebridge instance ([#1](https://github.com/mp-consulting/homebridge-philips-ambilight-tv/issues/1))
- Reduced default API request timeout from 15s to 5s to fit within Homebridge's ~10s handler deadline
- Reduced Wake-on-LAN delay from 2s to 1s for faster power-on response
- All `onSet` handlers now properly catch errors and throw `HapStatusError(SERVICE_COMMUNICATION_FAILURE)` so HomeKit shows a clear "Not Responding" status instead of hanging indefinitely

## [1.0.3] - 2025-01-19

### Added

- **Ambilight color control**: Ambilight now appears as a color lightbulb in HomeKit with full HSB control
  - Brightness slider (0-100%)
  - Color wheel with hue and saturation
  - Real-time color sync from TV to HomeKit
- **New Ambilight API methods**:
  - `getAmbilightStyle()` - Get current Ambilight configuration
  - `setAmbilightStyle()` - Set style (OFF, FOLLOW_VIDEO, FOLLOW_AUDIO, FOLLOW_COLOR)
  - `setAmbilightFollowVideo()` - Follow Video mode with sub-styles (Standard, Natural, Game, etc.)
  - `setAmbilightFollowAudio()` - Follow Audio mode with algorithms (VU Meter, Spectrum, Party, etc.)
  - `setAmbilightFollowColor()` - Static color mode with custom HSB values
  - `setAmbilightLounge()` - Lounge light presets (Hot Lava, Deep Water, etc.)
  - `setAmbilightBrightness()` - Brightness control (0-10)
  - `setAmbilightSaturation()` - Saturation control (0-10)
  - `getAmbilightTopology()` - Get LED layout information
- **New Ambilight types**: Full TypeScript support for Ambilight styles, colors, and configurations

### Changed

- Ambilight service upgraded from simple on/off to full color lightbulb
- Refactored magic numbers to named constants for better maintainability
- Enhanced state polling to sync Ambilight color when in FOLLOW_COLOR mode

## [1.0.2] - 2024-12-23

### Fixed

- Fixed plugin name in settings.ts to match scoped package name (`@mp-consulting/homebridge-philips-ambilight-tv`)
- Updated dependencies to reduce security vulnerabilities

## [1.0.1] - 2024-12-23

### Fixed

- Fixed Homebridge timeout warnings ("read handler didn't respond at all") by returning cached state immediately from all `onGet` handlers instead of making synchronous API calls
- Enhanced state polling to also track mute state and current input/activity
- Added `isMuted` cached state property for faster mute status responses

## [1.0.0] - 2024-12-20

### Added

- Initial release
- Power ON/OFF control with Wake-on-LAN support
- Input source selection (HDMI ports, TV tuner, applications)
- Volume control and mute functionality
- Remote control support (D-Pad, Back, Menu, Play/Pause, Info)
- Ambilight power control
- Multi-TV support in a single platform
- Custom UI for Homebridge Config UI X:
  - TV discovery via mDNS (Bonjour)
  - Guided pairing wizard with PIN entry
  - Source editor with drag-and-drop reordering
  - Source visibility toggle
  - MAC address auto-detection
- JointSpace API v6 client for Philips Android TVs
- Digest authentication support
- Input source persistence across restarts
- Workaround for tvOS 18 HomeHub input source renaming bug
- Comprehensive error handling and logging

### Technical

- TypeScript codebase with ESM modules
- Separate API client library (`PhilipsTVClient`)
- Shared code between plugin and custom UI
- ESLint configuration with strict rules
- Test script for TV API endpoints
