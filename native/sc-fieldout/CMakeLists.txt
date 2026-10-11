# FieldOut, the scsynth UGen that writes the voice host's output into
# field-audiod's ring (live-supercollider.md chunk 2). GPL-3.0-or-later,
# like the SuperCollider plugin interface it builds against (LICENSE);
# the rest of Field is MIT.
cmake_minimum_required(VERSION 3.22)
project(sc-fieldout LANGUAGES CXX)

if(WIN32)
  # The ring is POSIX shared memory; Windows needs a file mapping first.
  message(STATUS "FieldOut is not built on Windows yet")
  return()
endif()

add_library(FieldOut MODULE FieldOut.cpp)
target_compile_features(FieldOut PRIVATE cxx_std_17)
target_include_directories(FieldOut PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/vendor/supercollider/include/plugin_interface
  ${CMAKE_CURRENT_SOURCE_DIR}/vendor/supercollider/include/common
  ${CMAKE_CURRENT_SOURCE_DIR}/../ring)
# scsynth looks for FieldOut.scx on macOS and FieldOut.so elsewhere, in
# whatever directory its plugin path names: the build directory itself.
set_target_properties(FieldOut PROPERTIES
  PREFIX ""
  LIBRARY_OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/plugins
  LIBRARY_OUTPUT_DIRECTORY_RELEASE ${CMAKE_CURRENT_BINARY_DIR}/plugins)
if(APPLE)
  set_target_properties(FieldOut PROPERTIES SUFFIX ".scx")
else()
  target_link_libraries(FieldOut PRIVATE rt)
endif()
