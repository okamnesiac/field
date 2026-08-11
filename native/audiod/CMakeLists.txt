# field-audiod — the playback daemon (playback.md §3.7). Build via
# `pnpm build:native`; this file is write-once plumbing and the pinned JUCE
# tag is the only thing expected to change. JUCE is AGPL — quarantined in
# this daemon by design (architecture.md).
cmake_minimum_required(VERSION 3.24)
project(field-audiod VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# So clangd sees the real flags rather than guessing an older standard.
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

include(FetchContent)
FetchContent_Declare(
  JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG 8.0.4
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(JUCE)

juce_add_console_app(field-audiod PRODUCT_NAME "field-audiod")

target_sources(field-audiod PRIVATE
  src/main.cpp
  src/player.cpp
  src/server.cpp
  src/render.cpp
  src/plan.cpp
  src/dsp/biquad.cpp
  src/dsp/limiter.cpp
  src/dsp/mixdown.cpp
  src/dsp/resample.cpp
  src/dsp/reverb.cpp
  src/dsp/wavfile.cpp
)

# Deterministic arithmetic for the built-in tier (render-pipeline.md §4
# and chunk 6). JUCE already builds with -O3 and no -ffast-math, so basic
# arithmetic is IEEE; what remains is FMA contraction, which lets a
# compiler fuse a*b+c into one rounding and so varies by compiler and
# target. Turning it off is what makes "same input, same bytes" a claim
# about our arithmetic rather than about our toolchain.
target_compile_options(field-audiod PRIVATE
  $<$<OR:$<CXX_COMPILER_ID:AppleClang>,$<CXX_COMPILER_ID:Clang>,$<CXX_COMPILER_ID:GNU>>:-ffp-contract=off>
)

target_compile_definitions(field-audiod PRIVATE
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  # The daemon's main loop is runDispatchLoopUntil (no NSApplication in a
  # console process), which JUCE gates behind this flag.
  JUCE_MODAL_LOOPS_PERMITTED=1
)

target_link_libraries(field-audiod PRIVATE
  juce::juce_audio_devices
  juce::juce_audio_formats
  juce::juce_recommended_config_flags
  juce::juce_recommended_warning_flags
)

# Block-size invariance for the streaming DSP classes (realtime.md
# decision 3). Pure C++ over src/dsp — no JUCE — so it builds in moments
# and runs in CI wherever the daemon does; src/audio/dsp-check.test.ts is
# the caller.
add_executable(field-dsp-check
  src/dsp-check.cpp
  src/dsp/biquad.cpp
  src/dsp/limiter.cpp
  src/dsp/resample.cpp
  src/dsp/reverb.cpp
)
target_compile_options(field-dsp-check PRIVATE
  $<$<OR:$<CXX_COMPILER_ID:AppleClang>,$<CXX_COMPILER_ID:Clang>,$<CXX_COMPILER_ID:GNU>>:-ffp-contract=off>
)
