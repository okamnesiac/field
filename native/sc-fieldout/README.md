# FieldOut

FieldOut is a SuperCollider server plugin, a UGen, that writes its two
audio inputs into a shared-memory ring that `field-audiod` reads. It is
how the voice `field keys` plays reaches the daemon's live session, so
the effects on a track and the tracks above it process what you play
([live-supercollider.md](../../docs/projects/live-supercollider/readme.md)).

```supercollider
FieldOut.ar(ring, left, right)
```

`ring` is the number the daemon's `input` op answers. FieldOut has no
outputs. When the ring does not exist, or its layout is not the one
this build reads, FieldOut says why once on the server's console and
writes nothing. Free a FieldOut synth before the server quits: at
shutdown scsynth unloads its plugins before it frees the synths still
running, and a FieldOut left running would call a destructor that is
gone.

## Build

`pnpm build:native` builds it into `native/sc-fieldout/build/plugins/`,
as `FieldOut.scx` on macOS and `FieldOut.so` on Linux. Point scsynth's
plugin path at that directory beside its own plugins, for example
`scsynth -U <its plugins>:<this build>/plugins`. FieldOut is not built
on Windows yet, because the ring is POSIX shared memory.

## License

FieldOut is GPL-3.0-or-later ([LICENSE](LICENSE)), because it builds
against SuperCollider's plugin interface, which is. Those headers are
vendored from SuperCollider `Version-3.14.1` under
`vendor/supercollider/`. The rest of Field is MIT. FieldOut shares only
the ring's layout with it, `native/ring/field_ring.h`, which is MIT, and
nothing links across that line.
