# bloom-audiod — the playback daemon (playback.md §3.7). Build via
# `pnpm build:native`; this file is write-once plumbing and the pinned JUCE
# tag is the only thing expected to change. JUCE is AGPL — quarantined in
# this daemon by design (architecture.md).
cmake_minimum_required(VERSION 3.24)
project(bloom-audiod VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
FetchContent_Declare(
  JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG 8.0.4
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(JUCE)

juce_add_console_app(bloom-audiod PRODUCT_NAME "bloom-audiod")

target_sources(bloom-audiod PRIVATE
  src/main.cpp
  src/player.cpp
  src/server.cpp
)

target_compile_definitions(bloom-audiod PRIVATE
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  # The daemon's main loop is runDispatchLoopUntil (no NSApplication in a
  # console process), which JUCE gates behind this flag.
  JUCE_MODAL_LOOPS_PERMITTED=1
)

target_link_libraries(bloom-audiod PRIVATE
  juce::juce_audio_devices
  juce::juce_audio_formats
  juce::juce_recommended_config_flags
  juce::juce_recommended_warning_flags
)
