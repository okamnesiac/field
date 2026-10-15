# The macOS SDK a native build compiles against: the one that ships with
# the toolchain xcode-select names, whose compiler and linker read it.
# Included before project(), which reads CMAKE_OSX_SYSROOT.
#
# Asked for no SDK in particular, `xcrun --show-sdk-path` can answer with
# the Command Line Tools' SDK while the compiler and linker are an
# installed Xcode's. After a macOS update the Command Line Tools' SDK can
# be newer than that Xcode's linker reads: macOS 27's lists arm64e.x1,
# which Xcode 26.6's ld rejects, and CMake's first compiler check fails
# (install.md §10.1). `xcrun --sdk macosx` answers within the selected
# developer directory instead.
#
# SDKROOT, or a CMAKE_OSX_SYSROOT someone set, wins. The SDK is asked for
# again at every configure, so an existing build directory follows a
# later Xcode update or xcode-select switch; FIELD_OSX_SYSROOT remembers
# which value was this file's to replace.
#
# The SDK goes into SDKROOT too, for the processes configure starts:
# JUCE configures and builds juceaide in a CMake of its own, which is
# given no CMAKE_OSX_SYSROOT and would ask xcrun again.
if(CMAKE_HOST_APPLE AND NOT DEFINED ENV{SDKROOT})
  if(NOT CMAKE_OSX_SYSROOT OR CMAKE_OSX_SYSROOT STREQUAL "${FIELD_OSX_SYSROOT}")
    execute_process(
      COMMAND xcrun --sdk macosx --show-sdk-path
      OUTPUT_VARIABLE field_sdk
      OUTPUT_STRIP_TRAILING_WHITESPACE
      ERROR_QUIET
      RESULT_VARIABLE field_sdk_status)
    if(field_sdk_status EQUAL 0 AND IS_DIRECTORY "${field_sdk}")
      set(CMAKE_OSX_SYSROOT "${field_sdk}" CACHE PATH "The macOS SDK of the toolchain xcode-select names" FORCE)
      set(FIELD_OSX_SYSROOT "${field_sdk}" CACHE INTERNAL "")
    endif()
  endif()
  if(CMAKE_OSX_SYSROOT)
    set(ENV{SDKROOT} "${CMAKE_OSX_SYSROOT}")
  endif()
endif()
