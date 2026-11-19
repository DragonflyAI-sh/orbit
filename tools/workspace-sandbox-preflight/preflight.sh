#!/bin/sh
# Read-only environment inventory for the workspace real-sandbox suite (docs/reviews/workspace-tools-security-review.md, "Runbook").
#
# It changes nothing: no installs, no mounts, no cgroup writes, no user changes. It prints non-sensitive facts only (numeric uid,
# kernel release, distribution id, tool versions, cgroup layout, controller lists, namespace sysctls) and never prints hostnames,
# addresses, environment values, credentials or the kernel command line.
#
# Usage: ORBIT_SANDBOX_TEST_CGROUP=<dir> sh tools/workspace-sandbox-preflight/preflight.sh
# Exit status: 0 when every requirement of test/workspace-sandbox.test.ts is met, 1 otherwise (each unmet one is listed).

unmet=0
say() { printf '%s\n' "$*"; }
need() { unmet=$((unmet + 1)); say "UNMET: $*"; }

uid=$(id -u)
say "uid=$uid"
[ "$uid" = 0 ] && need "running as root (the sandbox never runs as root; use an unprivileged user)"
say "kernel=$(uname -r)"
[ -r /etc/os-release ] && say "os=$(. /etc/os-release && printf '%s %s' "$ID" "$VERSION_ID")"
say "node=$(node --version 2>/dev/null || echo absent)"
command -v systemd-detect-virt >/dev/null 2>&1 && say "virt=$(systemd-detect-virt 2>/dev/null || true)"

# Unprivileged user namespaces (read-only sysctls; absent files are reported as such).
for f in /proc/sys/user/max_user_namespaces /proc/sys/kernel/unprivileged_userns_clone /proc/sys/kernel/apparmor_restrict_unprivileged_userns; do
  if [ -r "$f" ]; then say "$(basename "$f")=$(cat "$f")"; else say "$(basename "$f")=absent"; fi
done
[ -r /proc/sys/user/max_user_namespaces ] && [ "$(cat /proc/sys/user/max_user_namespaces)" = 0 ] && need "user namespaces are disabled (user.max_user_namespaces=0)"
[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1 ] && say "NOTE: AppArmor restricts unprivileged user namespaces; bubblewrap needs a profile that allows them"

# bubblewrap and prlimit.
if [ -x /usr/bin/bwrap ]; then
  say "bwrap=$(/usr/bin/bwrap --version 2>/dev/null)"
  # shellcheck disable=SC2012
  say "bwrap_mode=$(ls -l /usr/bin/bwrap | cut -c1-10) bwrap_owner_uid=$(stat -c %u /usr/bin/bwrap)"
  [ -u /usr/bin/bwrap ] && need "/usr/bin/bwrap is setuid (the sandbox requires a non-setuid bubblewrap)"
  help=$(/usr/bin/bwrap --help 2>&1)
  for flag in --unshare-user --unshare-pid --unshare-net --unshare-ipc --unshare-uts --unshare-cgroup-try --disable-userns --die-with-parent --new-session --clearenv --cap-drop --remount-ro --size --perms --uid --gid --ro-bind --symlink --tmpfs --proc --dev --chdir --hostname; do
    printf '%s\n' "$help" | grep -Eq -- "(^|[[:space:]])$flag([[:space:]]|=|\$)" || need "bubblewrap lacks $flag"
  done
else
  need "bubblewrap (/usr/bin/bwrap) is not installed"
fi
if [ -x /usr/bin/prlimit ]; then say "prlimit=$(/usr/bin/prlimit --version 2>/dev/null | head -n 1)"; else need "prlimit (/usr/bin/prlimit) is not installed"; fi
command -v python3 >/dev/null 2>&1 && say "python3=present (used by the network checks)" || say "python3=absent (network socket checks print no_python)"

# cgroup layout.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  say "cgroup_layout=unified (v2)"
  say "root_controllers=$(cat /sys/fs/cgroup/cgroup.controllers)"
elif [ -d /sys/fs/cgroup/unified ]; then
  say "cgroup_layout=hybrid (v1 controllers; v2 at /sys/fs/cgroup/unified)"
  say "unified_controllers=$(cat /sys/fs/cgroup/unified/cgroup.controllers 2>/dev/null)"
  need "cgroup v2 is not the unified hierarchy: memory, pids and cpu are bound to v1 and cannot be delegated as v2"
else
  say "cgroup_layout=v1 only"
  need "no cgroup v2 hierarchy"
fi
say "own_cgroup=$(grep '^0::' /proc/self/cgroup 2>/dev/null | cut -d: -f3)"

cg=${ORBIT_SANDBOX_TEST_CGROUP:-}
if [ -z "$cg" ]; then
  need "ORBIT_SANDBOX_TEST_CGROUP is not set (a delegated cgroup v2 directory this user owns)"
elif [ ! -d "$cg" ]; then
  need "ORBIT_SANDBOX_TEST_CGROUP does not exist"
else
  say "test_cgroup_controllers=$(cat "$cg/cgroup.controllers" 2>/dev/null)"
  say "test_cgroup_subtree_control=$(cat "$cg/cgroup.subtree_control" 2>/dev/null)"
  say "test_cgroup_owner_uid=$(stat -c %u "$cg")"
  for c in memory pids cpu; do
    grep -qw "$c" "$cg/cgroup.subtree_control" 2>/dev/null || need "the test cgroup does not enable $c in cgroup.subtree_control"
  done
  [ -w "$cg" ] || need "the test cgroup is not writable by uid $uid"
  [ -w "$cg/cgroup.procs" ] || need "the test cgroup's cgroup.procs is not writable by uid $uid"
fi

if [ "$unmet" -eq 0 ]; then say "RESULT: all requirements met; run: ORBIT_SANDBOX_TEST_REQUIRED=1 ORBIT_SANDBOX_TEST_CGROUP=$cg node --test test/workspace-sandbox.test.ts"; exit 0; fi
say "RESULT: $unmet requirement(s) unmet; the real-sandbox suite cannot provide OS-isolation evidence here"
exit 1
