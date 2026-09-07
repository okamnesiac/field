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
  src/live.cpp
  src/hosting.cpp
  src/capture.cpp
  src/dsp/biquad.cpp
  src/dsp/limiter.cpp
  src/dsp/hall.cpp
  src/dsp/mixdown.cpp
  src/dsp/plate.cpp
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
  # Hosting (plugin-hosting.md chunk 1). VST3 everywhere; AU exists only
  # on Apple platforms, and defining its host flag elsewhere is an error.
  JUCE_PLUGINHOST_VST3=1
  $<$<PLATFORM_ID:Darwin>:JUCE_PLUGINHOST_AU=1>
)

# AU hosting references AUGenericView (CoreAudioKit), which JUCE's module
# metadata does not link for a console target.
if(APPLE)
  target_link_libraries(field-audiod PRIVATE "-framework CoreAudioKit")
endif()

target_link_libraries(field-audiod PRIVATE
  juce::juce_audio_processors
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
  src/dsp/hall.cpp
  src/dsp/limiter.cpp
  src/dsp/plate.cpp
  src/dsp/resample.cpp
  src/dsp/reverb.cpp
)
target_compile_options(field-dsp-check PRIVATE
  $<$<OR:$<CXX_COMPILER_ID:AppleClang>,$<CXX_COMPILER_ID:Clang>,$<CXX_COMPILER_ID:GNU>>:-ffp-contract=off>
)

# The fixture plugin (plugin-hosting.md decision 12): the plugin the CI
# suite owns, so hosting is testable without a commercial plugin
# installed. It lives in this CMake project because JUCE is already
# fetched here and the daemon is the only thing that hosts it; the
# source says what it fixes. AU builds only on Apple.
if(APPLE)
  set(FIELD_FIXTURE_FORMATS AU VST3)
else()
  set(FIELD_FIXTURE_FORMATS VST3)
endif()
juce_add_plugin(field-fixture
  VERSION 1.0.0
  PRODUCT_NAME "Field Fixture"
  COMPANY_NAME "Field"
  BUNDLE_ID io.amnesiac.field-fixture
  PLUGIN_MANUFACTURER_CODE Fldf
  PLUGIN_CODE Ffx1
  FORMATS ${FIELD_FIXTURE_FORMATS}
  AU_MAIN_TYPE kAudioUnitType_Effect
  IS_SYNTH FALSE
  NEEDS_MIDI_INPUT FALSE
  NEEDS_MIDI_OUTPUT FALSE
  COPY_PLUGIN_AFTER_BUILD FALSE
)
target_sources(field-fixture PRIVATE src/fixture/fixture.cpp)
target_compile_definitions(field-fixture PUBLIC
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_VST3_CAN_REPLACE_VST2=0
)
target_compile_options(field-fixture PRIVATE
  $<$<OR:$<CXX_COMPILER_ID:AppleClang>,$<CXX_COMPILER_ID:Clang>,$<CXX_COMPILER_ID:GNU>>:-ffp-contract=off>
)
target_link_libraries(field-fixture
  PRIVATE juce::juce_audio_utils
  PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags
)
