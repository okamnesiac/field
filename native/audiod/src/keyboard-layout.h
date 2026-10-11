// The active keyboard layout, for `field keys` (keyboard-instrument.md
// §2.3): what each bindable position types, and which positions are dead
// keys. Read on macOS through the Text Input Sources API; elsewhere there
// is nothing to report and nothing to watch.
#pragma once

#include <functional>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace field
{
struct KeyboardLayout
{
    std::string name;
    // Position, as a KeyboardEvent.code, to the UTF-8 text it types with
    // no modifiers.
    std::vector<std::pair<std::string, std::string>> keys;
    std::vector<std::string> dead;
};

// Call on the main thread: macOS traps a Text Input Sources call made
// from any other.
std::optional<KeyboardLayout> readKeyboardLayout();

// Calls onChange whenever the selected keyboard input source changes, for
// as long as the watcher lives. Construct it on the main thread and run
// that thread's run loop, which is where the change is delivered.
class KeyboardLayoutWatcher
{
public:
    explicit KeyboardLayoutWatcher (std::function<void()> onChange);
    ~KeyboardLayoutWatcher();

    KeyboardLayoutWatcher (const KeyboardLayoutWatcher&) = delete;
    KeyboardLayoutWatcher& operator= (const KeyboardLayoutWatcher&) = delete;

private:
    [[maybe_unused]] std::function<void()> onChange;
};
} // namespace field
