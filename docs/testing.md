# Testing

Three layers, in increasing order of cost and decreasing order of frequency.

## Unit

```console
bun test
```

No FFI, no compositor, no session. Covers option parsing, the named-key and chord tables,
unicode↔keysym, the XKB keymap parser, and the rendered text of every error.

The keymap parser is tested against `test/fixtures/us.xkb`, a real
`XKB_KEYMAP_FORMAT_TEXT_V1` keymap captured from a live session, plus small hand-written
fragments for the awkward cases the capture does not contain — group assignments,
`override`, `NoSymbol` placeholders, and keys whose symbols live on a level no named
modifier can reach.

## Live harness

```console
OC_COMPUTERUSE_LIVE=1 bun run test/live.ts
```

Drives the real backend against the real compositor. It opens a remote-control session, so
it needs Plasma on Wayland and a human to approve the consent dialog once.

By default it only reports geometry, bounds handling and scrolling. The steps that change
things — clicking, dragging, typing, keys and chords — are behind a second flag, because
they land wherever the pointer is:

```console
OC_COMPUTERUSE_LIVE=1 OC_COMPUTERUSE_LIVE_WRITE=1 OC_COMPUTERUSE_LIVE_AT=400,300 \
  bun run test/live.ts
```

This is the fastest loop for backend changes: no model, no screenshots to interpret.

## End to end

```console
opencode run --standalone --auto --format json "<prompt>" > run.json
```

The real thing: a child OpenCode with the plugin loaded, driving the desktop from a
screenshot. Pair it with the screenshot plugin and give it a page with a grid of labelled
targets, so the click is checkable rather than a matter of opinion.

`--standalone` matters. Without it the run joins the background service, which may still
hold a remote-control session from an earlier run, and then no consent dialog appears and
the run proves much less.

The transcript is JSON Lines: one object per event, with `part.type` of `tool` or `text`.
Tool records carry the input, the output and the elapsed time, which is enough to assert on
a whole run without scraping the model's prose.

## Checking a change a screenshot cannot show

A picture of a scrolled page is ambiguous — which is how an inverted scroll sign survived
review and looked like "scrolling does nothing" rather than "scrolling is backwards".

So have the page under test print the thing being measured, and read it back out of a
screenshot:

```js
addEventListener("scroll", () => { readout.textContent = `scrollY = ${Math.round(scrollY)}` }, { passive: true })
addEventListener("wheel", (e) => { wheel.textContent = `wheel ${e.deltaY}:${e.deltaMode}` }, { passive: true })
```

A text field with an `input` listener that mirrors its value does the same job for typing.
