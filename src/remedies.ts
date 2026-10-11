// The commands that bring part of an install up to date, for every message
// that needs to name one. Those messages fire inside a song project, where
// the checkout's pnpm scripts are not scripts, and `field upgrade <target>`
// works from any directory (install.md §2.5). It runs install.sh, which is
// bash, so Windows names the script to run in the checkout instead
// (install.md §7.6).
function upgrade(target: 'cli' | 'audiod', windows: string): string {
  return process.platform === 'win32' ? `${windows} in the field checkout` : `field upgrade ${target}`;
}

export const BUILD_CLI = upgrade('cli', 'pnpm build');
export const BUILD_UI = upgrade('cli', 'pnpm build:ui');
// The root install installs the ui/ workspace member, electron included.
export const INSTALL_UI = upgrade('cli', 'pnpm install');
export const BUILD_DAEMON = upgrade('audiod', 'pnpm build:native');
