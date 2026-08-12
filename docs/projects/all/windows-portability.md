---
status: Draft
---

# Plan: Windows portability — the checkout, the socket, and the last bits

**Goal:** field builds, checks, plays and **live-renders** on Windows, so
that the realtime engine — which has no platform-bound code in it at all —
stops being unreachable from the platform it happens not to be developed
on. Assessment written 2026-08-12 by reading `main` at `766e532`; no code
has been changed and nothing here is committed to.

This is scoped to the **core**: the CLI, the build graph, and the daemon
including live evaluation. The generative Python workers and SuperCollider
are deliberately out (§4), and Windows is currently written down as an
explicit V1 non-goal in [docs/README.md](../../README.md) "V1 platform
scope" — §3 says what that means for this plan.

The headline, because it is not what you would guess: **live rendering is
not the hard part.** `live.cpp`, `render.cpp`, `plan.cpp` and every file
in `dsp/` contain no platform branches whatsoever — `grep -n -E
'#include <(sys/|unistd|fcntl|signal)|JUCE_MAC|__APPLE__' ` over them
returns nothing. The daemon's hot-plug fallback already exists from
[linux-portability.md](linux-portability.md) decision 2, and JUCE gives
WASAPI for free. What stands between Windows and the live graph is the
**control socket**, and before that, the **checkout itself**.

## 1 Findings

Ordered by what blocks what, not by size. The first one blocks measuring
any of the others.

### 1.1 The checkout corrupts content hashes before any code runs

There is **no `.gitattributes` in this repository**. Git for Windows
defaults to `core.autocrlf=true` (it is set on the assessment machine),
so a fresh Windows clone rewrites every text file to CRLF on the way to
disk.

Measured, not assumed, on `examples/bloom/shared/instruments/creek-kit.scd`:

```text
on-disk size: 2323 bytes, CR bytes present: 71
sha256 on disk : 197c273b353c35ce3a7ecc00774f3aff9553b51daa33522efa7495fb2b496d46
sha256 as LF   : 49f970a7db30fc972b8ef060e55e3ae2991107137fbf9dd1a6ebb88e59dcea61
```

`git status` is **clean** throughout, because git compares normalized
content and so hides the difference completely. field does not: it hashes
what is on disk.

Three things break, all silently:

- **`sc-render`'s action key includes the program's content hash.** Every
  SuperCollider render on Windows keys differently from the same render on
  macOS, so the cache never shares across platforms — and
  [render-pipeline.md](render-pipeline.md) §4's byte-identical claim
  cannot even be *tested* cross-platform, because the inputs differ before
  the DSP is reached.
- **`field check`'s canonical formatting check is byte-wise.** A
  CRLF working tree is not canonical.
- **Asset pins are content hashes** of committed files
  (`assets.yaml`'s `sha256`), and the LFS OID is the same number.

The fix is one committed file and it must land first, because it is the
instrument every other measurement depends on. The shape is already
known-good: the **archived standalone sample-project repo carried exactly
this file** — `* text=auto eol=lf` with per-extension binary overrides for
`.wav/.aif/.aiff/.flac/.mp3/.m4a/.caf`, last-match-wins so audio is never
touched — and its comment already states this reasoning. The engine
repository has never had one, and when the sample project moved in-tree
([bloom-in-tree.md](bloom-in-tree.md)) the attributes did not come with
it. On the assessment machine that file survives, uncommitted, as the
staged diff on the pre-reset checkout (tag `archive/sample-project`).

This is not only a Windows concern, which is the argument for landing it
regardless of whether the rest of this plan is ever built: it makes the
checkout byte-defined on every platform rather than dependent on each
contributor's git configuration.

### 1.2 The control socket is the one real port

`native/audiod/src/server.cpp` is POSIX by hand and says so —
`server.h:15`: "JUCE's StreamingSocket is TCP-only, so the AF_UNIX
plumbing is POSIX by hand". Concretely it uses `<sys/un.h>` and
`sockaddr_un`, `<sys/socket.h>` (`socket`/`bind`/`listen`/`accept`/
`shutdown`), `<sys/file.h>` (`flock`), `<fcntl.h>`, `<unistd.h>`
(`read`/`close`/`unlink`), and raw `int` file descriptors throughout,
including in `Connection::fd`.

The client side is blocked symmetrically and for a different reason:
`src/audiod/client.ts:109` calls `createConnection(path)` with
`.field/audiod.sock`, and **Node implements the local domain on Windows as
named pipes only** — a path must live under `\\.\pipe\`. So neither end
works, and they cannot be fixed independently.

Everything the socket fronts is already portable. The `#if JUCE_MAC`
count in the daemon is six, in two files, all in `player.{h,cpp}`, and
`player.h:46`'s `hardwareListenersAvailable` is already `false` off-macOS
with the heartbeat rescan standing in — that is
[linux-portability.md](linux-portability.md) decision 2 working as
designed on a platform it was not written for.

Two candidate transports, and this is the plan's central decision (§2.1):

- **Named pipes.** `CreateNamedPipe`/`ConnectNamedPipe` with overlapped
  I/O; Node connects to `\\.\pipe\…` natively. The single-owner guarantee
  that `flock` provides today comes free from
  `FILE_FLAG_FIRST_PIPE_INSTANCE`, and pipes take ACLs, so the permission
  model matches the 0600 Unix socket. The cost is a genuinely different
  accept loop: HANDLEs rather than fds, no `accept()`, and no
  `shutdown(fd, SHUT_RD)` — which `Server::beginShutdown` depends on to
  drain readers without deadlocking against a `MessageManagerLock`
  (`server.h:33`, the fix from #12 review). That drain protocol needs a
  Windows spelling, probably `CancelIoEx`.
- **Loopback TCP with a port file.** JUCE's `StreamingSocket` is already
  in the daemon's dependency set and is TCP-only, which is the very
  reason the hand-rolled AF_UNIX code exists; Node connects to a port
  trivially. Far less code. The costs are real though: a loopback port is
  a standing surface any local process can connect to, where the Unix
  socket is mode 0600, and with no `flock` the single-owner guarantee
  needs its own port-file staleness story — which is precisely the race
  #12 review closed by choosing `flock` over a connect probe.

Either way the honest shape is a small `Transport` seam.
[linux-portability.md](linux-portability.md) decision 2 rejected exactly
that instinct — "fourteen lines do not earn an abstraction" — and was
right about fourteen lines of hot-plug. This is a different quantity:
roughly 150 lines of `server.cpp` plus the client, with three platforms'
semantics behind it. Reversing that instinct here should be recorded as a
decision with the earlier one cited, not done quietly.

### 1.3 SIGPIPE does not exist on Windows

`main.cpp:306` — `std::signal (SIGPIPE, SIG_IGN)`, under a 25-line comment
beginning "This is the whole mechanism, on every platform". It needs a
`#if !defined(_WIN32)` guard, and that comment then becomes false and has
to be amended rather than left to rot: it is load-bearing documentation of
a real cross-thread race in `Server::send` (the flag is read on one thread
and cleared on another), and it already records that the race is not
covered by a test because provoking it means winning a race by luck.

On Windows a write to a broken pipe returns an error rather than raising,
so the guarantee holds by a different mechanism — which is exactly what
the amended comment should say.

### 1.4 MSVC threatens the byte-identical render claim

`CMakeLists.txt` disables FMA contraction with `-ffp-contract=off`, gated
to `AppleClang`, `Clang` and `GNU`. MSVC is not in that list and has no
flag by that spelling; its default `/fp:precise` *permits* contraction,
and the control is `/fp:contract-` (MSVC 19.3x and later). Left alone, a
Windows build can differ from macOS and Linux in the last bits — which is
the one thing [render-pipeline.md](render-pipeline.md) §4 promises it will
not.

Two routes: add the MSVC flag, or build with `clang-cl` and reuse the flag
that already exists. This is the one finding in this document that must be
**measured rather than reasoned about**; the cross-platform byte
comparison from [render-pipeline.md](render-pipeline.md) chunk 6 is the
instrument, and it needs a Windows build to run against, exactly as it
needed a Linux one.

### 1.5 The daemon binary is resolved by a POSIX-shaped path

`src/audiod/client.ts:43` hardcodes
`native/audiod/build/field-audiod_artefacts/Release/field-audiod`. On
Windows the artefact is `field-audiod.exe`, and MSVC is a **multi-config
generator**, so `pnpm build:native`'s `-DCMAKE_BUILD_TYPE=Release` is
ignored at configure time — the configuration is chosen at build time with
`--config Release`. Both the suffix and the build script need fixing.

It is one fix rather than three: `src/audio/render-daemon.ts:6` and
`src/audio/plugins.ts` both resolve the binary through the same
`daemonBinary()`.

### 1.6 `afplay` has no Windows answer, and probably should not get one

`src/cli.ts:416` shells to `afplay`, described in its own comment as "the
retiring fallback for machines without the built daemon: playback through
afplay, no transport, no --from".

Since [realtime.md](realtime.md) shipped, `field play` *is* live
evaluation in the daemon. Inventing a PowerShell `SoundPlayer` path that
supports neither transport nor `--from` would add a second, worse
playback path to keep alive on the platform with the least coverage. The
likelier right answer is that Windows has **no fallback** and `field play`
fails with "build the daemon" — but that is a decision (§2.2), not a port.

### 1.7 Node 24 is a prerequisite, not a port

`.nvmrc` says `24` and `package.json` `engines` says `>=24`. The
assessment machine has **v20.20.2**, with no `nvm`, `fnm` or `volta`
installed. CMake 3.25.2 satisfies the `cmake_minimum_required(3.24)`, and
Visual Studio Community 2022 is present. `uv` and `sclang` are absent,
which only matters for §4.

## 2 Decisions to make

Recorded as open because this plan is `Draft`; the change that flips it to
`Active` is the one that answers them.

1. **Named pipes or loopback TCP** for the control socket (§1.2). The
   recommendation is **named pipes**: the single-owner guarantee and the
   permission model both come free, and a per-project daemon that lives
   for hours is the wrong place to open a standing local port. Loopback
   TCP is the cheap path if the goal is working-this-week, and the seam is
   the same either way, so this is reversible at the cost of one file.
2. **Whether `field play` keeps a non-daemon fallback on Windows** (§1.6).
   Recommendation: no fallback.
3. **Whether `socketPathFor` grows a platform branch.** `src/socketPath.ts`
   exists to keep the bound path inside `sun_path`'s 104 bytes by
   returning a cwd-relative path, and its comment records that it is one
   function because it was nearly three. Named pipes have no such limit
   and are not filesystem paths at all, so on Windows it would return a
   pipe name derived from the project root instead — the same function,
   answering a different question per platform.
4. **When [docs/README.md](../../README.md) "V1 platform scope" changes.**
   It currently lists Windows as explicitly out of scope alongside Linux,
   which Linux then shipped as a build-and-test target without becoming a
   supported product ([linux-portability.md](linux-portability.md)
   decision 5). The same framing is available here and is probably right:
   Windows as a build-and-test-and-play target, not a second product
   platform. Until that line moves, this plan stays `Draft`.

## 3 Definition of done

`pnpm typecheck`, `pnpm build` and `pnpm test` pass on Windows; the daemon
builds with MSVC and its protocol tests pass in null-output mode;
`cd examples/bloom && node ../../dist/cli.js check` passes on a fresh
Windows clone; `field play` live-renders a session through WASAPI with the
transport working from a second terminal; and a Windows render is
byte-identical to macOS and Linux for the built-in tier, or the gap is
measured and written down.

Not in scope for done: AU hosting, which cannot exist on Windows (§4);
and any claim that Windows is a supported product platform.

## 4 Explicitly out of scope

Recorded so the next reader does not re-derive it.

- **AU hosting is impossible on Windows.** Audio Units is an Apple format
  with no Windows implementation. The code already knows:
  `src/audio/plugins.ts:71` scans `['vst3']` off-Darwin, `CMakeLists.txt`
  guards `JUCE_PLUGINHOST_AU` behind `$<PLATFORM_ID:Darwin>` with a
  comment that defining it elsewhere is an error, and `hosting.cpp:33`
  guards the implementation. **VST3 hosting is unaffected** and the
  vendors ship VST3 on Windows. `examples/bloom` pins no plugins at all,
  so nothing in the repository hits this today; only a session whose YAML
  says `au: aufx/…` would, and it would need a `vst3:` pin.
- **The generative Python workers.**
  `python/worker/src/field_worker/server.py:129` binds `socket.AF_UNIX`.
  Whether CPython exposes `AF_UNIX` on Windows is **unverified here** and
  should be checked rather than assumed — historically it has not, though
  the OS has supported it since Windows 10 1803. It matters less than it
  looks: the client end is Node
  (`src/workers/client.ts` uses `createConnection`), so §1.2's named-pipe
  constraint applies to ACE and voice whatever CPython does, and they need
  the same transport decision, separately. Also
  `src/workers/client.ts` probes `.venv/bin/<script>` (Windows:
  `.venv/Scripts/<script>.exe`) and advises `brew install uv` when uv is
  missing. Encouragingly, `python/aced/uv.lock` already carries win32
  CUDA wheels, `triton-windows` and a Windows `flash-attn`, so somebody
  has been here before.
- **SuperCollider**, which is nearly free whenever it is wanted:
  `src/generators/supercollider.ts` tries `sclang` on PATH first and
  honours `FIELD_SCLANG`; only the `/Applications/SuperCollider.app/…`
  fallback is macOS-shaped, and it is a fallback. Note that `field build`
  on `examples/bloom` needs it, which is why CI runs `check` and not
  `build`.

## 5 Chunks

1. **`.gitattributes`** (§1.1). One committed file. Lands first because
   every later measurement depends on the checkout being byte-defined,
   and it is worth landing even if nothing else here is built.
2. **Build and paths** (§1.5, §1.3). MSVC compiles the daemon: the
   SIGPIPE guard, the `.exe` suffix, multi-config `--config Release` in
   `build:native`. Ends at a real milestone with no socket work at all —
   `field-audiod --render` and `--render-live` are invoked by
   `render-daemon.ts` as subprocesses, so **the whole offline render path
   works** once the binary exists.
3. **Determinism** (§1.4). Measure a Windows render against macOS and
   Linux; MSVC flags or `clang-cl` depending on what the measurement says.
   Gated behind chunk 2, and it is the chunk most likely to surprise.
4. **The transport** (§1.2). The seam, both ends, per §2.1. This is where
   `field play`, `field transport` and live rendering arrive, and it is
   the largest chunk by a wide margin.
5. **Fallback, CI, docs** (§1.6, §2.4). The `afplay` decision, a
   `windows-latest` job, and the "V1 platform scope" amendment.

Chunks 2 and 4 are independent of each other given chunk 1, so offline
rendering on Windows can be real long before playback is.

## 6 Open questions

- **Does the detached spawn survive?** `src/audiod/client.ts:130` spawns
  the daemon with `detached: true` and `stdio: ['ignore','ignore', log]`,
  then `unref()`s it. Windows has different semantics for detachment and
  process groups, and the daemon's idle-exit and ctrl-c handling both ride
  on it. Unverified.
- **Is the 104-byte reasoning simply gone, or replaced?** See §2.3. If
  named pipes win, `socketPathFor`'s entire premise is macOS/Linux-only,
  and the comment that explains it needs to say so.
- **What does WASAPI do to the device story?** `field devices` and
  `--device` are built on JUCE's `AudioDeviceManager`, which on Windows
  offers WASAPI (shared and exclusive) and DirectSound, plus ASIO only
  with a non-redistributable SDK. Whether device *names* round-trip
  through `device.select` the way they do on Core Audio is unverified,
  and the periodic rescan fallback has never been exercised against real
  Windows hot-plug.
- **Does anything else hash on-disk bytes?** §1.1 names three consumers
  found by reading; a systematic grep for content hashing against the
  working tree would be cheap insurance before trusting chunk 1.
