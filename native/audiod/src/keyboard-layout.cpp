#include "keyboard-layout.h"

#if defined(__APPLE__)
#include <Carbon/Carbon.h>

#include <iterator>
#include <memory>
#include <type_traits>
#endif

namespace field
{
#if defined(__APPLE__)
namespace
{
struct Position
{
    const char* code;
    UInt16 keyCode;
};

// Every position a keymap can bind, by the macOS key code at that place
// on the keyboard. A key code names a position on every layout.
constexpr Position bindablePositions[] = {
    { "Backquote", kVK_ANSI_Grave },
    { "Digit1", kVK_ANSI_1 },
    { "Digit2", kVK_ANSI_2 },
    { "Digit3", kVK_ANSI_3 },
    { "Digit4", kVK_ANSI_4 },
    { "Digit5", kVK_ANSI_5 },
    { "Digit6", kVK_ANSI_6 },
    { "Digit7", kVK_ANSI_7 },
    { "Digit8", kVK_ANSI_8 },
    { "Digit9", kVK_ANSI_9 },
    { "Digit0", kVK_ANSI_0 },
    { "Minus", kVK_ANSI_Minus },
    { "Equal", kVK_ANSI_Equal },
    { "KeyQ", kVK_ANSI_Q },
    { "KeyW", kVK_ANSI_W },
    { "KeyE", kVK_ANSI_E },
    { "KeyR", kVK_ANSI_R },
    { "KeyT", kVK_ANSI_T },
    { "KeyY", kVK_ANSI_Y },
    { "KeyU", kVK_ANSI_U },
    { "KeyI", kVK_ANSI_I },
    { "KeyO", kVK_ANSI_O },
    { "KeyP", kVK_ANSI_P },
    { "BracketLeft", kVK_ANSI_LeftBracket },
    { "BracketRight", kVK_ANSI_RightBracket },
    { "Backslash", kVK_ANSI_Backslash },
    { "KeyA", kVK_ANSI_A },
    { "KeyS", kVK_ANSI_S },
    { "KeyD", kVK_ANSI_D },
    { "KeyF", kVK_ANSI_F },
    { "KeyG", kVK_ANSI_G },
    { "KeyH", kVK_ANSI_H },
    { "KeyJ", kVK_ANSI_J },
    { "KeyK", kVK_ANSI_K },
    { "KeyL", kVK_ANSI_L },
    { "Semicolon", kVK_ANSI_Semicolon },
    { "Quote", kVK_ANSI_Quote },
    { "KeyZ", kVK_ANSI_Z },
    { "KeyX", kVK_ANSI_X },
    { "KeyC", kVK_ANSI_C },
    { "KeyV", kVK_ANSI_V },
    { "KeyB", kVK_ANSI_B },
    { "KeyN", kVK_ANSI_N },
    { "KeyM", kVK_ANSI_M },
    { "Comma", kVK_ANSI_Comma },
    { "Period", kVK_ANSI_Period },
    { "Slash", kVK_ANSI_Slash },
    { "IntlBackslash", kVK_ISO_Section },
};

struct CFReleaser
{
    void operator() (CFTypeRef ref) const { CFRelease (ref); }
};

template <typename Ref>
using CFOwned = std::unique_ptr<std::remove_pointer_t<Ref>, CFReleaser>;

std::string toUtf8 (CFStringRef text)
{
    const auto range = CFRangeMake (0, CFStringGetLength (text));
    CFIndex size = 0;
    CFStringGetBytes (text, range, kCFStringEncodingUTF8, 0, false, nullptr, 0, &size);
    std::string utf8 ((size_t) size, '\0');
    CFStringGetBytes (text, range, kCFStringEncodingUTF8, 0, false,
                      reinterpret_cast<UInt8*> (utf8.data()), size, nullptr);
    return utf8;
}

std::string toUtf8 (const UniChar* characters, UniCharCount length)
{
    const CFOwned<CFStringRef> text { CFStringCreateWithCharacters (kCFAllocatorDefault,
                                                                    characters,
                                                                    (CFIndex) length) };
    return text != nullptr ? toUtf8 (text.get()) : std::string();
}

void selectedInputSourceChanged (CFNotificationCenterRef,
                                 void* observer,
                                 CFNotificationName,
                                 const void*,
                                 CFDictionaryRef)
{
    (*static_cast<std::function<void()>*> (observer))();
}
} // namespace

std::optional<KeyboardLayout> readKeyboardLayout()
{
    const CFOwned<TISInputSourceRef> source { TISCopyCurrentKeyboardLayoutInputSource() };
    if (source == nullptr)
        return std::nullopt;

    const auto layoutData = static_cast<CFDataRef> (
        TISGetInputSourceProperty (source.get(), kTISPropertyUnicodeKeyLayoutData));
    if (layoutData == nullptr)
        return std::nullopt;
    const auto* unicodeLayout = reinterpret_cast<const UCKeyboardLayout*> (CFDataGetBytePtr (layoutData));

    KeyboardLayout layout;
    if (const auto name = static_cast<CFStringRef> (
            TISGetInputSourceProperty (source.get(), kTISPropertyLocalizedName)))
        layout.name = toUtf8 (name);

    const auto keyboardType = LMGetKbdType();
    for (const auto& position : bindablePositions)
    {
        UInt32 deadKeyState = 0;
        UniChar typed[8];
        UniCharCount length = 0;
        if (UCKeyTranslate (unicodeLayout, position.keyCode, kUCKeyActionDown, 0, keyboardType,
                            0, &deadKeyState, std::size (typed), &length, typed)
            != noErr)
            continue;

        if (deadKeyState != 0 && length == 0)
            layout.dead.emplace_back (position.code);
        else
            layout.keys.emplace_back (position.code, toUtf8 (typed, length));
    }
    return layout;
}

KeyboardLayoutWatcher::KeyboardLayoutWatcher (std::function<void()> callback)
    : onChange (std::move (callback))
{
    // NSApplication holds distributed notifications back while its process
    // is inactive, and a console process never becomes active.
    CFNotificationCenterAddObserver (CFNotificationCenterGetDistributedCenter(),
                                     &onChange,
                                     selectedInputSourceChanged,
                                     kTISNotifySelectedKeyboardInputSourceChanged,
                                     nullptr,
                                     CFNotificationSuspensionBehaviorDeliverImmediately);
}

KeyboardLayoutWatcher::~KeyboardLayoutWatcher()
{
    CFNotificationCenterRemoveObserver (CFNotificationCenterGetDistributedCenter(),
                                        &onChange,
                                        kTISNotifySelectedKeyboardInputSourceChanged,
                                        nullptr);
}
#else
std::optional<KeyboardLayout> readKeyboardLayout()
{
    return std::nullopt;
}

KeyboardLayoutWatcher::KeyboardLayoutWatcher (std::function<void()> callback)
    : onChange (std::move (callback))
{
}

KeyboardLayoutWatcher::~KeyboardLayoutWatcher() = default;
#endif
} // namespace field
